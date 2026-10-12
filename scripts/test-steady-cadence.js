// Owner decision 2026-10-12: Dark History makes at most 3 Shorts a day and the size of the pool never lowers that; an empty pool waits for the refill.
// Pictures first: a story whose passages cannot be covered by free-licence pictures falls before any LLM call. The refill budget counter counts the judge calls it makes.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Database } = require('../database/db');
const { fixtureHttp } = require('./dark-history-probe');
const { StoryPool } = require('../utils/dark-history/story-pool');
const { steadyCadence, maxPerDay } = require('../utils/dark-history/live');
const { planFootage } = require('../utils/dark-history/footage');
const { refillPool } = require('../utils/dark-history/pool-refill');

const quiet = { warn() {}, info() {} };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steady-'));
  const db = new Database();
  db.dbPath = path.join(dir, 'test.db');
  await db.initialize();
  const pool = new StoryPool(db);
  const add = async n => { for (let i = 0; i < n; i += 1) await pool.add({ title: `Stock ${Math.random()}`, status: 'ready', plan: { beats: [] }, attribution: 'x' }); };

  // ---- cadence: the strategy's target capped at 3 a day; 1 ready story or 100 make no difference; 0 ready = wait ----
  delete process.env.DARK_HISTORY_MAX_PER_DAY;
  assert.equal(maxPerDay(), 3);
  assert.deepEqual([(await steadyCadence(pool, 21)).perWeek, (await steadyCadence(pool, 21)).empty], [21, true], 'empty pool: waits (empty), the cadence itself is not lowered');
  await add(1);
  assert.deepEqual([(await steadyCadence(pool, 21)).perWeek, (await steadyCadence(pool, 21)).empty], [21, false], 'one ready story: still 21 a week');
  await add(40);
  assert.equal((await steadyCadence(pool, 21)).perWeek, 21);
  assert.equal((await steadyCadence(pool, 35)).perWeek, 21, 'a target above 3 a day is capped');
  assert.equal((await steadyCadence(pool, 14)).perWeek, 14, 'a lower target stays as it is');
  process.env.DARK_HISTORY_MAX_PER_DAY = '2';
  assert.equal((await steadyCadence(pool, 21)).perWeek, 14, 'the cap is DARK_HISTORY_MAX_PER_DAY');
  delete process.env.DARK_HISTORY_MAX_PER_DAY;

  // ---- pictures first: no LLM call for a story that cannot be covered ----
  let judged = 0;
  const judge = async (_beat, list) => { judged += 1; return list; };
  const noImages = { ...fixtureHttp, getJson: async (url, params) => (/commons/.test(url) || params.prop === 'imageinfo' ? { query: { pages: [] } } : fixtureHttp.getJson(url, params)) };
  const doomed = await planFootage('Mary Celeste', { http: noImages, judge });
  assert.equal(doomed.eligible, false);
  assert.equal(doomed.preChecked, true);
  assert.match(doomed.reason, /licensed footage for only 0 of \d+ passages \(need 4\) \[image pre-check, no LLM call\]/);
  assert.equal(judged, 0, 'the judge was never asked');
  // a story with pictures only from the search still reaches the judge, and the judge still decides (a judge that says no drops every such beat)
  const searchOnly = { ...fixtureHttp, getJson: async (url, params) => (params.action === 'parse' ? { parse: { text: '<p>none</p>' } } : fixtureHttp.getJson(url, params)) };
  const asked = await planFootage('Mary Celeste', { http: searchOnly, judge });
  assert.ok(judged > 0, 'pictures exist, so the judge is asked');
  assert.notEqual(asked.preChecked, true);
  assert.equal((await planFootage('Mary Celeste', { http: searchOnly, judge: async () => [] })).eligible, false, 'the judge keeps its veto');
  // editor-placed pictures need no judge at all, as before
  assert.equal((await planFootage('Mary Celeste', { http: fixtureHttp })).eligible, true);

  // ---- the refill budget counts the judge calls it makes and keeps the total per day ----
  await db.executeQuery("UPDATE story_pool SET status = 'rejected'"); // fewer than 30 untouched stories left: the refill runs
  const budgetPool = new StoryPool(db);
  let calls = 0;
  let visionCalls = 0;
  const countedJudge = async (_beat, list) => { calls += 1; return list; };
  const now = new Date('2026-10-12T10:00:00Z');
  const before = Number(await db.getSetting('dh_llm_calls:2026-10-12')) || 0;
  await refillPool({ pool: budgetPool, http: searchOnly, judge: countedJudge, visionJudge: async () => { visionCalls += 1; return JSON.stringify({ mismatch: [] }); }, perWeek: 21, imageDir: path.join(dir, 'img'), candidates: ['Mary Celeste'], now, logger: quiet });
  const after = Number(await db.getSetting('dh_llm_calls:2026-10-12')) || 0;
  assert.ok(calls > 0, 'the judge was called');
  assert.ok(visionCalls > 0, 'the vision judge was called');
  assert.equal(after - before, calls + visionCalls, 'the stored daily counter equals the relevance AND vision judge calls made');

  await db.close?.();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log('steady cadence: ok');
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
