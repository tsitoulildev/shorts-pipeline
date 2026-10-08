// Re-checks the READY stories of a story pool with the footage-fit check (RUN ON THE VM, read-only): the database is opened read-only, nothing is
// stored, no story is claimed or changed.
//   VISION_ONLY=mistral node scripts/dark-history-pool-recheck.js [path/to/youtube_automation.db]
// Prints, per story, how many pictures were looked at, which beats keep a fitting picture, which fall and why, and whether the story still
// has the 4 beats it needs. Ends with the count of stories that pass.
require('dotenv').config();
const path = require('path');
const sqlite3 = require('sqlite3');
const { AITextService } = require('../utils/ai-text-service');
const { checkFootageFit, MIN_BEATS } = require('../utils/dark-history/footage-fit');
const { makeVisionJudge } = require('../utils/dark-history/image-fit');

const dbPath = process.argv[2] || path.join(__dirname, '..', 'data', 'youtube_automation.db');

const rows = sql => new Promise((resolve, reject) => {
  const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
  db.all(sql, (error, result) => { db.close(); if (error) reject(error); else resolve(result); });
});

async function main() {
  const judge = makeVisionJudge(new AITextService({}));
  if (!judge) throw new Error('no vision model is configured');
  const stories = (await rows("SELECT title, plan, created_at FROM story_pool WHERE status = 'ready' ORDER BY created_at")).map(row => ({ title: row.title, plan: JSON.parse(row.plan) }));
  let passing = 0;
  const failures = [];
  for (const story of stories) {
    try {
      const result = await checkFootageFit({ story: { plan: story.plan }, judge });
      const ok = result.keptBeats.length >= MIN_BEATS;
      if (ok) passing += 1;
      console.log(`${ok ? 'PASS' : 'FAIL'} ${story.title}: ${result.keptBeats.length} of ${story.plan.beats.length} beats keep a fitting picture${result.dropped.length ? `; fall: ${result.dropped.map(item => `${item.heading} (${item.reason})`).join('; ')}` : ''}`);
    } catch (error) {
      failures.push(story.title);
      console.log(`UNCHECKED ${story.title}: ${String(error.message).slice(0, 140)}`);
    }
  }
  console.log(`\n${passing} of ${stories.length} ready stories pass the footage fit (${failures.length} could not be checked)`);
  process.exit(0);
}

main().catch(error => { console.error(error.message); process.exit(1); });
