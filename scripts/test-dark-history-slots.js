// Dark History checks: hourly at minute 40, LLM jobs never overlap, Shorts are produced AHEAD until the queue of scheduled Shorts is full, a failed check waits for the next.
const assert = require('node:assert/strict');
const cron = require('node-cron');
const { DailyAutomation } = require('../schedules/daily-automation');

const silent = { info() {}, warn() {}, error() {}, success() {}, startTimer: () => ({ end() {} }) };
const HOUR = 3600000;
const makeScheduler = (lastGeneration, queued = 0, oldCompleted = 0, ready = 42, documentaryCompleted = 0) => {
  const settings = lastGeneration ? { last_content_generation: lastGeneration } : {};
  const db = {
    getChannelStrategy: async () => ({ id: 's', status: 'active', cadence_per_week: 21 }),
    getAllRows: async sql => {
      if (/FROM publish_schedule/.test(sql)) return [{ n: queued }];
      // the week's completed jobs: 16 old stickman Shorts, no Dark History one
      if (/FROM generation_jobs/.test(sql)) return /style = 'documentary'/.test(sql) ? Array.from({ length: documentaryCompleted }, () => ({ details: '{"reviewStatus":"approved"}' })) : Array.from({ length: oldCompleted }, () => ({ details: '{"reviewStatus":"approved"}' }));
      return [];
    },
    getSetting: async key => settings[key] ?? null,
    getPoolStatus: async () => null
  };
  const scheduler = new DailyAutomation({}, db, {});
  scheduler.logger = silent;
  scheduler.storyPool = { status: async () => ({ ready }) };
  return scheduler;
};

async function main() {
  // the lane: a second job starts only after the first finished, and a failure does not block the lane
  const scheduler = makeScheduler();
  const log = [];
  const slow = scheduler.inLlmLane(async () => { log.push('a-start'); await new Promise(r => setTimeout(r, 30)); log.push('a-end'); throw new Error('boom'); });
  const next = scheduler.inLlmLane(async () => { log.push('b-start'); return 'b'; });
  await assert.rejects(slow, /boom/);
  assert.equal(await next, 'b');
  assert.deepEqual(log, ['a-start', 'a-end', 'b-start']);

  // the cron expressions: live -> the check at minute 40 every two hours, not live -> the old two-hourly check; a bad override falls back to the default slots
  const seen = [];
  const realSchedule = cron.schedule;
  cron.schedule = (expression, fn, opts) => { seen.push(expression); return realSchedule.call(cron, expression, fn, opts); };
  const tasks = [];
  try {
    for (const [live, override] of [['true', ''], ['true', 'not a cron'], ['true', '10 4,12,20 * * *'], ['false', '']]) {
      process.env.DARK_HISTORY_LIVE = live; process.env.DARK_HISTORY_SLOT_CRON = override;
      seen.length = 0;
      const s = makeScheduler();
      await s.setupScheduledTasks.call(Object.assign(s, { ensureRecentBackup: async () => {} }));
      tasks.push(seen[0]);
      s.scheduledTasks.forEach(task => task.stop());
    }
  } finally { cron.schedule = realSchedule; }
  assert.deepEqual(tasks, ['40 * * * *', '40 * * * *', '10 4,12,20 * * *', '0 */2 * * *']);

  // Live: Shorts are made ahead. Fewer than 5 scheduled (DARK_HISTORY_QUEUE_AHEAD, default 5) = a Short is made at this check, whatever the last one was; 5 = nothing is spent.
  process.env.DARK_HISTORY_LIVE = 'true';
  delete process.env.DARK_HISTORY_QUEUE_AHEAD;
  assert.equal(await makeScheduler(new Date(Date.now() - 1 * HOUR).toISOString(), 0).shouldGenerateContentToday(), true, 'empty queue: produce, even one hour after the last');
  assert.equal(await makeScheduler(new Date(Date.now() - 1 * HOUR).toISOString(), 4).shouldGenerateContentToday(), true, '4 of 5 scheduled: produce');
  const full = makeScheduler(new Date(Date.now() - 20 * HOUR).toISOString(), 5);
  assert.equal(await full.shouldGenerateContentToday(), false);
  assert.match(full.lastSkipReason, /queue full: 5 Shorts are scheduled \(target 5/);
  process.env.DARK_HISTORY_QUEUE_AHEAD = '2';
  assert.equal(await makeScheduler(null, 2).shouldGenerateContentToday(), false, 'the target can be changed');
  delete process.env.DARK_HISTORY_QUEUE_AHEAD;
  // Live: the weekly count is the Dark History Shorts only; 16 old stickman Shorts of the last 7 days must not stop production (they did: 16 of 15)
  assert.equal(await makeScheduler(null, 0, 16, 22).shouldGenerateContentToday(), true, 'old Shorts do not count against the week (22 ready stories allow about 11 a week)');
  // The pool limits the weekly cadence by default (22 ready stories: 11 a week at the 14-day default horizon); DARK_HISTORY_POOL_LIMITS_CADENCE=false keeps the strategy's 21
  delete process.env.DARK_HISTORY_POOL_LIMITS_CADENCE;
  const limited = makeScheduler(null, 0, 0, 22, 17);
  assert.equal(await limited.shouldGenerateContentToday(), false);
  assert.match(limited.lastSkipReason, /weekly target reached \(17\/11/);
  process.env.DARK_HISTORY_POOL_LIMITS_CADENCE = 'false';
  assert.equal(await makeScheduler(null, 0, 0, 22, 17).shouldGenerateContentToday(), true, '17 of 21 a week: still allowed');
  const capped = makeScheduler(null, 0, 0, 22, 21);
  assert.equal(await capped.shouldGenerateContentToday(), false, 'the 21 a week cap itself stays');
  assert.match(capped.lastSkipReason, /weekly target reached \(21\/21/);
  delete process.env.DARK_HISTORY_POOL_LIMITS_CADENCE;
  // Not live: the old pacing gate (21/week = one per 8 h) is unchanged.
  process.env.DARK_HISTORY_LIVE = 'false';
  assert.equal(await makeScheduler(new Date(Date.now() - 7.5 * HOUR).toISOString()).shouldGenerateContentToday(), false);
  const early = makeScheduler(new Date(Date.now() - 6.5 * HOUR).toISOString());
  assert.equal(await early.shouldGenerateContentToday(), false);
  assert.match(early.lastSkipReason, /pacing/);
  assert.equal(await makeScheduler(new Date(Date.now() - 9 * HOUR).toISOString()).shouldGenerateContentToday(), true);
  const old = makeScheduler(null, 0, 22);
  assert.equal(await old.shouldGenerateContentToday(), false, 'not live: every Short counts, as before');
  assert.match(old.lastSkipReason, /weekly target reached/);
  console.log('dark-history slots: ok');
  process.exit(0);
}

main().catch(error => { console.error(error); process.exit(1); });
