// Image-fit check: does the picture shown with a beat really show what that beat's narration says? A text model that reads only
// file titles cannot tell (a waterspout photo sat under "pirates would have looted the ship" because the section it came from
// discusses theories), so a vision model looks at the pictures themselves, all beats in one request. It FAILS CLOSED: no vision
// model, an error or an unusable answer means the pictures were not checked and the script does not pass. A mismatch is sent back
// to the writer (narrate what the picture shows, or skip the beat); it is never accepted.
const fs = require('fs');
const path = require('path');
const { parseJsonResponse } = require('../json-response');

const FIT_MAX_TOKENS = 1024;
const FIT_TIMEOUT_MS = 60000;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** One entry per narrated beat: { beat (1-based), narration, title, description, file }. */
function fitEntries(script, story) {
  return script.beats.map((beat, i) => ({ beat: i + 1, narration: beat.narration, image: beat.images?.[0] || story.plan.beats[i]?.images?.[0] || null, skip: Boolean(beat.skip) }))
    .filter(entry => !entry.skip);
}

function buildFitPrompt(entries) {
  const lines = entries.map(entry => `IMAGE ${entry.beat} (file title: "${String(entry.image?.title || '').replace(/\.(jpe?g|png)$/i, '')}"${entry.image?.description ? `; Commons description: ${String(entry.image.description).slice(0, 200)}` : ''})\nNARRATION ${entry.beat}: ${entry.narration}`).join('\n\n');
  return `You check pictures for a true-story video. Below, each beat has the picture shown while its narration is spoken (the pictures follow in the same order as the beats, IMAGE numbers match NARRATION numbers).

Mark a beat as a MISMATCH when the picture does not show, or clearly belong to, what the narration says: the specific people, ship, place, document, object or event it names. A picture of something else is a mismatch (a waterspout for a sentence about pirates, a portrait of someone the sentence does not mention, a generic scene, a map of another place, a modern photo of an unrelated thing). A document, newspaper page, map, portrait, object or illustration of the right subject or period is fine. When you are unsure, mark a mismatch.

${lines}

Return JSON only: {"mismatch":[{"beat":5,"reason":"the picture shows a waterspout, the narration is about pirates"}]}. An empty list means every picture fits its narration.`;
}

/** The reply as a list of mismatches: { mismatch: [...] } or that object in an array. null when it is neither (unusable). */
function mismatchesOf(parsed) {
  const answer = Array.isArray(parsed) ? parsed.find(item => item && typeof item === 'object' && 'mismatch' in item) : parsed;
  return Array.isArray(answer?.mismatch) ? answer.mismatch : null;
}

/**
 * checkImageFit({ script, story, judge }) -> { passed, issues[], checkedBeats }. `judge({ prompt, images })` returns the model's
 * reply text; images = [{ mimeType, data (base64) }] in beat order. Throws VISION_UNAVAILABLE when the pictures could not be checked.
 */
async function checkImageFit({ script, story, judge, readImage = readImageForModel }) {
  if (typeof judge !== 'function') throw fail('VISION_UNAVAILABLE', 'no vision model is available to check that the pictures fit the narration');
  const entries = fitEntries(script, story);
  const images = [];
  for (const entry of entries) {
    const file = entry.image?.file && story.plan.folder ? path.join(story.plan.folder, entry.image.file) : null;
    try {
      images.push(await readImage(file));
    } catch (error) {
      throw fail('VISION_UNAVAILABLE', `beat ${entry.beat}: the picture could not be read (${String(error.message).slice(0, 100)})`);
    }
  }
  let reply;
  try {
    reply = await judge({ prompt: buildFitPrompt(entries), images });
  } catch (error) {
    throw fail('VISION_UNAVAILABLE', `the pictures could not be checked: ${String(error.message).slice(0, 160)}`);
  }
  let mismatches;
  try { mismatches = mismatchesOf(parseJsonResponse(reply)); } catch (_error) { mismatches = null; }
  if (!mismatches) throw fail('VISION_UNAVAILABLE', `the picture check returned an unusable answer: ${JSON.stringify(String(reply)).slice(0, 160)}`);
  const issues = mismatches.map(item => {
    const beat = Number(item?.beat ?? item?.id ?? item);
    return `beat ${beat}: the picture does not show what the narration says (${String(item?.reason || 'no reason given').slice(0, 140)}); narrate what the picture shows using the source, or skip this beat`;
  });
  return { passed: issues.length === 0, issues, checkedBeats: entries.length };
}

