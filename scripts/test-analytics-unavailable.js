// Analytics that return no data (revoked login, missing scope, 403) must not be reported as captured evidence.
const assert = require('node:assert/strict');
const { DailyAutomation } = require('../schedules/daily-automation');

const silent = { info() {}, warn() {}, error() {}, success() {}, startTimer: () => ({ end() {} }) };

async function run(reports) {
  const events = [];
  const notes = [];
  const db = {
    getAllRows: async () => [], getSetting: async () => null, setSetting: async () => {},
    executeQuery: async () => {}, createNotification: async () => 'n'
  };
  const scheduler = new DailyAutomation({
    analytics: {
      getDueMeasurementWindows: async () => ['24h'],
      analyzeVideoPerformance: async videoId => reports[videoId]
    }
  }, db, { notify: async note => { notes.push(note); } });
  scheduler.logger = silent;
  scheduler.sleep = async () => {};
  scheduler.getRecentlyPublishedVideos = async () => Object.keys(reports).map(id => ({ youtube_id: id, title: `Short ${id}` }));
  scheduler.logAutomationEvent = async (name, status, data) => { events.push({ name, status, data }); };
  await scheduler.collectDailyAnalytics();
  return { events, notes };
}

(async () => {
  // Every measurement unavailable: an error event and one owner alert, no "success".
  let { events, notes } = await run({ a: { analytics: { available: false, error: 'invalid_grant' } } });
  assert.equal(events.at(-1).status, 'error');
  assert.match(events.at(-1).data.error, /invalid_grant/);
  assert.equal(notes.length, 1);
  assert.ok(!events.some(event => event.status === 'success'));

  // Real data: success, counted.
  ({ events, notes } = await run({ a: { analytics: { available: true } } }));
  assert.equal(events.at(-1).status, 'success');
  assert.equal(events.at(-1).data.videosProcessed, 1);
  assert.equal(notes.length, 0);

  // Mixed: success, with the unavailable count recorded.
  ({ events } = await run({ a: { analytics: { available: true } }, b: { analytics: { available: false, error: '403' } } }));
  assert.equal(events.at(-1).status, 'success');
  assert.equal(events.at(-1).data.videosProcessed, 1);
  assert.equal(events.at(-1).data.unavailable, 1);
  console.log('Analytics unavailable is reported: PASS');
})().catch(error => { console.error(error); process.exit(1); });
