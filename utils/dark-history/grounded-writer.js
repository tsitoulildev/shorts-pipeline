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

function buildPrompt(story, brief) {
  const beats = story.plan.beats.map((beat, i) => `BEAT ${i + 1} (${beat.heading}). On screen: ${beat.images.map(img => img.title.replace(/\.(jpe?g|png)$/i, '')).join('; ')}\nSOURCE PASSAGE: ${beat.text.slice(0, 1100)}`).join('\n\n');
  return `You write a 35-45 second true-story narration for a YouTube Short about "${story.plan.title}". It must be accurate, plain and gripping.

HARD RULES (a fact-checker rejects the whole script if one is broken):
- Write exactly ${story.plan.beats.length} beats, one per source passage below, in order. 14-26 spoken words per beat, ${WORDS.min}-${WORDS.max} words in total.
- Narrate ONLY what that beat's SOURCE PASSAGE states. No invented detail, emotion, motive, dialogue, name, number or place. A theory must be attributed ("investigators suspected...").
- Every beat lists "evidence": 1-3 sentences copied VERBATIM from the source (at least 5 words each) that support the narration. Numbers, years and names in the narration must appear in that evidence.
- Beat 1 starts with a hook that states the real, most striking fact in under 14 words. No filler openers, no "imagine", no questions about the viewer.
- Short sentences (under 20 words), no semicolons or dashes, plain ASCII. Past tense. Never mention drawings, animation or the video.
- The last beat ends on the real unresolved fact or consequence, not on an invented twist.

${beats}
${brief ? `\nEDITOR / FACT-CHECK NOTES ON THE PREVIOUS DRAFT (fix every point):\n${brief}\n` : ''}
Return JSON only: {"title":"under 70 characters, factual, no clickbait lies","beats":[{"narration":"","evidence":[""]}]}`;
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
  const ask = (prompt, options) => llm.generateText(prompt, { task: 'script', responseMimeType: 'application/json', ...options });
  const script = await reviewedScriptLoop({
    maxRevisions, logger,
    write: async brief => parseDraft(await ask(buildPrompt(story, brief), { maxTokens: 2200, temperature: brief ? 0.4 : 0.6 }), story),
    review: draft => reviewGrounded(draft, story, prompt => ask(prompt, { task: 'packaging', maxTokens: 400, temperature: 0 }))
  });
  script.description = buildDescription(script, story);
  script.attribution = story.attribution;
  script.sourceTitle = story.plan.title;
  return script;
}

module.exports = { writeGroundedScript, reviewGrounded, buildPrompt, buildDescription, proseIssues, parseDraft };
