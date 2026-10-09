// Dark History slots: one Short per slot, LLM jobs never overlap, pacing tolerates a slot firing slightly early, a failed slot waits for the next.
const assert = require('node:assert/strict');
const cron = require('node-cron');
const { DailyAutomation } = require('../schedules/daily-automation');

const silent = { info() {}, warn() {}, error() {}, success() {}, startTimer: () => ({ end() {} }) };
const HOUR = 3600000;
const makeScheduler = (lastGeneration) => {
  const settings = lastGeneration ? { last_content_generation: lastGeneration } : {};
  const db = {
    getChannelStrategy: async () => ({ id: 's', status: 'active', cadence_per_week: 21 }),
    getAllRows: async () => [],
    getSetting: async key => settings[key] ?? null,
    getPoolStatus: async () => null
  };
  const scheduler = new DailyAutomation({}, db, {});
  scheduler.logger = silent;
  scheduler.storyPool = { status: async () => ({ ready: 42 }) };
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
  assert.deepEqual(tasks, ['40 */2 * * *', '40 */2 * * *', '10 4,12,20 * * *', '0 */2 * * *']);

  // pacing: 21/week = one per 8 h. Live: a slot 7.5 h after the last Short is due (tolerance 1 h), 6.5 h is not. Not live: 7.5 h is not due.
  process.env.DARK_HISTORY_LIVE = 'true';
  assert.equal(await makeScheduler(new Date(Date.now() - 7.5 * HOUR).toISOString()).shouldGenerateContentToday(), true);
  const early = makeScheduler(new Date(Date.now() - 6.5 * HOUR).toISOString());
  assert.equal(await early.shouldGenerateContentToday(), false);
  assert.match(early.lastSkipReason, /pacing/);
  process.env.DARK_HISTORY_LIVE = 'false';
  assert.equal(await makeScheduler(new Date(Date.now() - 7.5 * HOUR).toISOString()).shouldGenerateContentToday(), false);

  // a failed slot leaves last_content_generation untouched (it is written only on success), so the next slot, 8 h later, is due
  process.env.DARK_HISTORY_LIVE = 'true';
  assert.equal(await makeScheduler(new Date(Date.now() - 16 * HOUR).toISOString()).shouldGenerateContentToday(), true);
  console.log('dark-history slots: ok');
  process.exit(0);
}

main().catch(error => { console.error(error); process.exit(1); });
