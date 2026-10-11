// Refill keeps researching while fewer than DARK_HISTORY_FRESH_TARGET untouched stories are left (even when the pool as a whole covers the target days), a title without
// an article is stored as refused (not asked for again), and the batch per run follows DARK_HISTORY_REFILL_BATCH.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Database } = require('../database/db');
const { fixtureHttp } = require('./dark-history-probe');
const { StoryPool } = require('../utils/dark-history/story-pool');
const { refillPool } = require('../utils/dark-history/pool-refill');
const config = require('../config/dark-history-events.json');

const allFit = async () => JSON.stringify({ mismatch: [] });
const quiet = { warn() {}, info() {} };
const missing = { ...fixtureHttp, getJson: async (url, params) => (params?.titles === 'Nothing Known' ? { query: { pages: [{ title: 'Nothing Known', missing: true }] } } : fixtureHttp.getJson(url, params)) };

(async () => {
  assert.ok(config.events.length >= 120, 'a longer list of well-illustrated candidates');
  assert.equal(new Set(config.events.map(e => e.toLowerCase())).size, config.events.length, 'unique titles');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refill-'));
  const db = new Database();
  db.dbPath = path.join(dir, 'test.db');
  await db.initialize();
  const pool = new StoryPool(db);
  const stock = async (n, attempts) => { for (let i = 0; i < n; i += 1) { const id = await pool.add({ title: `Stock ${attempts}-${i}`, status: 'ready', plan: { beats: [] }, attribution: 'x' }); await db.executeQuery('UPDATE story_pool SET attempts = ? WHERE id = ?', [attempts, id]); } };

  // 60 ready stories, all failed once: the pool "covers" the days, but nothing fresh is left: research goes on
  await stock(60, 1);
  assert.equal((await pool.status(21)).low, false);
  assert.equal(await pool.untouchedCount(), 0);
  const run = await refillPool({ pool, http: missing, visionJudge: allFit, perWeek: 21, imageDir: path.join(dir, 'img'), candidates: ['Mary Celeste', 'Nothing Known'], logger: quiet });
  assert.equal(run.researched, 2);
  const refused = await db.getRow("SELECT status, reason FROM story_pool WHERE title = 'Nothing Known'");
  assert.deepEqual([refused.status, refused.reason], ['rejected', 'article not found']);
  assert.ok((await pool.knownTitles()).has('nothing known'), 'not asked for again');
  // enough untouched stories: no research
  await stock(10, 0);
  const idle = await refillPool({ pool, http: missing, visionJudge: allFit, perWeek: 21, imageDir: path.join(dir, 'img2'), candidates: ['Tunguska event'], logger: quiet });
  assert.equal(idle.researched, 0, '10 untouched stories are enough');
  await db.close?.();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log('refill fresh: ok');
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
