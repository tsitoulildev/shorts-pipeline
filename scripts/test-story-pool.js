// Offline: story pool, vetting, refill job, low-pool alert and cadence slow-down (recorded Wikipedia/Commons responses).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Database } = require('../database/db');
const { fixtureHttp } = require('./dark-history-probe');
const { StoryPool, poolDays, allowedCadencePerWeek } = require('../utils/dark-history/story-pool');
const { vetArticle } = require('../utils/dark-history/event-vetting');
const { refillPool } = require('../utils/dark-history/pool-refill');
const config = require('../config/dark-history-events.json');

const article = (extract, categories = []) => ({ extract, categories });

(async () => {
  // Vetting: no living persons, nothing newer than ~50 years, unknown age refused.
  const now = new Date('2026-10-06');
  assert.ok(vetArticle(article('The ship was found in 1872.'), now).ok);
  assert.ok(vetArticle(article('The group died in 1959. A memorial was built in 2019.'), now).ok);
  assert.ok(vetArticle(article('Vesuvius buried the city in 79 AD.'), now).ok);
  assert.strictEqual(vetArticle(article('It happened in 1986.'), now).ok, false);
  assert.strictEqual(vetArticle(article('In 1950 x. In 2001 y. In 2010 z.'), now).ok, false);
  assert.strictEqual(vetArticle(article('Something odd happened.'), now).ok, false);
  assert.match(vetArticle(article('Born in 1950.', ['Category:Living people']), now).reason, /living/);
  assert.strictEqual(vetArticle(article('It was 1900.', ['Category:Disambiguation pages']), now).ok, false);

  // Cadence slow-down: 28/week needs 56 stories for 14 days; fewer stories spread over the horizon.
  assert.strictEqual(poolDays(56, 28), 14);
  assert.strictEqual(allowedCadencePerWeek(56, 28), 28);
  assert.strictEqual(allowedCadencePerWeek(100, 28), 28);
  assert.strictEqual(allowedCadencePerWeek(28, 28), 14);
  assert.strictEqual(allowedCadencePerWeek(1, 28), 1);
  assert.strictEqual(allowedCadencePerWeek(0, 28), 0);

  // The configured list is clean: unique titles, enough to fill a 14-day pool at 28/week once vetted.
  assert.strictEqual(new Set(config.events.map(e => e.toLowerCase())).size, config.events.length);
  assert.ok(config.events.length >= 60);

  // Real database file, pool table created on first use.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-'));
  const db = new Database();
  db.dbPath = path.join(dir, 'test.db');
  await db.initialize();
  const pool = new StoryPool(db);
  assert.strictEqual(await pool.readyCount(), 0);
  assert.strictEqual(await pool.claimNext(), null);

  // Refill: a vetted story with footage is stored ready with downloaded images, attribution and a CC BY-SA text credit.
  const alerts = [];
  const notify = async alert => alerts.push(alert);
  const living = { ...fixtureHttp, getJson: async (url, params) => {
    if (params?.titles === 'Living Person') return { query: { pages: [{ title: 'Living Person', extract: 'Born 1950.', fullurl: 'u', categories: [{ title: 'Category:Living people' }], images: [] }] } };
    return fixtureHttp.getJson(url, params);
  } };
  const flaky = { ...living, getJson: async (url, params) => { if (params?.titles === 'Flaky') throw new Error('socket hang up'); return living.getJson(url, params); } };
  const result = await refillPool({ pool, http: flaky, notify, perWeek: 28, imageDir: path.join(dir, 'img'), candidates: ['Mary Celeste', 'Living Person', 'Flaky', 'Tunguska event'], logger: { warn() {} } });
  assert.strictEqual(result.researched, 4);
  assert.strictEqual(result.ready, 2, 'Mary Celeste and Tunguska enter the pool');
  const known = await pool.knownTitles();
  assert.ok(known.has('living person'), 'a rejection is stored so it is not retried');
  assert.ok(!known.has('flaky'), 'a transient error is not stored as a rejection');
  const rejected = await db.getRow("SELECT reason FROM story_pool WHERE title = 'Living Person'");
  assert.match(rejected.reason, /living person/);

  // Low pool: alert once-per-window key, error level only when empty, cadence limited.
  assert.strictEqual(alerts.length, 1);
  assert.strictEqual(alerts[0].type, 'story_pool_low');
  assert.strictEqual(alerts[0].level, 'warning');
  assert.strictEqual(alerts[0].dedupeKey, 'story_pool_low');
  assert.strictEqual(result.allowedPerWeek, 1);

  // Daily free-tier budget: with no calls left nothing is researched, and the spend is stored per day.
  const calls = [];
  const limited = await refillPool({ pool, http: fixtureHttp, notify, perWeek: 28, imageDir: dir, candidates: ['Mary Celeste'], dailyLlmCalls: 0, judge: async () => { calls.push(1); return []; }, logger: { warn() {} } });
  assert.strictEqual(limited.researched, 0);
  assert.strictEqual(limited.budgetExhausted, true);
  await db.setSetting('dh_llm_calls:2026-10-06', '149');
  const spend = await refillPool({ pool, http: fixtureHttp, notify, perWeek: 28, imageDir: dir, candidates: ['Nothing Known'], dailyLlmCalls: 150, now: new Date('2026-10-06T12:00:00Z'), logger: { warn() {} } });
  assert.strictEqual(spend.llmCallsToday, 149);
  assert.strictEqual(spend.researched, 1);

  // Claim: oldest ready story first, marked used, plan and images on disk, never handed out twice.
  const first = await pool.claimNext();
  assert.strictEqual(first.title, 'Mary Celeste');
  assert.match(first.attribution, /Wikipedia, "Mary Celeste"/);
  assert.ok(first.plan.beats.every(b => b.images.every(i => fs.existsSync(path.join(first.plan.folder, i.file)) && i.sha256 && i.license)));
  assert.strictEqual(first.share_alike, false);
  const second = await pool.claimNext();
  assert.strictEqual(second.title, 'Tunguska event');
  assert.strictEqual(second.share_alike, true);
  assert.strictEqual(await pool.claimNext(), null);

  // An empty pool alerts at error level.
  alerts.length = 0;
  await refillPool({ pool, http: fixtureHttp, notify, perWeek: 28, imageDir: dir, candidates: [], logger: { warn() {} } });
  assert.strictEqual(alerts[0].level, 'error');

  await db.close?.();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log('story pool tests passed');
})().catch(error => { console.error(error); process.exit(1); });
