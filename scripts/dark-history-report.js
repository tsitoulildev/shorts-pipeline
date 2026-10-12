// Dark History yield report (read-only on the VM):  node scripts/dark-history-report.js [days=7]
// Jobs per day and source, results per role and model, and the histogram of rejection causes per day.
require('dotenv').config();
const { Database } = require('../database/db');
const { YieldStats } = require('../utils/dark-history/yield-stats');

(async () => {
  const days = Math.max(1, Math.min(60, Number(process.argv[2]) || 7));
  const db = new Database();
  await db.initialize();
  const report = await new YieldStats(db).report(days);
  console.log(`Dark History report since ${report.since}`);
  console.log('\nJOBS (day source completed failed)');
  for (const row of report.jobs) console.log(`${row.day} ${row.source.padEnd(9)} ${row.completed} ${row.failed}  (${Math.round(100 * row.completed / row.jobs)} %)`);
  console.log('\nMODELS (day role model ok failed timeout empty 429)');
  for (const row of report.models) console.log(`${row.day} ${row.role.padEnd(9)} ${row.model.padEnd(52)} ${row.ok} ${row.failed} ${row.timeout} ${row.empty} ${row.rate_limited}`);
  console.log('\nREJECTION CAUSES (day n cause)');
  for (const row of report.causes) console.log(`${row.day} ${String(row.n).padStart(3)} ${row.cause}`);
  console.log('\nHOURLY CHECKS (hour attempts successes 429 queue cap throttled calls per provider)');
  for (const row of report.hourly || []) console.log(`${row.hour} ${row.attempts} ${row.successes} ${row.r429} ${row.queue} ${row.cap} ${row.throttled ? 'THROTTLED' : '-'} ${row.calls}`);
  process.exit(0);
})().catch(error => { console.error(error.message); process.exit(1); });