/**
 * What each picture of the story shows, in one sentence each (one vision request for all beats), so the writer can narrate what
 * the viewer sees. An answer that cannot be read gives no descriptions (the writer works from the titles and the picture check, the real
 * gate, still runs); a vision model that cannot be reached throws VISION_UNAVAILABLE, before anything is written (free quota is a budget).
 * Returns an array aligned with story.plan.beats (null where unknown).
 */
async function describePictures({ story, judge, readImage = readImageForModel }) {
  const beats = story.plan.beats;
  const entries = beats.map((beat, i) => ({ index: i + 1, image: beat.images?.[0] || null }));
  const images = [];
  try {
    for (const entry of entries) images.push(await readImage(entry.image?.file && story.plan.folder ? path.join(story.plan.folder, entry.image.file) : null));
  } catch (error) {
    throw fail('VISION_UNAVAILABLE', `a picture could not be read (${String(error.message).slice(0, 100)})`);
  }
  let reply;
  try {
    reply = await judge({
      images,
      prompt: `Below are ${entries.length} pictures from the Wikipedia article "${story.plan.title}", in order (IMAGE 1 to IMAGE ${entries.length}). For each, say in one short sentence what the picture shows (the people, ship, place, document, object or scene, and any readable text). Describe only what you see.

${entries.map(entry => `IMAGE ${entry.index} (file title: "${String(entry.image?.title || '').replace(/\.(jpe?g|png)$/i, '')}")`).join('\n')}

Return JSON only: {"pictures":[{"image":1,"shows":"..."}]}`
    });
  } catch (error) {
    throw fail('VISION_UNAVAILABLE', `the vision model could not be reached: ${String(error.message).slice(0, 160)}`);
  }
  try {
    const parsed = parseJsonResponse(reply);
    const list = Array.isArray(parsed) ? parsed : parsed?.pictures;
    if (!Array.isArray(list)) return beats.map(() => null);
    return entries.map(entry => {
      const found = list.find(item => Number(item?.image) === entry.index);
      return found && typeof found.shows === 'string' && found.shows.trim() ? found.shows.trim().slice(0, 240) : null;
    });
  } catch (_error) {
    return beats.map(() => null);
  }
}

/** Reads a picture as a small JPEG for the model (sharp is already a dependency). */
async function readImageForModel(file) {
  if (!file) throw new Error('no picture file');
  const sharp = require('sharp');
  const data = await sharp(fs.readFileSync(file)).resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer();
  return { mimeType: 'image/jpeg', data: data.toString('base64') };
}

/**
 * The vision judge on the free Gemini client of an AITextService. Tries the configured model, then the other free Gemini models,
 * never a text-only provider. No Gemini client means no judge (checkImageFit then fails closed).
 */
function makeVisionJudge(llm, { models = null, timeoutMs = FIT_TIMEOUT_MS } = {}) {
  const client = llm?.gemini;
  if (!client) return null;
  const chain = models || [...new Set([llm.model, 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash-lite'].filter(Boolean))];
  return async ({ prompt, images }) => {
    let lastError = null;
    for (const model of chain) {
      let timer = null;
      try {
        const parts = [...images.map(image => ({ inlineData: { mimeType: image.mimeType, data: image.data } })), { text: prompt }];
        const response = await Promise.race([
          client.models.generateContent({ model, contents: [{ role: 'user', parts }], config: { maxOutputTokens: FIT_MAX_TOKENS, responseMimeType: 'application/json' } }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`vision request timed out after ${timeoutMs} ms`)), timeoutMs); })
        ]);
        if (typeof response?.text === 'string' && response.text.trim()) return response.text;
        lastError = new Error('empty vision response');
      } catch (error) {
        lastError = error;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    throw lastError || new Error('no vision model answered');
  };
}

module.exports = { describePictures, checkImageFit, buildFitPrompt, mismatchesOf, makeVisionJudge, readImageForModel, fitEntries };
