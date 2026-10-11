// Pool behaviour: stories with little material are refused before the writer, richer stories go first, two failures park a story (quarantine) until no fresh story is left
// and 24 h have passed, and a third failure rejects it.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Database } = require('../database/db');
const { StoryPool } = require('../utils/dark-history/story-pool');
const { storyReadiness } = require('../utils/dark-history/readiness');

const passage = n => Array.from({ length: n }, (_, i) => `Sentence number ${i + 1} of this passage has more than five words in it.`).join(' ');
const beat = (n, caption = 'A captioned photograph of the place.jpg') => ({ heading: 'h', text: passage(n), images: [{ title: caption }] });

// readiness: 4 beats with 3+ citable sentences and a caption; a beat with 2 sentences or a bare file name does not count
assert.equal(storyReadiness({ plan: { beats: [beat(4), beat(3), beat(5), beat(3)] } }).ok, true);
const thin = storyReadiness({ plan: { beats: [beat(4), beat(2), beat(5), beat(3), beat(3, 'a.jpg')] } });
assert.equal(thin.ok, false);
assert.match(thin.reason, /only 3 of 5 beats/);
assert.ok(storyReadiness({ plan: { beats: [beat(6), beat(6), beat(6), beat(6)] } }).score > storyReadiness({ plan: { beats: [beat(3), beat(3), beat(3), beat(3)] } }).score, 'richer = higher score');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-q-'));
  const db = new Database();
  db.dbPath = path.join(dir, 'test.db');
  await db.initialize();
  const pool = new StoryPool(db);
  const add = (title, richness) => pool.add({ title, status: 'ready', plan: { title, beats: [], richness }, attribution: 'x' });
  await add('Poor', 5);
  await add('Rich', 50);
  await add('Middle', 20);
  // richer first, oldest first among equals
  const first = await pool.claimNext();
  assert.equal(first.title, 'Rich');
  // two failures: quarantine
  let released = await pool.release(first.id, { reason: 'x' });
  assert.deepEqual([released.status, released.attempts], ['ready', 1]);
  const second = await pool.claimNext();
  assert.equal(second.title, 'Middle', 'a story with a failed attempt waits behind the fresh ones');
  await pool.release(second.id, { reason: 'x' });
  const third = await pool.claimNext();
  assert.equal(third.title, 'Poor');
  await pool.release(third.id, { reason: 'x' });
  // Rich and Middle have 1 attempt, Poor 1: claim Rich again, fail it a second time: quarantine
  const again = await pool.claimNext();
  assert.equal(again.attempts, 1);
  released = await pool.release(again.id, { reason: 'second failure' });
  assert.deepEqual([released.status, released.attempts], ['quarantine', 2]);
  assert.equal((await pool.status(21)).ready, 2, 'a parked story is not counted as ready');
  // the two others are taken before the parked one; with nothing ready the parked story waits 24 h
  const a = await pool.claimNext(); const b = await pool.claimNext();
  assert.ok(a.title !== again.title && b.title !== again.title);
  await pool.release(a.id, { reason: 'x', countAttempt: false });
  await pool.release(b.id, { reason: 'x', countAttempt: false });
  await db.executeQuery("UPDATE story_pool SET status = 'used' WHERE title IN (?, ?)", [a.title, b.title]);
  assert.equal(await pool.claimNext(), null, 'only a parked story left, younger than 24 h: nothing to take');
  await db.executeQuery("UPDATE story_pool SET used_at = datetime('now', '-25 hours') WHERE status = 'quarantine'");
  const parked = await pool.claimNext();
  assert.equal(parked.title, again.title, 'after 24 h the parked story gets its last attempt');
  released = await pool.release(parked.id, { reason: 'third failure' });
  assert.deepEqual([released.status, released.attempts], ['rejected', 3]);
  await db.close?.();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log('pool quarantine: ok');
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
