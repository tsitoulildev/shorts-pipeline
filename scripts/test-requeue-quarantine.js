// Re-entry of quarantined stories: tiers, order, attempts = 1 (behind untouched stories), dry run writes nothing, only quarantined stories move.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Database } = require('../database/db');
const { StoryPool } = require('../utils/dark-history/story-pool');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'requeue-'));
  const db = new Database();
  db.dbPath = path.join(dir, 'test.db');
  await db.initialize();
  const pool = new StoryPool(db);
  const add = async (title, status, richness, reason, attempts = 2) => {
    const id = await pool.add({ title, status, plan: { title, extract: 'x', beats: [], richness }, attribution: 'x', reason });
    await db.executeQuery('UPDATE story_pool SET attempts = ?, reason = ? WHERE title = ?', [attempts, reason, title]);
    return id;
  };
  const factCheck = 'CREATIVE_REVIEW_REJECTED: Creative review rejected the script after 4 attempt(s): fact-check failed [#1 0/10';
  await add('Writer error low', 'quarantine', 10, 'error: writer returned no title/beats');
  await add('Writer error high', 'quarantine', 70, 'error: writer returned no title/beats');
  await add('Facts rich', 'quarantine', 80, factCheck);
  await add('Facts richer', 'quarantine', 90, factCheck);
  await add('Facts poor', 'quarantine', 20, factCheck);
  await add('Picture fit', 'quarantine', 90, 'IMAGE_HELD_TOO_LONG: beat 3 keeps one picture on screen for 11.9 s');
  await add('Duplicate', 'quarantine', 90, 'Quality gates rejected the Short: duplicate_premise');
  await add('Not quarantined', 'rejected', 90, 'production failed 3 times, fact-check failed');
  await add('Untouched', 'ready', 5, null, 0);

  const dry = await pool.requeueQuarantined({ apply: false, now: new Date('2026-10-27T10:00:00Z') });
  assert.deepEqual(dry.tierA.map(r => r.title).sort(), ['Writer error high', 'Writer error low']);
  assert.deepEqual(dry.tierB.map(r => r.title), ['Facts richer', 'Facts rich'], 'fact-check failures with richness >= 50, richest first');
  assert.equal(dry.stays, 3, 'poor facts, picture fit and duplicate stay parked');
  assert.equal((await db.getRow("SELECT COUNT(*) AS n FROM story_pool WHERE status = 'quarantine'")).n, 7, 'a dry run writes nothing');

  const done = await pool.requeueQuarantined({ apply: true, now: new Date('2026-10-27T10:00:00Z') });
  assert.equal(done.applied, true);
  const rows = await db.getAllRows("SELECT title, status, attempts, reason FROM story_pool ORDER BY title");
  const by = Object.fromEntries(rows.map(r => [r.title, r]));
  for (const title of ['Writer error low', 'Writer error high', 'Facts rich', 'Facts richer']) assert.deepEqual([by[title].status, by[title].attempts], ['ready', 1], title);
  assert.match(by['Writer error low'].reason, /^requeued \(first\) 2026-10-27: error: writer returned/);
  assert.match(by['Facts rich'].reason, /^requeued \(later\) 2026-10-27: CREATIVE_REVIEW_REJECTED/);
  for (const title of ['Facts poor', 'Picture fit', 'Duplicate']) assert.equal(by[title].status, 'quarantine', title);
  assert.equal(by['Not quarantined'].status, 'rejected', 'only quarantined stories move');
  assert.equal((await pool.requeueQuarantined({ apply: true })).tierA.length + (await pool.requeueQuarantined({ apply: true })).tierB.length, 0, 'running it again changes nothing');

  // the order of the next claims: the untouched story first, then tier A (richest first, ahead of any tier B story), then tier B by richness
  const order = [];
  for (let i = 0; i < 5; i += 1) { order.push((await pool.claimNext()).title); await new Promise(resolve => setTimeout(resolve, 1100)); }
  assert.deepEqual(order, ['Untouched', 'Writer error high', 'Writer error low', 'Facts richer', 'Facts rich']);
  console.log('requeue quarantine: ok');
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
