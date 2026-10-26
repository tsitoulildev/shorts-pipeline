// Weekly report: the comparison never calls a difference inside the noise a success, the verdict waits for 14 Shorts, and the report builds from the database + Analytics.
const assert = require('node:assert/strict');
const { BASELINE, median, compareToBaseline, runWeeklyReport } = require('../utils/dark-history/weekly-report');
const { DailyAutomation } = require('../schedules/daily-automation');

assert.equal(BASELINE.views.length, 35);
assert.equal(median(BASELINE.views), 299);
// fewer than 14: no verdict, whatever the numbers
assert.equal(compareToBaseline([1000, 1100, 900]).verdict, 'too early');
// 14 Shorts drawn from the same spread (a shuffled slice of the baseline): inside the noise
const same = BASELINE.views.filter((_, i) => i % 5 !== 0 && i % 5 !== 2).slice(0, 21).filter((_, i) => i % 3 !== 0);
assert.equal(compareToBaseline(same).verdict, 'within the noise');
// 14 Shorts at 340 to 420 (a +20 % median on 299, which the spread of the baseline cannot tell from luck): still inside the noise
const modest = Array.from({ length: 14 }, (_, i) => 330 + i * 8);
assert.equal(compareToBaseline(modest).verdict, 'within the noise', 'a 20 % higher median is not proof');
// a clear shift is reported, both ways
assert.equal(compareToBaseline(Array.from({ length: 14 }, (_, i) => 1000 + i * 20)).verdict, 'higher');
assert.equal(compareToBaseline(Array.from({ length: 14 }, (_, i) => 20 + i * 3)).verdict, 'lower');
// deterministic
assert.deepEqual(compareToBaseline(modest), compareToBaseline(modest));

(async () => {
  const day = n => new Date(Date.UTC(2026, 9, 26) - n * 86400000).toISOString();
  const rows = [
    { id: 'a', published: day(5), title: 'A', marked: 0 }, { id: 'b', published: day(4), title: 'B', marked: 1 }, { id: 'c', published: day(1), title: 'C', marked: 1 }
  ];
  const db = { getAllRows: async sql => { assert.match(sql, /hookFirst/); return rows; } };
  const analytics = { reports: { query: async p => (p.dimensions === 'video'
    ? { data: { rows: [['a', 500, 200, 2], ['b', 800, 300, 1], ['c', 5, 2, 0]] } }
    : { data: { rows: [[0.39, 0.6], [0.4, 0.55 + (p.filters === 'video==a' ? 0 : 0.1)], [0.41, 0.5]] } }) } };
  const report = await runWeeklyReport({ db, analytics, now: new Date(Date.UTC(2026, 9, 26)) });
  assert.equal(report.data.week.n, 2, 'a Short of 1 day is listed by the Analytics lag, not compared');
  assert.equal(report.data.changed.n, 1, 'one aged Short made with the changes');
  assert.equal(report.data.verdict.verdict, 'too early');
  assert.match(report.text, /1 of 14 needed so far/);
  assert.match(report.text, /median views 299/);

  // the scheduler stores and sends it once; it needs the analytics client of the analytics agent
  const sent = []; const saved = {};
  const scheduler = new DailyAutomation({ analytics: { youtubeAnalytics: analytics } }, { ...db, setSetting: async (k, v) => { saved[k] = v; } }, { notify: async n => sent.push(n) });
  scheduler.logger = { info() {}, warn() {}, error() {}, success() {} };
  const done = await scheduler.weeklyAnalyticsReport(new Date(Date.UTC(2026, 9, 26)));
  assert.ok(done && sent.length === 1 && sent[0].type === 'dark_history_weekly_report' && saved['dh_weekly_report:2026-10-26']);
  assert.equal(await new DailyAutomation({}, db, {}).weeklyAnalyticsReport(), null, 'no analytics client: nothing happens');
  console.log('weekly report: ok');
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
