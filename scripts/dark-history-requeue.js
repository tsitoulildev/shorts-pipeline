// Stories parked in quarantine that the changed writer may now manage, put back for ONE more attempt (same gates, nothing relaxed).
//   node scripts/dark-history-requeue.js            dry run: what would come back, nothing is written
//   node scripts/dark-history-requeue.js --apply    writes: status ready, attempts 1 (behind every untouched story, one failure before they are parked again)
// Tier A: the writer returned nothing usable (fixed by the evidence retry). Tier B: fact-check failed and richness >= 50, richest first. The rest stays parked.
require('dotenv').config();
const { Database } = require('../database/db');
const { StoryPool } = require('../utils/dark-history/story-pool');

const CALLS_PER_ATTEMPT = 10; // measured in dh_hourly: 3 attempts use 26-32 calls

(async () => {
  const apply = process.argv.includes('--apply');
  const db = new Database();
  await db.initialize();
  const pool = new StoryPool(db);
  const plan = await pool.requeueQuarantined({ apply });
  console.log(`${apply ? 'APPLIED' : 'DRY RUN (nothing written)'}: ${plan.quarantined} stories in quarantine`);
  console.log(`\nTier A, first (${plan.tierA.length}): the writer returned nothing usable`);
  for (const row of plan.tierA) console.log(`  ${String(row.richness).padStart(3)}  ${row.title}`);
  console.log(`\nTier B, later (${plan.tierB.length}): fact-check failed, richness >= 50, richest first`);
  for (const row of plan.tierB) console.log(`  ${String(row.richness).padStart(3)}  ${row.title}`);
  console.log(`\nStay parked: ${plan.stays}`);
  const attempts = plan.tierA.length + plan.tierB.length;
  console.log(`One more attempt each = ${attempts} attempts, about ${attempts * CALLS_PER_ATTEMPT} free-tier calls (the daily research budget is 300), spread over the days the scheduler needs for them.`);
  process.exit(0);
})().catch(error => { console.error(error.message); process.exit(1); });
