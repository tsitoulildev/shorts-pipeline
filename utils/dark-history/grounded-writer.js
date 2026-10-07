// Grounded writer for Dark History: narrates ONLY facts present in the story's source passages, one beat per
// footage beat. The existing bounded write -> review -> rewrite loop (creative-review.js) is reused; the review
// is the fact-check gate plus a documentary prose check. Nothing here lowers a gate or touches the fiction path.
const { reviewedScriptLoop } = require('../creative-review');
const { parseJsonResponse } = require('../json-response');
const { checkFacts, sentencesOf } = require('./fact-check');
const { attributionText } = require('./attribution');
const { checkImageFit, describePictures, makeVisionJudge } = require('./image-fit');

// ljspeech speaks about 2 words a second (measured on the VM: 132 words = 64.7 s); the gate allows 60 s
const WORDS = { min: 70, max: 100, beatMin: 9, beatMax: 18 };
const PASS_SCORE = 7;
const ART_STYLE = /\b(stick ?man|stick figure|stickmen|animation|cartoon|drawing)\b/i;
const YT_DESCRIPTION_LIMIT = 4900;

const wordCount = text => String(text || '').split(/\s+/).filter(Boolean).length;

function buildPrompt(story, brief, previous = null, shows = []) {
  const beats = story.plan.beats.map((beat, i) => `BEAT ${i + 1} (${beat.heading}). On screen: ${beat.images.map(img => img.title.replace(/\.(jpe?g|png)$/i, '')).join('; ')}${shows[i] ? ` - the picture shows: ${shows[i]}` : ''}\nSOURCE PASSAGE: ${beat.text.slice(0, 1800)}`).join('\n\n');
  return `You write the narration of a 35-45 second true-story YouTube Short about "${story.plan.title}". The voice is a calm documentary narrator speaking to someone who knows nothing about it. It must be accurate, plain and gripping.

HOW IT SHOULD SOUND
- Tell ONE tight story in order: the most striking fact, what happened (say plainly who or what was lost, killed or unexplained), what was found or decided, what is still unknown. Every beat adds one new fact, so the viewer is pulled forward.
- Skip every passage that is only background (how the ship was built or registered, who owned it) or epilogue (later fate, books and retellings) unless it IS the story. Four to six strong beats beat seven weak ones.
- Restate the evidence in your own short spoken sentences. Do not copy a long source sentence, and leave out minor detail (registration dates, official titles, ship numbers) unless the story needs it. At most two numbers or dates per beat.
- Concrete nouns and verbs. No filler and no adjectives such as "shocking", "mysterious" or "chilling". Each beat's narration must be about what its picture shows (the same people, ship, place, document or object), told with facts from that beat's source passage; a vision check rejects a beat whose picture shows something else. If the passage has no fact about what the picture shows, skip the beat.
- Beat 1 is the hook: the single most striking true fact of the whole story in 14 words or fewer (it may come from the article lead). No "imagine", no question to the viewer.
- The last beat ends on the real unresolved fact or consequence, never on an invented twist.

HARD RULES (a fact-checker rejects the whole script if one is broken):
- Write exactly ${story.plan.beats.length} entries, one per source passage below, in order. You may skip a passage that adds nothing to the story: write {"skip":true} for it and its picture is left out (at least 4 beats must stay narrated, and the story must still make sense in order). ${WORDS.beatMin}-${WORDS.beatMax} spoken words per beat, ${WORDS.min}-${WORDS.max} words in total (the voice speaks about two words a second and the Short must stay under 60 seconds).
- Narrate ONLY what is stated in the source. No invented detail, emotion, motive, dialogue, name, number or place. A theory must be attributed ("investigators suspected...").
- Every beat lists "evidence": 1-3 sentences copied VERBATIM from the source (at least 5 words each) that support the narration. Numbers, years and names in the narration must appear in that evidence. Write every number, year and date as digits exactly as the evidence has them (1872, not "eighteen seventy-two"; December 4, not "the fourth"), and never state a number that is not in that beat's own evidence.
- Short sentences (under 20 words), no semicolons or dashes, plain ASCII. Past tense. Never mention drawings, animation or the video.

ARTICLE LEAD (for the hook): ${String(story.plan.extract || '').slice(0, 600)}

${beats}
${brief ? `\nEDITOR / FACT-CHECK NOTES ON THE PREVIOUS DRAFT (fix every point):\n${notesOf(brief).map(note => `- ${note}`).join('\n')}\n` : ''}${previous ? `\nPREVIOUS DRAFT (JSON):\n${JSON.stringify({ title: previous.title, beats: previous.beats.map(b => (b.skip ? { skip: true } : { narration: b.narration, evidence: b.evidence })) })}\nRewrite ONLY the beats the notes name (a note about the hook is about beat 1) and return every other beat exactly as it is. A note without a beat number applies to the whole script.\n` : ''}
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

/** fullScript and hook come from the narrated beats only. */
function withSummary(script) {
  const narrated = script.beats.filter(b => !b.skip);
  return { ...script, hook: sentencesOf(narrated[0]?.narration)[0] || '', fullScript: narrated.map(b => b.narration).join(' ') };
}

/**
 * The story the video is made from: the pool story without the beats the writer skipped (their pictures are not shown,
 * so they are not credited either). script.sourceBeatIndexes says which beats of the pool story were kept.
 */
function storyForScript(story, script) {
  const kept = script.sourceBeatIndexes;
  if (!kept || kept.length === story.plan.beats.length) return story;
  const beats = kept.map(i => story.plan.beats[i]);
  if (!story.article_url) throw new Error('the story has no article URL to credit');
  return { ...story, plan: { ...story.plan, beats }, attribution: attributionText({ title: story.plan.title, url: story.article_url }, beats) };
}

/** Documentary prose check (the horror heuristics do not apply: no twist, no cliche list). */
function proseIssues(script) {
  const notes = [];
  const narrated = script.beats.filter(b => !b.skip);
  const all = narrated.map(b => b.narration).join(' ');
  const total = wordCount(all);
  if (total < WORDS.min || total > WORDS.max) notes.push(`the narration is ${total} words; it must be ${WORDS.min}-${WORDS.max}`);
  const hookWords = wordCount(sentencesOf(narrated[0]?.narration)[0]);
  if (hookWords < 4 || hookWords > 16) notes.push(`the hook (first sentence) is ${hookWords} words; make it 5-14 words`);
  if (/^(imagine|picture|what if)\b/i.test(all.trim())) notes.push('do not open with "imagine"/"picture"/"what if"; open on the fact');
  const long = sentencesOf(all).filter(s => wordCount(s) > 24);
  if (long.length) notes.push(`${long.length} sentence(s) run past 24 words ("${long[0].slice(0, 60)}..."); split them`);
  if (/[;—–]/.test(all)) notes.push('remove semicolons and dashes; narration is spoken');
  if (ART_STYLE.test(all)) notes.push('the narration names the visual style; never do that');
  if (/[^\t\n\r -~]/.test(all)) notes.push('use plain ASCII letters only');
  script.beats.forEach((b, i) => { if (!b.skip && wordCount(b.narration) < 8) notes.push(`beat ${i + 1} is too thin (${wordCount(b.narration)} words)`); });
  return notes;
}

/** { overall, passed, failures, notes, source } in the shape reviewedScriptLoop expects. */
async function reviewGrounded(script, story, verify, imageFit = null) {
  const facts = await checkFacts(script, story, { verify, parseJson: parseJsonResponse });
  // An unavailable vision model throws VISION_UNAVAILABLE: unchecked pictures never pass.
  // (Vision requests are free-tier quota: they run on drafts whose facts hold; a draft with a fact problem is rewritten first.)
  const fit = !facts.passed ? { passed: false, issues: [], checkedBeats: 0, skipped: true } : await checkImageFit({ script, story, ...(imageFit || {}) });
  const prose = proseIssues(script);
  const accepted = facts.passed && fit.passed;
  const overall = accepted ? Math.max(0, 10 - 1.5 * prose.length) : 0;
  const failures = [...(facts.passed ? [] : ['fact-check failed']), ...(fit.passed || fit.skipped ? [] : ['a picture does not fit its narration']), ...(prose.length && overall < PASS_SCORE ? ['documentary prose below the floor'] : [])];
  return { overall: Number(overall.toFixed(2)), passed: accepted && overall >= PASS_SCORE, failures, notes: [...facts.issues, ...fit.issues, ...prose], source: 'fact-check+images+prose', facts, imageFit: { passed: fit.passed, checkedBeats: fit.checkedBeats } };
}

function parseDraft(reply, story) {
  const parsed = parseJsonResponse(reply);
  if (!parsed?.title || !Array.isArray(parsed.beats)) throw new Error('writer returned no title/beats');
  const beats = parsed.beats.map((b, i) => (b.skip === true
    ? { heading: story.plan.beats[i]?.heading, skip: true, narration: '', evidence: [], images: story.plan.beats[i]?.images || [] }
    : {
      heading: story.plan.beats[i]?.heading,
      narration: String(b.narration || '').trim(),
      evidence: (Array.isArray(b.evidence) ? b.evidence : []).map(e => String(e).trim()).filter(Boolean),
      images: story.plan.beats[i]?.images || []
    }));
  return withSummary({ title: String(parsed.title).trim().slice(0, 100), beats });
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
async function writeGroundedScript({ story, llm, logger = null, maxRevisions = 3, imageFit = null }) {
  const fitOptions = imageFit || { judge: makeVisionJudge(llm) };
  // Fail before spending: unchecked pictures never pass, so without a vision model there is no point in writing.
  if (!fitOptions.judge) throw Object.assign(new Error('no vision model is available to check that the pictures fit the narration'), { code: 'VISION_UNAVAILABLE' });
  const shows = await describePictures({ story, ...fitOptions });
  let previous = null;
  const ask = (prompt, options) => llm.generateText(prompt, { task: 'script', responseMimeType: 'application/json', ...options });
  const script = await reviewedScriptLoop({
    maxRevisions, logger,
    write: async brief => {
      // A reply that is not the JSON asked for (seen on the VM: no title/beats) is asked for once more before the attempt is lost.
      let draft;
      for (let tries = 1; !draft; tries += 1) {
        try {
          draft = parseDraft(await ask(buildPrompt(story, brief, previous, shows), { maxTokens: 2200, temperature: brief ? 0.4 : 0.6 }), story);
        } catch (error) {
          if (tries >= 2 || !/no title.beats|JSON|Unexpected token|parse/i.test(error.message)) throw error;
          logger?.warn?.(`grounded writer: unusable reply (${error.message}); asking again`);
        }
      }
      const named = previous && affectedBeats(brief);
      if (named) {
        // A rewrite that fixes the flagged beat but breaks another one never converges; only the named beats may change.
        const beats = draft.beats.map((beat, i) => (named.has(i + 1) || !previous.beats[i] ? beat : previous.beats[i]));
        Object.assign(draft, withSummary({ ...draft, beats }));
      }
      previous = draft;
      return draft;
    },
    review: draft => reviewGrounded(draft, story, prompt => ask(prompt, { task: 'packaging', maxTokens: 400, temperature: 0 }), fitOptions)
  });
  // Skipped beats leave the script (and the story's footage and credits) here, so everything downstream sees one beat per picture.
  script.sourceBeatIndexes = script.beats.map((b, i) => (b.skip ? null : i)).filter(i => i !== null);
  script.beats = script.beats.filter(b => !b.skip);
  const used = storyForScript(story, script);
  script.description = buildDescription(script, used);
  script.attribution = used.attribution;
  script.sourceTitle = story.plan.title;
  return script;
}

module.exports = { writeGroundedScript, storyForScript, reviewGrounded, buildPrompt, buildDescription, proseIssues, parseDraft, affectedBeats };
