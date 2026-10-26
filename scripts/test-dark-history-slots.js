// Dark History checks: hourly at minute 40, LLM jobs never overlap, Shorts are produced AHEAD until the queue of scheduled Shorts is full, a failed check waits for the next.
const assert = require('node:assert/strict');
const cron = require('node-cron');
const { DailyAutomation } = require('../schedules/daily-automation');

const silent = { info() {}, warn() {}, error() {}, success() {}, startTimer: () => ({ end() {} }) };
const HOUR = 3600000;
const makeScheduler = (lastGeneration, queued = 0, oldCompleted = 0, ready = 42, made = { week: 0, day: 0 }) => {
  const settings = lastGeneration ? { last_content_generation: lastGeneration } : {};
  const db = {
    getChannelStrategy: async () => ({ id: 's', status: 'active', cadence_per_week: 21 }),
    getAllRows: async sql => {
      if (/FROM publish_schedule/.test(sql)) return [{ n: queued }];
      // the week's completed jobs: 16 old stickman Shorts, no Dark History one
      if (/FROM generation_jobs/.test(sql) && /style = 'documentary'/.test(sql)) return Array.from({ length: /-1 day/.test(sql) ? made.day : made.week }, () => ({ details: '{"reviewStatus":"approved"}' }));
      if (/FROM generation_jobs/.test(sql)) return Array.from({ length: oldCompleted }, () => ({ details: '{"reviewStatus":"approved"}' }));
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

  // the cron expressions: the check at minute 40 of every hour; a bad override falls back to the default slots
  const seen = [];
  const realSchedule = cron.schedule;
  cron.schedule = (expression, fn, opts) => { seen.push(expression); return realSchedule.call(cron, expression, fn, opts); };
  const tasks = [];
  try {
    for (const override of ['', 'not a cron', '10 4,12,20 * * *']) {
      process.env.DARK_HISTORY_SLOT_CRON = override;
      seen.length = 0;
      const s = makeScheduler();
      await s.setupScheduledTasks.call(Object.assign(s, { ensureRecentBackup: async () => {} }));
      tasks.push(seen[0]);
      s.scheduledTasks.forEach(task => task.stop());
    }
  } finally { cron.schedule = realSchedule; }
  assert.deepEqual(tasks, ['40 * * * *', '40 * * * *', '10 4,12,20 * * *']);
  delete process.env.DARK_HISTORY_SLOT_CRON;

  // The values the running process uses are shown (dashboard and startup log): queue ahead 5 by default, 7 when DARK_HISTORY_QUEUE_AHEAD says so.
  {
    delete process.env.DARK_HISTORY_QUEUE_AHEAD;
    assert.deepEqual(makeScheduler().darkHistorySettings(), { queueAhead: 5, maxAttemptsPerSlot: 3, maxPerDay: 3 });
    process.env.DARK_HISTORY_QUEUE_AHEAD = '7';
    assert.equal(makeScheduler().darkHistorySettings().queueAhead, 7);
    const logged = [];
    const shown = makeScheduler();
    shown.logger = { ...silent, info: message => logged.push(message) };
    shown.setupScheduledTasks = async () => {};
    shown.startMonitoringLoop = () => {};
    await shown.initialize();
    assert.ok(logged.some(message => /Dark History settings in use: .*"queueAhead":7/.test(message)), logged.join(' | '));
    delete process.env.DARK_HISTORY_QUEUE_AHEAD;
  }

  // The daily-output alert is registered at 18:00 UTC; it only alerts (fewer than 2 Shorts published or scheduled for today), once per day, with the rejection causes.
  {
    const registered = [];
    cron.schedule = (expression, fn, opts) => { registered.push([expression, opts && opts.timezone]); return realSchedule.call(cron, expression, fn, opts); };
    try {
      const s2 = makeScheduler();
      await s2.setupScheduledTasks.call(Object.assign(s2, { ensureRecentBackup: async () => {} }));
      s2.scheduledTasks.forEach(task => task.stop());
      assert.ok(registered.some(([expression, zone]) => expression === '0 18 * * *' && zone === 'UTC'), 'the 18:00 UTC check exists');
      assert.ok(registered.some(([expression]) => expression === '15 * * * *'), 'the hourly refill exists');
    } finally { cron.schedule = realSchedule; }
    const alerts = [];
    const checker = count => {
      const c = makeScheduler();
      c.notify = async alert => alerts.push(alert);
      c.db = { getAllRows: async sql => (/FROM publish_schedule/.test(sql) ? [{ n: count }] : /FROM dh_rejections/.test(sql) ? [{ cause: 'picture does not fit', n: 4 }] : []) };
      return c;
    };
    const now = new Date('2026-10-12T18:00:00Z');
    assert.deepEqual(await checker(2).checkDailyOutput(now), { day: '2026-10-12', count: 2, alerted: false });
    assert.equal(alerts.length, 0, '2 Shorts: no alert');
    assert.deepEqual(await checker(1).checkDailyOutput(now), { day: '2026-10-12', count: 1, alerted: true });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].type, 'dark_history_low_daily_output');
    assert.equal(alerts[0].dedupeKey, 'dark_history_low_daily_output:2026-10-12');
    assert.match(alerts[0].message, /1 Shorts are published or scheduled for 2026-10-12 UTC.*picture does not fit 4/);
    assert.match(alerts[0].message, /No gate is relaxed/);
  }

  // Shorts are made ahead. Fewer than 5 scheduled (DARK_HISTORY_QUEUE_AHEAD, default 5) = a Short is made at this check, whatever the last one was; 5 = nothing is spent.
  delete process.env.DARK_HISTORY_QUEUE_AHEAD;
  assert.equal(await makeScheduler(new Date(Date.now() - 1 * HOUR).toISOString(), 0).shouldGenerateContentToday(), true, 'empty queue: produce, even one hour after the last');
  assert.equal(await makeScheduler(new Date(Date.now() - 1 * HOUR).toISOString(), 4).shouldGenerateContentToday(), true, '4 of 5 scheduled: produce');
  const full = makeScheduler(new Date(Date.now() - 20 * HOUR).toISOString(), 5);
  assert.equal(await full.shouldGenerateContentToday(), false);
  assert.match(full.lastSkipReason, /queue full: 5 Shorts are scheduled \(target 5/);
  process.env.DARK_HISTORY_QUEUE_AHEAD = '2';
  assert.equal(await makeScheduler(null, 2).shouldGenerateContentToday(), false, 'the target can be changed');
  delete process.env.DARK_HISTORY_QUEUE_AHEAD;
  // The weekly count is the Dark History Shorts only; 16 old stickman Shorts of the last 7 days must not stop production (they did: 16 of 15)
  assert.equal(await makeScheduler(null, 0, 16, 22).shouldGenerateContentToday(), true, 'old Shorts do not count against the week (22 ready stories allow about 11 a week)');
  // the pool refill gets the text service of the service itself (it used to come from the removed strategy agent, which left the judges null and admitted no story)
  {
    const refill = require('../utils/dark-history/pool-refill');
    const original = refill.refillPool;
    let seen = null;
    refill.refillPool = async options => { seen = options; return { ready: 1, days: 1, researched: 0 }; };
    const withText = new DailyAutomation({}, { getChannelStrategy: async () => ({}) }, { aiText: { gemini: {}, model: 'test', isAvailable: () => true, generateText: async () => ({}) } });
    withText.logger = silent;
    withText.storyPool = { status: async () => ({ ready: 1 }) };
    try { await withText.refillStoryPool(); } finally { refill.refillPool = original; }
    assert.ok(seen && typeof seen.judge === 'function' && typeof seen.visionJudge === 'function', 'the refill gets both judges when a text service exists');
  }
  // the service hands its text service to the statistics
  {
    const { YouTubeAutomationAgent } = require('../index');
    const fake = Object.create(YouTubeAutomationAgent.prototype);
    fake.aiText = {}; fake.agents = {}; fake.getYieldStats = () => ({ llmEvent: async () => {} });
    assert.equal(fake.attachYieldStats(), 1);
    assert.equal(typeof fake.aiText.statsSink, 'function', 'the text service reports to the yield statistics');
  }
  // 21 Shorts MADE in the last 7 days (a catch-up burst) must not stop production while the queue is short: this stopped it for 41 checks (10-14 15:40 to 10-16)
  const burst = makeScheduler(null, 4, 0, 42, { week: 21, day: 2 });
  assert.equal(await burst.shouldGenerateContentToday(), true, 'a full week of made Shorts does not stop production while the queue is below its target');
  const runaway = makeScheduler(null, 4, 0, 42, { week: 21, day: 6 });
  assert.equal(await runaway.shouldGenerateContentToday(), false, 'twice the daily maximum in 24 h still stops it');
  assert.match(runaway.lastSkipReason, /runaway guard/);
  assert.equal(await makeScheduler(null, 5, 0, 42, { week: 21, day: 1 }).shouldGenerateContentToday(), false, 'a full queue still stops it');
  console.log('dark-history slots: ok');
  process.exit(0);
}

main().catch(error => { console.error(error); process.exit(1); });
