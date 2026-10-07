// Grounded writer for Dark History: narrates ONLY facts present in the story's source passages, one beat per
// footage beat. The existing bounded write -> review -> rewrite loop (creative-review.js) is reused; the review
// is the fact-check gate plus a documentary prose check. Nothing here lowers a gate or touches the fiction path.
const { reviewedScriptLoop } = require('../creative-review');
const { parseJsonResponse } = require('../json-response');
const { checkFacts, sentencesOf } = require('./fact-check');

const WORDS = { min: 85, max: 135 };
const PASS_SCORE = 7;
const ART_STYLE = /\b(stick ?man|stick figure|stickmen|animation|cartoon|drawing)\b/i;
const YT_DESCRIPTION_LIMIT = 4900;

const wordCount = text => String(text || '').split(/\s+/).filter(Boolean).length;

function buildPrompt(story, brief, previous = null) {
  const beats = story.plan.beats.map((beat, i) => `BEAT ${i + 1} (${beat.heading}). On screen: ${beat.images.map(img => img.title.replace(/\.(jpe?g|png)$/i, '')).join('; ')}\nSOURCE PASSAGE: ${beat.text.slice(0, 1800)}`).join('\n\n');
  return `You write a 35-45 second true-story narration for a YouTube Short about "${story.plan.title}". It must be accurate, plain and gripping.

HARD RULES (a fact-checker rejects the whole script if one is broken):
- Write exactly ${story.plan.beats.length} beats, one per source passage below, in order. 14-26 spoken words per beat, ${WORDS.min}-${WORDS.max} words in total.
- Narrate ONLY what that beat's SOURCE PASSAGE states. No invented detail, emotion, motive, dialogue, name, number or place. A theory must be attributed ("investigators suspected...").
- Every beat lists "evidence": 1-3 sentences copied VERBATIM from the source (at least 5 words each) that support the narration. Numbers, years and names in the narration must appear in that evidence. Write every number, year and date as digits exactly as the evidence has them (1872, not "eighteen seventy-two"; December 4, not "the fourth"), and never state a number that is not in that beat's own evidence.
- Beat 1 starts with a hook that states the real, most striking fact in under 14 words. No filler openers, no "imagine", no questions about the viewer.
- Short sentences (under 20 words), no semicolons or dashes, plain ASCII. Past tense. Never mention drawings, animation or the video.
- The last beat ends on the real unresolved fact or consequence, not on an invented twist.

${beats}
${brief ? `\nEDITOR / FACT-CHECK NOTES ON THE PREVIOUS DRAFT (fix every point):\n${notesOf(brief).map(note => `- ${note}`).join('\n')}\n` : ''}${previous ? `\nPREVIOUS DRAFT (JSON):\n${JSON.stringify({ title: previous.title, beats: previous.beats.map(b => ({ narration: b.narration, evidence: b.evidence })) })}\nRewrite ONLY the beats the notes name (a note about the hook is about beat 1) and return every other beat exactly as it is. A note without a beat number applies to the whole script.\n` : ''}
Return JSON only: {"title":"under 70 characters, factual, no clickbait lies","beats":[{"narration":"","evidence":[""]}]}`;
}

/** Notes of a revision brief (the lines the review loop writes as "- note"). */
const notesOf = brief => String(brief || '').split('\n').filter(line => line.startsWith('- ')).map(line => line.slice(2));

/**
 * Beat numbers (1-based) the notes name, or null when no note names a beat (then every beat may change).
 * A note about the hook is about beat 1.
 */
function affectedBeats(brief) {
  const named = new Set();
  for (const note of notesOf(brief)) {
    const beat = note.match(/^beat (\d+)\b/i);
    if (beat) named.add(Number(beat[1]));
    else if (/^the hook\b/i.test(note)) named.add(1);
    // a note without a beat (word total, long sentence) does not unlock the other beats
  }
  return named.size ? named : null;
}

