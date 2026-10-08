// Calibration of the footage-fit check with the REAL vision models (RUN ON THE VM; the story pool is read from a snapshot, nothing is written):
//   VISION_ONLY=ministral node scripts/dark-history-footage-calibration.js <pool.db> [--rounds=3]
// scripts/fixtures/footage-fit-labels.json holds hand-labelled (story, picture) pairs: fits=true when the picture shows something the beat's own
// passage names or describes. Each story is judged exactly as in production (all its pictures in one request). Prints per round the pictures the
// model got wrong: a FALSE PASS (the model said fits, the label says it does not) lets an unusable picture through, a FALSE FAIL drops a good one.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { AITextService } = require('../utils/ai-text-service');
const { checkFootageFit } = require('../utils/dark-history/footage-fit');
const { makeVisionJudge } = require('../utils/dark-history/image-fit');

const labels = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'footage-fit-labels.json'), 'utf8')).cases;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const dbPath = process.argv.find(arg => arg.endsWith('.db'));
  const rounds = Number((process.argv.find(arg => arg.startsWith('--rounds=')) || '--rounds=3').split('=')[1]);
  const pauseMs = Number(process.env.PAUSE_MS || 12000); // free vision plans are rate limited: spread the requests
  const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
  const rows = await new Promise((resolve, reject) => db.all("SELECT title, plan FROM story_pool WHERE status = 'ready'", (e, r) => (e ? reject(e) : resolve(r))));
  db.close();
  const stories = [...new Set(labels.map(item => item.story))].map(title => {
    const row = rows.find(r => r.title === title);
    if (!row) throw new Error(`story "${title}" is not in the pool snapshot`);
    return { title, plan: JSON.parse(row.plan) };
  });
  const judge = makeVisionJudge(new AITextService({}));
  if (!judge) throw new Error('no vision model is configured (VISION_ONLY=...)');
  console.log(`judge chain: ${judge.providers.join(' > ')}`);
  let total = 0; let falsePass = 0; let falseFail = 0; let unchecked = 0;
  for (let round = 1; round <= rounds; round += 1) {
    for (const story of stories) {
      let result;
      try {
        result = await checkFootageFit({ story: { plan: story.plan }, judge });
      } catch (error) {
        unchecked += 1;
        console.log(`round ${round} ${story.title}: UNCHECKED ${String(error.message).slice(0, 100)}`);
        await sleep(pauseMs * 3);
        continue;
      }
      const kept = new Set(result.keptBeats.flatMap(index => story.plan.beats[index].images.filter(image => result.keptImages.get(index).includes(image)).map(image => image.title)));
      for (const item of labels.filter(entry => entry.story === story.title)) {
        total += 1;
        const said = kept.has(item.image);
        if (said && !item.fits) { falsePass += 1; console.log(`round ${round} FALSE PASS  ${story.title}: ${item.image}`); }
        if (!said && item.fits) { falseFail += 1; console.log(`round ${round} FALSE FAIL  ${story.title}: ${item.image}`); }
      }
      await sleep(pauseMs);
    }
  }
  const good = labels.filter(item => item.fits).length * rounds;
  const bad = labels.filter(item => !item.fits).length * rounds;
  console.log(`\nTOTAL ${judge.lastProvider || judge.providers[0]}: ${total} judgements over ${rounds} rounds (${unchecked} story checks failed to run); FALSE PASS (unusable picture let through) ${falsePass}/${bad}; FALSE FAIL (good picture dropped) ${falseFail}/${good}`);
  process.exit(0);
}

main().catch(error => { console.error(error.message); process.exit(1); });
