// End-to-end Dark History Short for ONE story, locally, NO upload. RUN ON THE VM (keys live in .env there):
//   DARK_HISTORY_PRODUCTION_ENABLED=true node scripts/dark-history-produce.js "Mary Celeste"
// Steps: Wikipedia + Commons footage (LLM relevance judge) -> download -> grounded script + fact-check -> narration (existing free TTS)
// -> Ken Burns render -> thumbnail -> documentary gate. Output: data/dark-history-output/<title>/ (video, thumbnail, report.md).
// Refuses to run without DARK_HISTORY_PRODUCTION_ENABLED=true; never touches the database, the scheduler or YouTube.
const fs = require('fs');
const path = require('path');
require('dotenv').config();

async function main() {
  if (process.env.DARK_HISTORY_PRODUCTION_ENABLED !== 'true') {
    console.error('Set DARK_HISTORY_PRODUCTION_ENABLED=true to run this (it is off by default).');
    process.exit(2);
  }
  const { AITextService } = require('../utils/ai-text-service');
  const { AIVideoGenerator } = require('../utils/ai-video-generator');
  const { makeLlmJudge } = require('../utils/dark-history/relevance-judge');
  const { planFootage } = require('../utils/dark-history/footage');
  const { attributionText } = require('../utils/dark-history/attribution');
  const { downloadImage } = require('../utils/dark-history/commons');
  const { vetArticle } = require('../utils/dark-history/event-vetting');
  const { writeGroundedScript } = require('../utils/dark-history/grounded-writer');
  const { produceDocumentaryShort } = require('../utils/dark-history/produce');

  const title = process.argv[2] || 'Mary Celeste';
  const llm = new AITextService({});
  const plan = await planFootage(title, { judge: makeLlmJudge(llm) });
  const vet = vetArticle(plan.article);
  console.log(`Footage: eligible=${plan.eligible} (${plan.reason}); vetting: ${vet.ok} (${vet.reason})`);
  if (!plan.eligible || !vet.ok) return;

  const outDir = path.join(__dirname, '..', 'data', 'dark-history-output', plan.article.title.replace(/[^a-z0-9]+/gi, '_'));
  const folder = path.join(outDir, 'images');
  for (const beat of plan.beats) beat.images = await Promise.all(beat.images.map(image => downloadImage(image, folder)));
  const story = {
    article_url: plan.article.url, revision_id: plan.article.revisionId, attribution: attributionText(plan.article, plan.beats),
    plan: { title: plan.article.title, extract: plan.article.extract, folder, beats: plan.beats }
  };

  const script = await writeGroundedScript({ story, llm, logger: console });
  const video = new AIVideoGenerator({});
  const result = await produceDocumentaryShort({ story, script, workDir: outDir, narrate: (text, out) => video.generateTTSAudio(text, out) });

  const report = [
    `# ${script.title}`, '', `Gate: ${result.gate.passed ? 'PASSED' : 'FAILED'}`,
    ...result.gate.checks.map(c => `- ${c.passed ? 'ok  ' : 'FAIL'} ${c.id}: ${c.message}`), '',
    `Video: ${result.videoPath} (${result.video.width}x${result.video.height}, ${result.video.duration.toFixed(1)} s)`, `Thumbnail: ${result.thumbnailPath}`, '',
    '## Script', ...script.beats.map((b, i) => `${i + 1}. ${b.narration}  [${b.images.map(x => x.title).join('; ')}]`), '', '## Description', result.seo.description
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'report.md'), report);
  console.log(report);
}

main().catch(error => { console.error(error.message); process.exit(1); });
