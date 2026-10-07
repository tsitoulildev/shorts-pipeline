/**
 * Creative review of a horror Short script, before any media is produced.
 *
 * Two independent judges: deterministic heuristics (always available, free, cliches,
 * hook shape, ending shape, filler words, spoken rhythm, repetition inside the script
 * and against the channel's recent Shorts) and an AI critic with a strict rubric.
 * A failing script goes back to the writer with concrete notes (bounded loop);
 * the verdict and its evidence are stored on the script and re-checked by QA.
 */
const MIN_OVERALL = Number(process.env.CREATIVE_MIN_OVERALL || 7);
const FLOORS = Object.freeze({ hook: 6.5, twist: 6, originality: 6 });
const MAX_REVISIONS = Math.max(0, Math.min(3, Number(process.env.CREATIVE_MAX_REVISIONS ?? 2)));

const OPENER_FILLER = /^\s*(hey|hi|hello|welcome|today|so[, ]|ok(ay)?[, ]|let me|have you ever|did you know|you won't believe|you wont believe|this is a true story|in this (video|short)|before we begin)/i;
const CLICHES = [
  /it was all a dream/i, /woke up (in|and|to)\b/i, /turned out to be a dream/i,
  /(call|calls|calling) (was )?coming from inside the house/i, /based on a true/i, /this really happened/i,
  /never (saw|heard from) (him|her|them) again/i, /and then (i|he|she|they) woke/i,
  /little did (i|he|she|they) know/i, /to this day/i, /some things are better left/i, /was never seen again/i
];
const GENERIC = ['something', 'somehow', 'strange', 'weird', 'creepy', 'scary', 'suddenly', 'terrifying', 'eerie', 'spooky', 'impossible detail'];
const EXPLAINERS = /\b(because|that's why|that is why|which meant|it turns out|it turned out|the reason)\b/i;

// Only the endings that are truly worn out. Familiar story structures (rules, a roommate who is wrong, a sound next door)
// are WELCOME: the editor wants fresh specific details inside a proven shape, not a new kind of physics.
const OVERUSED_TROPES = Object.freeze([
  'it was all a dream, or the narrator wakes up',
  'the narrator turns out to have been dead all along',
  'a creature simply appears in the last beat with no setup'
]);


/** What the independent editor will check, written for the script writer so it can write to pass the first time. */
function editorRubricForWriter() {
  return `EDITOR RUBRIC (an independent, skeptical editor reviews the script after you. It rejects when the overall score is below ${MIN_OVERALL}/10, or the hook is below ${FLOORS.hook}, the twist below ${FLOORS.twist}, or the originality below ${FLOORS.originality}. Most drafts score 5-7, so write to pass, not to be acceptable.)
- HOOK: 5-12 words that make a stranger ask a question: a specific rule, a person who is wrong in one small way, or a sound from where nobody is. Concrete and human, never a mundane glitch, never a feeling, never a vague word (something, strange, weird, creepy, suddenly). Beat 1 must NOT begin with the hook or a paraphrase of it; it begins with a new fact.
- ORIGINALITY: a familiar story shape is fine and is expected; what must be fresh is the person, the place and the one concrete detail that goes wrong. Avoid only these worn-out endings: ${OVERUSED_TROPES.join('; ')}. Every beat adds a new fact and a new image. No two beats describe the same thing and no phrase repeats.
- STORY (the editor rejects a catalogue of impossible things): the narrator is one specific person doing one ordinary thing for a reason (they want or need something). Each beat must follow from the one before it ("so", "but", "then", never just "and another strange thing"). The narrator reacts physically at least once and makes ONE choice (open, follow, answer, stay, look) that makes it worse. A script that only lists strange phenomena, with no person at risk and no consequence, scores 4 or less.
- TWIST: the last beat is one short disturbing image under 14 words, with no explanation (no "because", "it turns out", "the reason"). It must reuse an object, sound or number planted in the first two beats and show it differently, so the ending changes the meaning of the opening instead of just adding one more strange image.
- VOICE: sentences average under 12 words and none runs past 20 (end every sentence with a full stop, never chain clauses with commas), always complete (never end the hook or a beat mid-sentence), no digits, no quoted dialogue, no filler adverbs (quietly, softly, faintly, slowly, gently, eerily) and no special characters such as non-breaking hyphens.
- LENGTH PLAN (count your words before returning): hook 8-11 words; beat 1 at most 18 words; every other beat 16-24 words; 105-125 spoken words in total.
- SELF-CHECK: rate yourself honestly. If hook, tension, twist, originality or brand would be below 8, rewrite that part until it is truly 8 or higher, then return. Never inflate the scores.`;
}

const clamp = (value, min = 0, max = 10) => Math.min(max, Math.max(min, value));
const words = text => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, ' ').split(/\s+/).filter(Boolean);
const sentences = text => String(text || '').split(/(?<=[.!?…])\s+/).map(item => item.trim()).filter(Boolean);

function scriptParts(script) {
  const hook = String(script.hook?.text || script.hook || '').trim();
  const beats = (script.mainContent?.sections || []).map(section =>
    (Array.isArray(section.content) ? section.content : [section.content]).filter(Boolean).join(' ').trim()
  ).filter(Boolean);
  return { hook, beats, all: [hook, ...beats].filter(Boolean).join(' ') };
}

function trigrams(text) {
  const list = words(text);
  const out = [];
  for (let i = 0; i + 2 < list.length; i += 1) out.push(list.slice(i, i + 3).join(' '));
  return out;
}

/** Sentences (normalized) of recent Shorts, for cross-video template detection. */
function normalizedSentences(text) {
  return sentences(text).map(item => words(item).join(' ')).filter(item => item.split(' ').length >= 5);
}

const POLISH_TARGET = Number(process.env.SCRIPT_POLISH_TARGET) || 8.5;
const FILLER_ADVERBS = ['quietly', 'softly', 'faintly', 'silently', 'gently', 'eerily', 'ominously', 'slowly', 'quickly', 'firmly', 'ghostly', 'distantly', 'barely'];

function heuristicReview(script, history = []) {
  const { hook, beats, all } = scriptParts(script);
  const notes = [];
  const scores = {};

  // Hook: shape and honesty of the first line.
  const hookWords = words(hook);
  let hookScore = 10;
  if (OPENER_FILLER.test(hook)) { hookScore -= 4; notes.push('The hook opens with filler or a cliche; start on the anomaly itself.'); }
  if (hookWords.length < 5 || hookWords.length > 14) { hookScore -= 2; notes.push(`The hook is ${hookWords.length} words; it must be 5-12 spoken words.`); }
  if (hookWords.some(word => GENERIC.includes(word))) { hookScore -= 2; notes.push('The hook uses a vague word (strange, weird, something); name the concrete wrong detail.'); }
  scores.hook = clamp(hookScore);

  // Ending: an image, short, no explanation, no cliche.
  const last = beats[beats.length - 1] || '';
  const lastSentences = sentences(last);
  let twistScore = 10;
  if (words(last).length > 34) { twistScore -= 2; notes.push('The final beat is too long; end on one short disturbing image.'); }
  if (EXPLAINERS.test(last)) { twistScore -= 2; notes.push('The ending explains itself; remove the reasoning and show the image.'); }
  if (lastSentences.length && words(lastSentences[lastSentences.length - 1]).length > 16) { twistScore -= 1; notes.push('The last sentence is long; make it land in under 14 words.'); }
  const cliche = CLICHES.find(pattern => pattern.test(all));
  if (cliche) { twistScore -= 4; notes.push(`A horror cliche appears (${cliche.source.slice(0, 40)}); replace it with something specific to this story.`); }
  scores.twist = clamp(twistScore);

  // Specificity: generic fear words are filler, not fear.
  const generic = words(all).filter(word => GENERIC.includes(word)).length +
    (all.toLowerCase().match(/impossible detail/g) || []).length;
  scores.specificity = clamp(10 - (generic >= 4 ? 4 : generic === 3 ? 3 : generic === 2 ? 1.5 : 0));
  if (generic >= 2) notes.push(`${generic} vague words (strange/weird/something/suddenly); describe exactly what is wrong.`);

  // Repetition inside the script and against the channel's recent Shorts.
  const seen = new Map();
  for (const gram of trigrams(all)) seen.set(gram, (seen.get(gram) || 0) + 1);
  const internal = [...seen.values()].filter(count => count >= 2).length;
  const mine = new Set(normalizedSentences(all));
  let shared = 0;
  for (const previous of history) {
    for (const item of normalizedSentences(previous)) if (mine.has(item)) shared += 1;
  }
  let repetition = 10 - Math.min(3, internal) - Math.min(5, shared * 2);
  if (internal) notes.push('Phrases repeat inside the script; vary the wording.');
  if (shared) notes.push(`${shared} sentence(s) are copied from recent Shorts; write fresh lines for this story.`);
  scores.repetition = clamp(repetition);

  // Spoken rhythm: short sentences, nothing unreadable aloud.
  const all2 = sentences(all);
  const avg = all2.length ? words(all).length / all2.length : 0;
  let voice = 10;
  if (avg > 14) { voice -= 2; notes.push('Sentences are long for narration; keep them short and speakable.'); }
  if (/[;—–]/.test(all)) { voice -= 1; notes.push('Remove semicolons and dashes; narration is spoken, not read.'); }
  const runOns = all2.filter(sentence => words(sentence).length > 24);
  if (runOns.length) {
    voice -= Math.min(3, 1.5 * runOns.length);
    notes.push(`${runOns.length} sentence(s) run past 24 words with no full stop (for example "${runOns[0].slice(0, 70)}..."); split them into short sentences a narrator can breathe through.`);
  }
  const fillerAdverbs = words(all).filter(word => FILLER_ADVERBS.includes(word));
  if (fillerAdverbs.length >= 2) {
    voice -= Math.min(2, fillerAdverbs.length * 0.75);
    notes.push(`Filler adverbs (${[...new Set(fillerAdverbs)].join(', ')}) pad the narration; cut them and keep the concrete nouns and verbs.`);
  }
  // The visual style must never be spoken: "another stickman stood behind me" breaks the story.
  if (/\b(stick ?man|stick figure|stickmen|animation|cartoon|drawing)\b/i.test(all)) {
    voice -= 6;
    notes.push('The narration names the visual style (stickman, drawing, animation). The narrator is a person in the story; say "someone", "a figure" or "a man", never the art style.');
  }
  if (/[^\t\n\r\u0020-\u007E]/.test(all.replace(/[’‘“”]/g, ''))) { voice -= 1; notes.push('Unusual characters (non-breaking hyphens, symbols) can break the voice; use plain letters and full stops.'); }
  scores.voice = clamp(voice);

  const keys = ['hook', 'twist', 'specificity', 'repetition', 'voice'];
  const overall = keys.reduce((sum, key) => sum + scores[key], 0) / keys.length;
  return { scores, overall: Number(overall.toFixed(2)), notes, sharedSentences: shared };
}

function buildReviewPrompt(script, strategy = {}) {
  const { hook, beats } = scriptParts(script);
  return `You are a strict editor for a dark psychological horror Shorts channel (stickman visuals, 20-45 seconds, narrated).
Your only objective is to find what would make a viewer swipe away, so the writer can fix it. Judge this script like a skeptical viewer deciding in 1.5 seconds whether to keep watching. Most drafts deserve 5-7; give 9-10 only if you would be unable to improve it. Never praise, never rewrite the script yourself, and never lower or raise a score to be polite.

PREMISE: ${strategy.topic || ''}
INTENDED TWIST: ${strategy.payoff || ''}

HOOK: ${hook}
BEATS:
${beats.map((beat, index) => `${index + 1}. ${beat}`).join('\n')}

Score each from 1 to 10:
- hook: does the first line make an impossible-yet-ordinary detail land instantly?
- tension: does each beat raise the stakes, not repeat them? Is there a specific person at risk, and does each beat follow from the previous one by cause and effect? A list of unrelated impossible events with no character decision and no consequence is a catalogue, not a story: score tension 4 or less and twist 4 or less.
- twist: is the ending a fresh, disturbing image rather than an explanation or a known trope, AND does it reuse something planted in the opening so the viewer re-reads the start differently? An ending that is just one more strange image with no link to the opening scores 5 or less.
- originality: is the person, the place and the one wrong detail specific (a named object, a number, a time), rather than generic? A familiar story shape with fresh specific details is GOOD; only score originality low for worn-out endings (a dream, dead all along, a creature that just appears) or generic wording.
- visualizability: can one stickman in one frame show each beat without depicting injury or harm?
- voice: does it sound natural when one calm text-to-speech narrator reads it aloud (no quoted dialogue, digits or abbreviations, and the hook is spoken only once, not repeated inside beat 1)?

Return ONLY valid JSON:
{"scores":{"hook":0,"tension":0,"twist":0,"originality":0,"visualizability":0,"voice":0},"weaknesses":["specific problem"],"rewriteNotes":"2-4 concrete instructions for the writer (quote the weak lines)"}`;
}

function parseJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch (_error) { return null; }
}

