// Fact-check gate for a Dark History script: every narrated claim must map to a sentence of the story's
// source text (the Wikipedia extract fetched in phase 1). Anything else rejects the script. Never lowered.
//
// Script shape: { title, beats: [{ narration, evidence: ["verbatim source sentence", ...] }] }, one beat per footage beat.
// 1-4 are deterministic and free; 5 asks the free LLM whether the passage supports each sentence and FAILS CLOSED.

const norm = text => String(text || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
const sentencesOf = text => String(text || '').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
const NUMBER_WORDS = /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|dozen)\b/gi;
const MIN_EVIDENCE_WORDS = 5;

const digits = text => (String(text).match(/\d[\d,.]*\d|\d/g) || []).map(n => n.replace(/[,.]+$/, ''));

/** Capitalised words that are not the first word of a sentence: names and places the source must contain. */
function properNouns(narration) {
  const out = [];
  for (const sentence of sentencesOf(narration)) {
    const found = sentence.split(/\s+/).slice(1).map(w => w.replace(/^[("']+|[)"',.;:!?]+$/g, '')).filter(w => /^[A-Z][a-z]/.test(w));
    out.push(...found.map(w => w.replace(/'s$/, '')));
  }
  return [...new Set(out)];
}

/** Deterministic checks. Returns { passed, issues[] } (issues name the beat and the offending text). */
function checkFactsDeterministic(script, story) {
  const issues = [];
  const beats = story.plan.beats;
  const extract = norm(story.plan.extract);
  if (!Array.isArray(script.beats) || script.beats.length !== beats.length) {
    return { passed: false, issues: [`script has ${script.beats?.length ?? 0} beats, the footage has ${beats.length}; write exactly one beat per footage beat`] };
  }
  script.beats.forEach((beat, index) => {
    const label = `beat ${index + 1}`;
    const passage = norm(beats[index].text);
    const narration = String(beat.narration || '');
    const evidence = (Array.isArray(beat.evidence) ? beat.evidence : []).map(String);
    if (!narration.trim()) { issues.push(`${label}: empty narration`); return; }
    if (!evidence.length) { issues.push(`${label}: no evidence sentences`); return; }

    // 1. every evidence sentence is verbatim in the source (this beat's passage first, the whole article otherwise)
    const proven = evidence.filter(e => norm(e).split(' ').length >= MIN_EVIDENCE_WORDS && (passage.includes(norm(e)) || extract.includes(norm(e))));
    evidence.filter(e => !proven.includes(e)).forEach(e => issues.push(`${label}: evidence not found verbatim in the source: "${e.slice(0, 80)}"`));
    const evidenceText = norm(proven.join(' '));

    // 2. numbers, years and spelled-out amounts must come from the evidence
    for (const n of digits(narration)) if (!digits(evidenceText).includes(n)) issues.push(`${label}: number "${n}" is not in its evidence`);
    for (const w of narration.match(NUMBER_WORDS) || []) if (!new RegExp(`\\b${w}\\b`, 'i').test(evidenceText)) issues.push(`${label}: amount "${w}" is not in its evidence`);

    // 3. names and places must exist somewhere in the source article
    for (const noun of properNouns(narration)) if (!extract.includes(norm(noun))) issues.push(`${label}: "${noun}" does not appear in the source`);

    // 4. quoted speech must be quoted from the source
    for (const quote of narration.match(/"([^"]{3,})"/g) || []) if (!extract.includes(norm(quote.slice(1, -1)))) issues.push(`${label}: invented quotation ${quote.slice(0, 60)}`);
  });
  return { passed: issues.length === 0, issues };
}

function verifierPrompt(script, story) {
  const blocks = script.beats.map((beat, i) => {
    const lines = sentencesOf(beat.narration).map((s, j) => `  ${i + 1}.${j + 1} ${s}`).join('\n');
    return `PASSAGE ${i + 1}: ${story.plan.beats[i].text.slice(0, 900)}\nNARRATION ${i + 1}:\n${lines}`;
  }).join('\n\n');
  return `You are a strict fact-checker. For each narration sentence decide whether its PASSAGE states it or directly entails it.
A sentence that adds a detail, cause, motive, emotion, number, name or certainty the passage does not contain is UNSUPPORTED. A theory stated as fact is UNSUPPORTED; a theory attributed to someone is fine.

${blocks}

Return JSON {"unsupported":["1.2","3.1"]} listing the unsupported sentence ids; an empty list means everything is supported.`;
}

/**
 * checkFacts(script, story, { verify }) -> { passed, issues[] }. `verify(prompt)` returns the model's reply text (the free LLM);
 * with no verifier or on any error the script is NOT passed: unverified is not true.
 */
async function checkFacts(script, story, { verify, parseJson } = {}) {
  const deterministic = checkFactsDeterministic(script, story);
  if (!deterministic.passed) return deterministic;
  if (typeof verify !== 'function') return { passed: false, issues: ['no LLM verifier available: the claims could not be checked'] };
  try {
    const parsed = parseJson(await verify(verifierPrompt(script, story)));
    if (!Array.isArray(parsed?.unsupported)) return { passed: false, issues: ['fact verifier returned an unusable answer'] };
    const issues = parsed.unsupported.map(id => {
      const [b, s] = String(id).split('.').map(Number);
      const sentence = sentencesOf(script.beats[b - 1]?.narration)[s - 1];
      return `beat ${b}: the source does not support "${String(sentence || id).slice(0, 100)}"`;
    });
    return { passed: issues.length === 0, issues };
  } catch (error) {
    return { passed: false, issues: [`fact verifier unavailable (${String(error.message).slice(0, 80)}): the claims could not be checked`] };
  }
}

module.exports = { checkFacts, checkFactsDeterministic, verifierPrompt, properNouns, sentencesOf, norm };
