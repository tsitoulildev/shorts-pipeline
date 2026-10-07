// Real-LLM check of the footage relevance judge on a small sample. RUN ON THE VM (the provider keys live in .env there):
//   node scripts/dark-history-judge-sample.js            (default sample: 4 stories, ~30 LLM calls)
//   node scripts/dark-history-judge-sample.js "Dyatlov Pass incident" "Mary Celeste"
// Writes data/dark-history-reports/judge-<timestamp>.md (+ .json) and contact-<timestamp>.html (every beat with its image and license). No keys are printed or stored; nothing is deployed or changed.
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { AITextService } = require('../utils/ai-text-service');
const { makeLlmJudge } = require('../utils/dark-history/relevance-judge');
const { planFootage } = require('../utils/dark-history/footage');
const { parseJsonResponse } = require('../utils/json-response');
const { contactSheetHtml } = require('../utils/dark-history/contact-sheet');

const DEFAULT_SAMPLE = ['Dyatlov Pass incident', 'Mary Celeste', 'Tunguska event', 'Hinterkaifeck murders'];

/**
 * Wraps the LLM so the report shows, per provider/model: calls, thrown errors (failed), answers that were not usable
 * (invalid = bad or cut-off JSON) and answers the provider itself cut at the token limit (truncated = finish reason
 * length/MAX_TOKENS). `failed`, `invalid` and `truncated` are separate counters. Sequential use only (llm.lastCall).
 */
function instrument(llm, isUsable = () => true) {
  const stats = { calls: 0, failed: 0, invalid: 0, truncated: 0, errors: [], invalidReplies: [], providers: {} };
  const row = call => {
    const key = `${call?.provider || 'unknown'} / ${call?.model || '?'}`;
    return stats.providers[key] || (stats.providers[key] = { calls: 0, failed: 0, invalid: 0, truncated: 0, finishReasons: {} });
  };
  return {
    stats,
    async generateText(prompt, options) {
      stats.calls += 1;
      llm.lastCall = null;
      try {
        const reply = await llm.generateText(prompt, options);
        const call = llm.lastCall;
        const entry = row(call);
        entry.calls += 1;
        const finish = String(call?.finishReason || 'unknown');
        entry.finishReasons[finish] = (entry.finishReasons[finish] || 0) + 1;
        if (/length|max_tokens/i.test(finish)) { stats.truncated += 1; entry.truncated += 1; }
        if (!isUsable(reply)) {
          stats.invalid += 1; entry.invalid += 1;
          if (stats.invalidReplies.length < 4) stats.invalidReplies.push({ provider: `${call?.provider || 'unknown'} / ${call?.model || '?'}`, finishReason: finish, maxTokens: options?.maxTokens, reply: String(reply).slice(0, 300) });
        }
        return reply;
      } catch (error) {
        stats.failed += 1;
        row(llm.lastCall).failed += 1;
        if (stats.errors.length < 5) stats.errors.push(String(error.message).slice(0, 160));
        throw error;
      }
    }
  };
}

async function sampleStory(title, llm) {
  const withoutJudge = await planFootage(title, {});
  const counted = instrument(llm, reply => Array.isArray(parseJsonResponse(reply)?.relevant));
  const rejected = [];
  const judge = async (beat, candidates, context) => {
    const approved = await makeLlmJudge(counted)(beat, candidates, context);
    const titles = new Set(approved.map(c => c.title));
    rejected.push({ beat: beat.heading, approved: approved.map(c => c.title), rejected: candidates.filter(c => !titles.has(c.title)).map(c => c.title) });
    return approved;
  };
  const withJudge = await planFootage(title, { judge });
  return {
    title,
    editorPlacedOnly: { eligible: withoutJudge.eligible, beats: withoutJudge.beats.length },
    withJudge: { eligible: withJudge.eligible, beats: withJudge.beats.length, reason: withJudge.reason, shareAlike: withJudge.shareAlike },
    beats: withJudge.beats.map(b => ({ heading: b.heading, text: b.text, unused: b.unused, images: b.images.map(i => ({ title: i.title, license: i.license, author: i.author, fileUrl: i.fileUrl, descriptionUrl: i.descriptionUrl, source: i.owned ? 'editor-placed' : 'LLM-approved', confidence: i.confidence, confidenceNotes: i.confidenceNotes })) })),
    diagnostics: withJudge.diagnostics, judged: rejected, llm: counted.stats
  };
}

/** Measured (not estimated) LLM calls: per story and per provider/model across the whole run. */
function totalsSection(results) {
  const totals = {};
  for (const r of results) {
    for (const [name, p] of Object.entries(r.llm.providers)) {
      const t = totals[name] || (totals[name] = { calls: 0, failed: 0, invalid: 0, truncated: 0 });
      for (const key of Object.keys(t)) t[key] += p[key];
    }
  }
  const all = results.reduce((sum, r) => sum + r.llm.calls, 0);
  return [
    '## Measured LLM calls (counted, not estimated)',
    ...results.map(r => `- ${r.title}: ${r.llm.calls} calls (${r.llm.failed} threw, ${r.llm.invalid} invalid, ${r.llm.truncated} cut at the token limit)`),
    `- all stories: ${all} calls`,
    ...Object.entries(totals).map(([name, t]) => `- by provider ${name}: ${t.calls} answers, ${t.failed} threw, ${t.invalid} invalid, ${t.truncated} truncated`),
    ''
  ];
}

function toMarkdown(results) {
  const lines = ['# Dark History judge sample', `Run at ${new Date().toISOString()}`, '', ...totalsSection(results)];
  for (const r of results) {
    lines.push(`## ${r.title}`, `- editor-placed images only: eligible=${r.editorPlacedOnly.eligible} (${r.editorPlacedOnly.beats} beats)`,
      `- with the LLM judge: eligible=${r.withJudge.eligible} (${r.withJudge.beats} beats, ${r.withJudge.reason}), shareAlike=${r.withJudge.shareAlike}`,
      `- LLM calls: ${r.llm.calls}; failed (threw): ${r.llm.failed}; invalid answers (bad/cut JSON): ${r.llm.invalid}; cut by the provider at the token limit: ${r.llm.truncated}${r.llm.errors.length ? ` (errors: ${r.llm.errors.join(' | ')})` : ''}`,
      ...Object.entries(r.llm.providers).map(([name, p]) => `  - ${name}: ${p.calls} answers, ${p.failed} threw, ${p.invalid} invalid, ${p.truncated} truncated; finish reasons ${JSON.stringify(p.finishReasons)}`),
      ...r.llm.invalidReplies.map(x => `  - invalid reply from ${x.provider} (finish ${x.finishReason}, maxTokens ${x.maxTokens}): ${JSON.stringify(x.reply)}`), '', 'Final footage (CHECK THESE BY EYE: does each image fit its beat?):');
    for (const b of r.beats) lines.push(`- ${b.heading}: ${b.images.map(i => `${i.title} [${i.license}, ${i.source}${i.confidence === 'low' ? `, LOW CONFIDENCE: ${i.confidenceNotes.join(' / ')}` : ''}]`).join('; ')}`);
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
  fs.writeFileSync(path.join(dir, `contact-${stamp}.html`), contactSheetHtml(results));
  console.log(toMarkdown(results));
  console.log(`\nReport saved: data/dark-history-reports/judge-${stamp}.md`);
}

if (require.main === module) main().then(() => process.exit(0), error => { console.error(error.message); process.exit(1); }); // exit: open provider handles kept the process alive
module.exports = { instrument, toMarkdown };
