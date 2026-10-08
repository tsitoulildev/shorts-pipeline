// Writer yield per story (RUN ON THE VM; the story pool is read from a snapshot, nothing is written, nothing is published):
//   GEMINI_API_KEY= node scripts/dark-history-writer-yield.js <pool.db> "Title A,Title B,..." [--runs=2] [--no-repair]
// Runs the grounded writer (fact-check, verifier, prose) several times per story with the picture check stubbed to "fits", so the number measures
// the writer alone. Prints, per story: runs that produced a script, attempts used, and how often the repair by deletion did the work.
// Use an empty GEMINI_API_KEY to keep Gemini (the old system's quota) out of the experiment: text then goes to Groq / NVIDIA / Mistral.
require('dotenv').config();
const sqlite3 = require('sqlite3');
const { AITextService } = require('../utils/ai-text-service');
const { writeGroundedScript } = require('../utils/dark-history/grounded-writer');

const fit = { judge: async () => JSON.stringify({ mismatch: [] }), readImage: async () => ({ mimeType: 'image/jpeg', data: 'AAAA' }) };

async function main() {
  const dbPath = process.argv.find(arg => arg.endsWith('.db'));
  const titles = (process.argv.find(arg => !arg.startsWith('--') && !arg.endsWith('.db') && arg.includes(',')) || '').split(',').filter(Boolean);
  const runs = Number((process.argv.find(arg => arg.startsWith('--runs=')) || '--runs=2').split('=')[1]);
  const repair = !process.argv.includes('--no-repair');
  const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
  const rows = await new Promise((resolve, reject) => db.all("SELECT title, article_url, plan, attribution FROM story_pool WHERE status = 'ready'", (e, r) => (e ? reject(e) : resolve(r))));
  db.close();
  const llm = new AITextService({});
  let passed = 0; let total = 0;
  console.log(`writer yield, repair ${repair ? 'ON' : 'OFF'}, ${runs} runs per story`);
  for (const title of titles) {
    const row = rows.find(r => r.title === title);
    if (!row) { console.log(`${title}: not in the pool snapshot`); continue; }
    const story = { article_url: row.article_url, plan: JSON.parse(row.plan), attribution: row.attribution };
    let ok = 0; const attempts = []; let repaired = 0; const narrated = [];
    for (let i = 0; i < runs; i += 1) {
      total += 1;
      try {
        const script = await writeGroundedScript({ story, llm, imageFit: fit, repair });
        ok += 1; passed += 1; attempts.push(script.metadata.creativeReview.attempts.length);
        if (script.metadata.creativeReview.repairedByDeletion) repaired += 1;
        narrated.push(script.beats.length);
      } catch (error) { attempts.push('X'); }
    }
    console.log(`${title}: ${ok}/${runs} produced a script; attempts ${attempts.join(',')}; repaired by deletion in ${repaired} of them; narrated beats ${narrated.join(',') || '-'}`);
  }
  console.log(`\nTOTAL ${passed}/${total} runs produced a script (${titles.length} stories, repair ${repair ? 'ON' : 'OFF'})`);
  process.exit(0);
}

main().catch(error => { console.error(error.message); process.exit(1); });
