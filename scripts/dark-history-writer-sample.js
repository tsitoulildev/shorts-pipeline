// Real-LLM run of the grounded writer + fact-check on ONE story. RUN ON THE VM (keys live in .env there):
//   node scripts/dark-history-writer-sample.js "Mary Celeste"
// Prints the script, the fact-check trail and the description with the attribution. Changes nothing, publishes nothing.
require('dotenv').config();
const { AITextService } = require('../utils/ai-text-service');
const { makeLlmJudge } = require('../utils/dark-history/relevance-judge');
const { planFootage } = require('../utils/dark-history/footage');
const { attributionText } = require('../utils/dark-history/attribution');
const { writeGroundedScript } = require('../utils/dark-history/grounded-writer');
const { downloadImage } = require('../utils/dark-history/commons');
const path = require('path');

async function main() {
  const title = process.argv[2] || 'Mary Celeste';
  const llm = new AITextService({});
  const plan = await planFootage(title, { judge: makeLlmJudge(llm) });
  console.log(`Footage: eligible=${plan.eligible} (${plan.reason})`);
  if (!plan.eligible) return;
  // the vision check needs the pictures themselves
  const folder = path.join(__dirname, '..', 'data', 'dark-history-reports', 'sample-images', plan.article.title.replace(/[^a-z0-9]+/gi, '_'));
  for (const beat of plan.beats) beat.images = await Promise.all(beat.images.map(image => downloadImage(image, folder)));
  const story = { article_url: plan.article.url, plan: { title: plan.article.title, extract: plan.article.extract, folder, beats: plan.beats }, attribution: attributionText(plan.article, plan.beats) };
  try {
    const script = await writeGroundedScript({ story, llm, logger: console });
    console.log(`\nTITLE: ${script.title}\n`);
    script.beats.forEach((b, i) => console.log(`${i + 1}. [${b.images.map(x => x.title).join('; ')}]\n   ${b.narration}\n   evidence: ${b.evidence.join(' / ')}`));
    console.log(`\nReview: ${JSON.stringify(script.metadata.creativeReview.attempts)}\n\nDESCRIPTION:\n${script.description}`);
  } catch (error) {
    console.log(`REJECTED (nothing would be published): ${error.message}`);
  }
}

main().then(() => process.exit(0), error => { console.error(error.message); process.exit(1); }); // exit: open provider handles kept the process alive
