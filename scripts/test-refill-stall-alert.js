// The alert for a refill that is stuck: 3 runs in a row with researched 0 while fewer than 30 untouched stories are left; a run with research, a run stopped by the budget
// or a pool with enough untouched stories does not count. Plus the low-pool alert at fewer than 10 ready stories (about 3 days of production).
const assert = require('node:assert/strict');
const { DailyAutomation } = require('../schedules/daily-automation');
const { LOW_READY } = require('../utils/dark-history/story-pool');

assert.equal(LOW_READY, 10, 'about 3 days of production');
const quiet = { info() {}, warn() {}, error() {}, success() {} };
const make = untouched => {
  const settings = {}; const sent = [];
  const scheduler = new DailyAutomation({}, { getSetting: async k => settings[k] ?? null, setSetting: async (k, v) => { settings[k] = v; } }, { notify: async n => sent.push(n) });
  scheduler.logger = quiet;
  scheduler.storyPool = { untouchedCount: async () => untouched.value };
  return { scheduler, sent, settings };
};
const run = { ready: 19, days: 6.3 };

(async () => {
  const untouched = { value: 0 };
  const { scheduler, sent, settings } = make(untouched);
  await scheduler.trackRefillStall({ ...run, researched: 0 });
  await scheduler.trackRefillStall({ ...run, researched: 0 });
  assert.equal(sent.length, 0, 'two runs are not an alert');
  await scheduler.trackRefillStall({ ...run, researched: 0 });
  assert.equal(sent.length, 1, 'the third run in a row is');
  assert.equal(sent[0].type, 'story_pool_refill_stuck');
  assert.match(sent[0].message, /researched nothing in 3 runs/);
  assert.match(sent[0].message, /cadence is NOT changed/);
  // a run that researched something starts the count again
  await scheduler.trackRefillStall({ ...run, researched: 4 });
  assert.equal(settings.dh_refill_zero_streak, '0');
  await scheduler.trackRefillStall({ ...run, researched: 0 });
  await scheduler.trackRefillStall({ ...run, researched: 0 });
  assert.equal(sent.length, 1);
  // a run stopped by the daily budget is not a stuck refill
  await scheduler.trackRefillStall({ ...run, researched: 0, budgetExhausted: true });
  assert.equal(settings.dh_refill_zero_streak, '2');
  // enough untouched stories: researching nothing is the normal state
  untouched.value = 30;
  for (let i = 0; i < 4; i += 1) await scheduler.trackRefillStall({ ...run, researched: 0 });
  assert.equal(settings.dh_refill_zero_streak, '0');
  assert.equal(sent.length, 1);
  console.log('refill stall alert: ok');
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