/** Documentary prose check (the horror heuristics do not apply: no twist, no cliche list). */
function proseIssues(script) {
  const notes = [];
  const all = script.beats.map(b => b.narration).join(' ');
  const total = wordCount(all);
  if (total < WORDS.min || total > WORDS.max) notes.push(`the narration is ${total} words; it must be ${WORDS.min}-${WORDS.max}`);
  const hookWords = wordCount(sentencesOf(script.beats[0]?.narration)[0]);
  if (hookWords < 4 || hookWords > 16) notes.push(`the hook (first sentence) is ${hookWords} words; make it 5-14 words`);
  if (/^(imagine|picture|what if)\b/i.test(all.trim())) notes.push('do not open with "imagine"/"picture"/"what if"; open on the fact');
  const long = sentencesOf(all).filter(s => wordCount(s) > 24);
  if (long.length) notes.push(`${long.length} sentence(s) run past 24 words ("${long[0].slice(0, 60)}..."); split them`);
  if (/[;—–]/.test(all)) notes.push('remove semicolons and dashes; narration is spoken');
  if (ART_STYLE.test(all)) notes.push('the narration names the visual style; never do that');
  if (/[^\t\n\r -~]/.test(all)) notes.push('use plain ASCII letters only');
  script.beats.forEach((b, i) => { if (wordCount(b.narration) < 8) notes.push(`beat ${i + 1} is too thin (${wordCount(b.narration)} words)`); });
  return notes;
}

/** { overall, passed, failures, notes, source } in the shape reviewedScriptLoop expects. */
async function reviewGrounded(script, story, verify) {
  const facts = await checkFacts(script, story, { verify, parseJson: parseJsonResponse });
  const prose = proseIssues(script);
  const overall = facts.passed ? Math.max(0, 10 - 1.5 * prose.length) : 0;
  const failures = [...(facts.passed ? [] : ['fact-check failed']), ...(prose.length && overall < PASS_SCORE ? ['documentary prose below the floor'] : [])];
  return { overall: Number(overall.toFixed(2)), passed: facts.passed && overall >= PASS_SCORE, failures, notes: [...facts.issues, ...prose], source: 'fact-check+prose', facts };
}

function parseDraft(reply, story) {
  const parsed = parseJsonResponse(reply);
  if (!parsed?.title || !Array.isArray(parsed.beats)) throw new Error('writer returned no title/beats');
  const beats = parsed.beats.map((b, i) => ({
    heading: story.plan.beats[i]?.heading,
    narration: String(b.narration || '').trim(),
    evidence: (Array.isArray(b.evidence) ? b.evidence : []).map(e => String(e).trim()).filter(Boolean),
    images: story.plan.beats[i]?.images || []
  }));
  const fullScript = beats.map(b => b.narration).join(' ');
  return { title: String(parsed.title).trim().slice(0, 100), hook: sentencesOf(beats[0]?.narration)[0] || '', beats, fullScript };
}

/** Description = a one-line summary + the attribution text UNCHANGED (rejected, never truncated, when it does not fit). */
function buildDescription(script, story) {
  const description = `${script.hook}\n\nA true story, told from the historical record.\n\n${story.attribution}`;
  if (!story.attribution || !description.includes(story.attribution)) throw new Error('attribution missing from the description');
  if (description.length > YT_DESCRIPTION_LIMIT) throw new Error(`description with attribution is ${description.length} characters (limit ${YT_DESCRIPTION_LIMIT}); use fewer images or shorter credits`);
  return description;
}

/**
 * writeGroundedScript({ story, llm }) -> script, or throws CREATIVE_REVIEW_REJECTED when no draft passes the fact-check.
 * `story` is a claimed story_pool row: { plan: { title, extract, beats }, attribution }. llm = an AITextService.
 */
async function writeGroundedScript({ story, llm, logger = null, maxRevisions = 2 }) {
  let previous = null;
  const ask = (prompt, options) => llm.generateText(prompt, { task: 'script', responseMimeType: 'application/json', ...options });
  const script = await reviewedScriptLoop({
    maxRevisions, logger,
    write: async brief => {
      const draft = parseDraft(await ask(buildPrompt(story, brief, previous), { maxTokens: 2200, temperature: brief ? 0.4 : 0.6 }), story);
      const named = previous && affectedBeats(brief);
      if (named) {
        // A rewrite that fixes the flagged beat but breaks another one never converges; only the named beats may change.
        draft.beats = draft.beats.map((beat, i) => (named.has(i + 1) || !previous.beats[i] ? beat : previous.beats[i]));
        draft.fullScript = draft.beats.map(b => b.narration).join(' ');
        draft.hook = sentencesOf(draft.beats[0]?.narration)[0] || '';
      }
      previous = draft;
      return draft;
    },
    review: draft => reviewGrounded(draft, story, prompt => ask(prompt, { task: 'packaging', maxTokens: 400, temperature: 0 }))
  });
  script.description = buildDescription(script, story);
  script.attribution = story.attribution;
  script.sourceTitle = story.plan.title;
  return script;
}

module.exports = { writeGroundedScript, reviewGrounded, buildPrompt, buildDescription, proseIssues, parseDraft, affectedBeats };
