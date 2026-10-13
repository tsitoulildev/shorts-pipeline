// Dark History hourly check: up to 3 attempts in a row while the queue is short (one at a time), the first success ends the check, the 429 limiter drops the next check to a
// single attempt, and one row per check is stored. Every attempt is a full production: nothing here touches a gate.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Database } = require('../database/db');
const { DailyAutomation } = require('../schedules/daily-automation');
const { YieldStats } = require('../utils/dark-history/yield-stats');

const silent = { info() {}, warn() {}, error() {}, success() {}, startTimer: () => ({ end() {} }) };

(async () => {
  process.env.DARK_HISTORY_LIVE = 'true';
  delete process.env.DARK_HISTORY_MAX_ATTEMPTS_PER_SLOT;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-'));
  const db = new Database();
  db.dbPath = path.join(dir, 'test.db');
  await db.initialize();
  const stats = new YieldStats(db);

  // outcomes: [{ status, r429, ok, provider }] consumed one per attempt; each attempt also writes its calls into dh_llm_stats like the real writer does
  const make = outcomes => {
    const s = new DailyAutomation({}, db, {});
    s.logger = silent;
    s.logAutomationEvent = async () => {};
    s.shouldGenerateContentToday = async () => true;
    let n = 0;
    s.started = 0;
    s.running = 0;
    s.maxRunning = 0;
    s.generateContent = async () => { s.started += 1; n += 1; return { id: `job_${n}` }; };
    s.waitForJob = async () => {
      s.running += 1; s.maxRunning = Math.max(s.maxRunning, s.running);
      assert.equal(s.slotRunning, true, 'the dashboard counts the slot as active while it runs');
      const o = outcomes.shift();
      for (let i = 0; i < (o.ok || 0); i += 1) await stats.llmEvent({ role: 'writer', provider: o.provider || 'Groq', model: 'm', outcome: 'ok' });
      for (let i = 0; i < (o.r429 || 0); i += 1) await stats.llmEvent({ role: 'writer', provider: o.provider || 'Groq', model: 'm', outcome: 'rate_limited' });
      s.running -= 1;
      return { status: o.status };
    };
    return s;
  };
  const fail = extra => ({ status: 'failed', ok: 4, ...extra });

  // 1. fail, fail, success: three attempts, the success ends the check
  let s = make([fail(), fail(), { status: 'completed', ok: 5 }]);
  let result = await s.runLiveSlot();
  assert.deepEqual([s.started, result.attempts, result.successes], [3, 3, 1]);
  assert.equal(s.maxRunning, 1, 'never two attempts at once');
  assert.equal(s.slotRunning, false);

  // 2. the first success ends the check at once
  s = make([{ status: 'completed', ok: 5 }, fail()]);
  result = await s.runLiveSlot();
  assert.deepEqual([s.started, result.attempts, result.successes], [1, 1, 1]);

  // 3. three failures: never a fourth attempt
  s = make([fail(), fail(), fail(), fail()]);
  result = await s.runLiveSlot();
  assert.deepEqual([s.started, result.attempts, result.successes], [3, 3, 0]);

  // 4. nothing is due (queue full): no attempt, a row with 0 attempts
  s = make([]);
  s.shouldGenerateContentToday = async () => false;
  result = await s.runLiveSlot();
  assert.deepEqual([s.started, result.attempts], [0, 0]);

  // 5. the 429 limiter: 3 rate limits in one attempt end the check and the next check makes ONE attempt
  s = make([fail({ r429: 3 }), fail(), fail()]);
  result = await s.runLiveSlot();
  assert.deepEqual([result.attempts, result.throttled, result.cap], [1, true, 3]);
  assert.equal(await db.getSetting('dh_attempt_cap'), '1');
  s = make([fail(), fail(), fail()]);
  result = await s.runLiveSlot();
  assert.deepEqual([result.attempts, result.throttled, result.cap], [1, false, 1], 'one attempt while the cap is 1, and it stayed below the limit');
  assert.equal(await db.getSetting('dh_attempt_cap'), '3', 'restored for the next check');
  s = make([fail(), fail(), fail()]);
  result = await s.runLiveSlot();
  assert.equal(result.attempts, 3);

  // 6. the share rule: 2 rate limits in 12 calls (17 %) also throttles; 2 in 30 does not
  s = make([fail({ ok: 10, r429: 2 }), fail()]);
  result = await s.runLiveSlot();
  assert.deepEqual([result.attempts, result.throttled], [1, true]);
  await db.setSetting('dh_attempt_cap', '3');
  s = make([fail({ ok: 28, r429: 2 }), fail({ ok: 4 }), fail({ ok: 4 })]);
  result = await s.runLiveSlot();
  assert.deepEqual([result.attempts, result.throttled], [3, false]);

  // 7. the hourly row: attempts, successes, rate limits and calls per provider, queue, cap
  await db.setSetting('dh_attempt_cap', '3');
  await db.executeQuery('DELETE FROM dh_hourly');
  s = make([fail({ ok: 3, r429: 1, provider: 'Groq' }), { status: 'completed', ok: 2, provider: 'Mistral AI' }]);
  result = await s.runLiveSlot();
  const rows = await db.getAllRows('SELECT * FROM dh_hourly');
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].attempts, rows[0].successes, rows[0].r429, rows[0].queue, rows[0].cap, rows[0].throttled], [2, 1, 1, 0, 3, 0]);
  assert.deepEqual(JSON.parse(rows[0].calls), { Groq: 4, 'Mistral AI': 2 });
  assert.equal((await stats.report(1)).hourly.length, 1, 'the report carries the hourly rows');

  // 8. the cap can be changed (DARK_HISTORY_MAX_ATTEMPTS_PER_SLOT) and the old single-run path is untouched when not live
  process.env.DARK_HISTORY_MAX_ATTEMPTS_PER_SLOT = '2';
  s = make([fail(), fail(), fail()]);
  assert.equal((await s.runLiveSlot()).attempts, 2);
  delete process.env.DARK_HISTORY_MAX_ATTEMPTS_PER_SLOT;

  await db.close?.();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log('live slot: ok');
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