function normalizeAiScores(parsed) {
  if (!parsed || typeof parsed.scores !== 'object') return null;
  const out = {};
  for (const key of ['hook', 'tension', 'twist', 'originality', 'visualizability', 'voice']) {
    const value = Number(parsed.scores[key]);
    if (!Number.isFinite(value) || value < 1 || value > 10) return null;
    out[key] = value;
  }
  return out;
}

/**
 * Review one script. `aiText` is the AITextService (or null); `history` is an array of
 * recent full scripts. Never throws: a failing AI call degrades to heuristics only,
 * and the evidence says so.
 */
async function reviewScript({ script, strategy = {}, aiText = null, history = [], logger = null }) {
  const heuristic = heuristicReview(script, history);
  let ai = null;
  let aiError = null;
  if (aiText && typeof aiText.isAvailable === 'function' && aiText.isAvailable()) {
    try {
      const response = await aiText.generateText(buildReviewPrompt(script, strategy), {
        maxTokens: 700, temperature: 0.2, responseMimeType: 'application/json'
      });
      const parsed = parseJson(response);
      const scores = normalizeAiScores(parsed);
      if (scores) {
        ai = {
          scores,
          weaknesses: Array.isArray(parsed.weaknesses) ? parsed.weaknesses.map(String).slice(0, 5) : [],
          rewriteNotes: String(parsed.rewriteNotes || '').slice(0, 600)
        };
      } else aiError = 'critic response was not a valid rubric';
    } catch (error) {
      aiError = String(error.message || error).slice(0, 200);
      logger?.warn?.(`Creative critic unavailable; using heuristics only: ${aiError}`);
    }
  }

  const scores = {
    hook: heuristic.scores.hook,
    twist: heuristic.scores.twist,
    originality: heuristic.scores.repetition,
    specificity: heuristic.scores.specificity,
    voice: heuristic.scores.voice
  };
  let overall = heuristic.overall;
  if (ai) {
    // Where both judges rate the same thing, the harsher one counts.
    scores.hook = Math.min(scores.hook, ai.scores.hook);
    scores.twist = Math.min(scores.twist, ai.scores.twist);
    scores.originality = Math.min(scores.originality, ai.scores.originality);
    scores.voice = Math.min(scores.voice, ai.scores.voice);
    scores.tension = ai.scores.tension;
    scores.visualizability = ai.scores.visualizability;
    const values = Object.values(scores);
    overall = values.reduce((sum, value) => sum + value, 0) / values.length;
  }
  overall = Number(overall.toFixed(2));

  const failures = [];
  if (overall < MIN_OVERALL) failures.push(`overall ${overall} is below ${MIN_OVERALL}`);
  for (const [key, floor] of Object.entries(FLOORS)) {
    if (scores[key] < floor) failures.push(`${key} ${scores[key]} is below ${floor}`);
  }
  const notes = [...heuristic.notes, ...(ai ? [...ai.weaknesses, ai.rewriteNotes] : [])].filter(Boolean);
  return {
    passed: failures.length === 0,
    overall,
    scores,
    failures,
    notes,
    source: ai ? 'ai+heuristic' : 'heuristic-only',
    aiError,
    reviewedAt: new Date().toISOString()
  };
}

