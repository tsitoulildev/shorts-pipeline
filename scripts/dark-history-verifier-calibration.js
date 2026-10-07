// Calibration of the fact verifier with the REAL free LLM (RUN ON THE VM, keys live in .env there):
//   node scripts/dark-history-verifier-calibration.js ["Mary Celeste" "Tunguska event" ...] [--rounds=3]
// For each story it builds (a) a FAITHFUL script from verbatim source sentences, which the verifier must accept, and
// (b) a MUTATED script where every beat gets one invented sentence (a motive, a certainty, an emotion, no names or numbers,
// so only the LLM can catch it), which the verifier must flag. Prints false rejections and misses; changes nothing.
require('dotenv').config();
const { AITextService } = require('../utils/ai-text-service');
const { planFootage } = require('../utils/dark-history/footage');
const { checkFacts, sentencesOf } = require('../utils/dark-history/fact-check');
const { parseJsonResponse } = require('../utils/json-response');

const words = s => s.split(/\s+/).length;
const INVENTED = [
  'The crew had been terrified of the sea for months.',
  'Experts agree this proves the whole affair was cursed.',
  'It remains the most shocking mystery ever recorded.',
  'The leader secretly planned everything from the start.',
  'Everyone who heard about it was filled with dread.',
  'Locals said it was clearly the work of a vengeful spirit.',
  'Nobody ever dared to speak of it again.'
];

function faithfulScript(beats) {
  return beats.map(beat => {
    const sentence = sentencesOf(beat.text).filter(s => words(s) >= 12 && words(s) <= 30 && !/[;–—"]/.test(s)).sort((a, b) => words(a) - words(b))[0];
    return sentence ? { narration: sentence, evidence: [sentence] } : null;
  });
}

async function main() {
  const titles = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const rounds = Number((process.argv.find(a => a.startsWith('--rounds=')) || '--rounds=2').split('=')[1]);
  const llm = new AITextService({});
  let lastReply = '';
  const verify = async prompt => { lastReply = await llm.generateText(prompt, { task: 'packaging', maxTokens: 400, temperature: 0, responseMimeType: 'application/json' }); return lastReply; };
  const totals = { faithful: 0, faithfulRejected: 0, invented: 0, inventedCaught: 0, collateral: 0, unusable: 0 };
  for (const title of titles.length ? titles : ['Mary Celeste', 'Tunguska event', 'Hinterkaifeck murders']) {
    const plan = await planFootage(title, {});
    const base = faithfulScript(plan.beats);
    const usable = plan.beats.map((beat, i) => ({ beat, item: base[i] })).filter(x => x.item);
    const story = { plan: { title: plan.article.title, extract: plan.article.extract, beats: usable.map(x => x.beat) } };
    const faithful = { beats: usable.map(x => ({ ...x.item })) };
    const mutated = { beats: usable.map((x, i) => ({ narration: `${x.item.narration} ${INVENTED[i % INVENTED.length]}`, evidence: x.item.evidence })) };
    for (let round = 1; round <= rounds; round += 1) {
      const a = await checkFacts(faithful, story, { verify, parseJson: parseJsonResponse });
      const b = await checkFacts(mutated, story, { verify, parseJson: parseJsonResponse });
      const flagged = new Set(b.issues.map(issue => (issue.match(/^beat (\d+)/) || [])[1]));
      const unusable = [a, b].filter(r => r.issues.some(i => /unusable|unavailable/.test(i))).length;
      if (unusable) console.log('  raw reply of an unusable answer: ' + JSON.stringify(lastReply).slice(0, 400) + ' via ' + JSON.stringify(llm.lastCall || null));
      totals.faithful += faithful.beats.length;
      totals.faithfulRejected += a.passed ? 0 : a.issues.filter(i => /^beat/.test(i)).length;
      totals.invented += mutated.beats.length;
      totals.inventedCaught += mutated.beats.filter((_, i) => flagged.has(String(i + 1))).length;
      totals.unusable += unusable;
      console.log(`${title} round ${round}: faithful ${a.passed ? 'ACCEPTED' : `REJECTED (${a.issues.length})`}; mutated flagged ${flagged.size}/${mutated.beats.length} beats`);
      if (!a.passed) console.log(`  faithful issues: ${a.issues.slice(0, 4).join(' | ').slice(0, 500)}`);
    }
  }
  console.log(`\nTOTAL: faithful sentences wrongly flagged ${totals.faithfulRejected}/${totals.faithful}; invented sentences caught ${totals.inventedCaught}/${totals.invented}; unusable/unavailable answers ${totals.unusable}`);
  process.exit(0);
}

main().catch(error => { console.error(error.message); process.exit(1); });
