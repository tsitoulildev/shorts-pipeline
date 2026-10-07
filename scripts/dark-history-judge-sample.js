// Real-LLM check of the footage relevance judge on a small sample. RUN ON THE VM (the provider keys live in .env there):
//   node scripts/dark-history-judge-sample.js            (default sample: 4 stories, ~30 LLM calls)
//   node scripts/dark-history-judge-sample.js "Dyatlov Pass incident" "Mary Celeste"
// Writes data/dark-history-reports/judge-<timestamp>.md (+ .json). No keys are printed or stored; nothing is deployed or changed.
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { AITextService } = require('../utils/ai-text-service');
const { makeLlmJudge } = require('../utils/dark-history/relevance-judge');
const { planFootage } = require('../utils/dark-history/footage');

const DEFAULT_SAMPLE = ['Dyatlov Pass incident', 'Mary Celeste', 'Tunguska event', 'Hinterkaifeck murders'];

/** Wraps the LLM so the report can show how many calls ran, how many failed and what a reply looks like. */
function instrument(llm) {
  const stats = { calls: 0, failed: 0, errors: [], sampleReplies: [] };
  return {
    stats,
    async generateText(prompt, options) {
      stats.calls += 1;
      try {
        const reply = await llm.generateText(prompt, options);
        if (stats.sampleReplies.length < 3) stats.sampleReplies.push(String(reply).slice(0, 160));
        return reply;
      } catch (error) {
        stats.failed += 1;
        if (stats.errors.length < 5) stats.errors.push(String(error.message).slice(0, 160));
        throw error;
      }
    }
  };
}

async function sampleStory(title, llm) {
  const withoutJudge = await planFootage(title, {});
  const counted = instrument(llm);
  const rejected = [];
  const judge = async (beat, candidates) => {
    const approved = await makeLlmJudge(counted)(beat, candidates);
    const titles = new Set(approved.map(c => c.title));
    rejected.push({ beat: beat.heading, approved: approved.map(c => c.title), rejected: candidates.filter(c => !titles.has(c.title)).map(c => c.title) });
    return approved;
  };
  const withJudge = await planFootage(title, { judge });
  return {
    title,
    editorPlacedOnly: { eligible: withoutJudge.eligible, beats: withoutJudge.beats.length },
    withJudge: { eligible: withJudge.eligible, beats: withJudge.beats.length, reason: withJudge.reason, shareAlike: withJudge.shareAlike },
    beats: withJudge.beats.map(b => ({ heading: b.heading, images: b.images.map(i => ({ title: i.title, license: i.license, source: i.owned ? 'editor-placed' : 'LLM-approved' })) })),
    judged: rejected, llm: counted.stats
  };
}

function toMarkdown(results) {
  const lines = ['# Dark History judge sample', `Run at ${new Date().toISOString()}`, ''];
  for (const r of results) {
    lines.push(`## ${r.title}`, `- editor-placed images only: eligible=${r.editorPlacedOnly.eligible} (${r.editorPlacedOnly.beats} beats)`,
      `- with the LLM judge: eligible=${r.withJudge.eligible} (${r.withJudge.beats} beats, ${r.withJudge.reason}), shareAlike=${r.withJudge.shareAlike}`,
      `- LLM calls: ${r.llm.calls}, failed: ${r.llm.failed}${r.llm.errors.length ? ` (${r.llm.errors.join(' | ')})` : ''}`,
      `- sample replies: ${r.llm.sampleReplies.map(x => JSON.stringify(x)).join(' ; ') || 'none'}`, '', 'Final footage (CHECK THESE BY EYE: does each image fit its beat?):');
    for (const b of r.beats) lines.push(`- ${b.heading}: ${b.images.map(i => `${i.title} [${i.license}, ${i.source}]`).join('; ')}`);
    lines.push('', 'What the judge approved / rejected per beat:');
    for (const j of r.judged) lines.push(`- ${j.beat}: approved ${j.approved.length ? j.approved.join('; ') : 'none'} | rejected ${j.rejected.join('; ') || 'none'}`);
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  const titles = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_SAMPLE;
  const llm = new AITextService({});
  const results = [];
  for (const title of titles) {
    try { results.push(await sampleStory(title, llm)); } catch (error) { console.error(`${title}: ${error.message}`); }
  }
  const dir = path.join(__dirname, '..', 'data', 'dark-history-reports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(dir, `judge-${stamp}.json`), JSON.stringify(results, null, 1));
  fs.writeFileSync(path.join(dir, `judge-${stamp}.md`), toMarkdown(results));
  console.log(toMarkdown(results));
  console.log(`\nReport saved: data/dark-history-reports/judge-${stamp}.md`);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exit(1); });
module.exports = { instrument, toMarkdown };