/** Text appended to the writer prompt for a rewrite. */
function revisionBrief(review) {
  const lines = [`Previous draft scored ${review.overall}/10 (${review.failures.join('; ') || 'below target'}).`];
  for (const note of review.notes.slice(0, 6)) lines.push(`- ${note}`);
  lines.push('Rewrite the full script. Keep the approved premise and twist boundary, but fix every point above with fresh, specific lines.');
  return lines.join('\n');
}

/**
 * Bounded write -> review -> rewrite loop. `write(brief)` returns a script;
 * the best passing script is returned with its evidence on script.metadata.creativeReview.
 * If no attempt passes, throws CREATIVE_REVIEW_REJECTED so the job is skipped (fail closed).
 */
async function reviewedScriptLoop({ write, review, maxRevisions = MAX_REVISIONS, logger = null, polishTarget = POLISH_TARGET }) {
  const attempts = [];
  let brief = null;
  let best = null;
  let bestPassing = null;
  for (let attempt = 0; attempt <= maxRevisions; attempt += 1) {
    const script = await write(brief);
    if (attempt > 0 && best && String(script.fullScript || '') === String(best.script.fullScript || '')) {
      // The writer produced the identical script (no AI provider to take notes): stop instead of looping.
      attempts.push({ attempt: attempt + 1, overall: best.verdict.overall, passed: false, source: best.verdict.source, failures: ['rewrite produced the identical script'] });
      break;
    }
    const verdict = await review(script);
    attempts.push({ attempt: attempt + 1, overall: verdict.overall, passed: verdict.passed, source: verdict.source, failures: verdict.failures });
    logger?.info?.(`Creative review attempt ${attempt + 1}: ${verdict.overall}/10 [${verdict.source}${script.metadata?.generationSource ? `, writer ${script.metadata.generationSource}` : ''}] ${verdict.passed ? 'passed' : `rejected (${verdict.failures.join('; ')})`}`);
    // The editor's reasons are what decides whether the premise, the writer or the gate needs work; keep them in the log.
    if (!verdict.passed && Array.isArray(verdict.notes) && verdict.notes.length) {
      logger?.info?.(`Creative review notes for attempt ${attempt + 1}: ${verdict.notes.slice(0, 5).join(' || ').replace(/\s+/g, ' ').slice(0, 900)}`);
    }
    if (!best || verdict.overall > best.verdict.overall) best = { script, verdict };
    if (verdict.passed) {
      script.metadata = { ...(script.metadata || {}), creativeReview: { ...verdict, attempts, revisions: attempt } };
      if (!bestPassing || verdict.overall > bestPassing.verdict.overall) bestPassing = { script, verdict };
      // A pass is the floor, not the goal: while rewrites remain and the draft is only just good enough,
      // ask for a better one and keep the best passing draft. The gate itself is unchanged.
      if (verdict.overall >= polishTarget || attempt >= maxRevisions) break;
      logger?.info?.(`Draft passed at ${verdict.overall}/10, below the polish target ${polishTarget}; asking for a stronger rewrite (best so far is kept)`);
    }
    brief = revisionBrief(verdict);
  }
  if (bestPassing) {
    bestPassing.script.metadata = { ...(bestPassing.script.metadata || {}), creativeReview: { ...bestPassing.verdict, attempts, revisions: attempts.length - 1 } };
    return bestPassing.script;
  }
  // The job error is what the owner sees in the alert, so it names every attempt and why the loop
  // stopped (all revisions used, or the writer returned the same script and no rewrite was possible).
  const trail = attempts.map(item => `#${item.attempt} ${item.overall}/10 ${item.failures.join(', ') || 'no failures listed'}`).join(' | ');
  // A deterministic emergency script means the AI writer could not run (quota, provider error, contract); say so,
  // otherwise the alert only shows the low score of a script no AI wrote.
  const writerNote = best.script?.metadata?.generationSource === 'deterministic-fallback'
    ? ` (the AI writer failed and an emergency script was reviewed: ${String(best.script.metadata.fallbackReason || 'no reason recorded').slice(0, 200)})`
    : '';
  const editorNote = (best.verdict.notes || []).filter(Boolean)[0];
  const editorText = editorNote ? ` (editor: ${String(editorNote).replace(/\s+/g, ' ').slice(0, 160)})` : '';
  const error = new Error(`Creative review rejected the script after ${attempts.length} attempt(s): ${best.verdict.failures.join('; ') || 'no revision possible'} [${trail}]${writerNote}${editorText}`);
  error.code = 'CREATIVE_REVIEW_REJECTED';
  error.attempts = attempts;
  throw error;
}

/** QA decision on stored evidence, re-run on the stored script so it cannot be forged by metadata alone. */
function evaluateStoredReview(script, history = []) {
  const evidence = script?.metadata?.creativeReview;
  if (!evidence || evidence.passed !== true || !Number.isFinite(Number(evidence.overall))) {
    return { passed: false, message: 'The script carries no passing creative review' };
  }
  const recheck = heuristicReview(script, history);
  if (recheck.overall < MIN_OVERALL - 1.5 || recheck.scores.hook < FLOORS.hook - 1.5 || recheck.scores.twist < FLOORS.twist - 1.5) {
    return { passed: false, message: `The stored script no longer matches its review (heuristic ${recheck.overall}/10 on re-check)` };
  }
  return {
    passed: true,
    message: `Creative review ${evidence.overall}/10 via ${evidence.source} after ${evidence.revisions || 0} revision(s)`
  };
}

module.exports = {
  MIN_OVERALL, FLOORS, MAX_REVISIONS, OVERUSED_TROPES, editorRubricForWriter, heuristicReview, buildReviewPrompt, parseJson, normalizeAiScores,
  reviewScript, revisionBrief, reviewedScriptLoop, evaluateStoredReview, normalizedSentences
};
