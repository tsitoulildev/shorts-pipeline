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
  return `You check pictures for a true-story video. Below, each beat has the picture shown while its narration is spoken (the pictures follow in the same order as the beats; IMAGE numbers match NARRATION numbers).

For EVERY beat do three things, in this order:
1. "shows": what the picture shows, in a few words (look at the picture, not at the text).
2. "subject": the main subject of the narration sentence: the one person, ship, place, document, object or event the sentence is about.
3. "fits": true only when the picture shows that main subject itself: the person, ship, place, document or object named, or a period picture of that exact event. A picture of a RELATED topic does not fit, even when the article discusses it and even when it illustrates a theory that is mentioned nearby. Examples that do NOT fit: a waterspout photo under a sentence about pirates or about belongings left undisturbed; a lap desk under a sentence about building, launching or crewing a ship; a portrait of one person under a sentence about another; a map of another region; a modern or generic photo. Examples that fit: the portrait of the judge named in the sentence; the ship named; the newspaper page the sentence is about. When you are unsure, "fits" is false.

${lines}

Return JSON only: {"beats":[{"beat":1,"shows":"...","subject":"...","fits":true}]} with one entry per beat, in order.`;
}

/**
 * The reply as a list of mismatches. Accepted shapes: { beats: [{ beat, fits }] } (every expected beat must be present, a missing or
 * non-true "fits" is a mismatch), { mismatch: [...] }, and either of them wrapped in an array. null when it is none of these (unusable).
 */
function mismatchesOf(parsedReply, expectedBeats = null, subjectWord = 'narration') {
  let parsed = parsedReply;
  const isObject = item => item && typeof item === 'object' && !Array.isArray(item);
  // a bare array of per-beat verdicts (seen from the real model) is the beats list
  if (Array.isArray(parsed) && parsed.length && parsed.every(item => isObject(item) && 'beat' in item)) parsed = { beats: parsed };
  const answer = Array.isArray(parsed) ? parsed.find(item => isObject(item) && ('beats' in item || 'mismatch' in item)) : parsed;
  if (Array.isArray(answer?.beats)) {
    const byBeat = new Map(answer.beats.filter(isObject).map(item => [Number(item.beat), item]));
    const wanted = expectedBeats || [...byBeat.keys()];
    if (!wanted.length) return null;
    return wanted.filter(beat => byBeat.get(beat)?.fits !== true).map(beat => ({ beat, reason: !byBeat.has(beat) ? 'the check gave no verdict for this beat' : byBeat.get(beat).reason ? String(byBeat.get(beat).reason).slice(0, 140) : `the picture shows ${String(byBeat.get(beat).shows || 'something else').slice(0, 80)}, the ${subjectWord} is about ${String(byBeat.get(beat).subject || 'something else').slice(0, 80)}` }));
  }
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
    reply = await judge({ prompt: buildFitPrompt(entries), images, validate: text => { try { return mismatchesOf(parseJsonResponse(text), entries.map(entry => entry.beat)) !== null; } catch (_error) { return false; } } });
  } catch (error) {
    throw fail('VISION_UNAVAILABLE', `the pictures could not be checked: ${String(error.message).slice(0, 160)}`);
  }
  let mismatches;
  try { mismatches = mismatchesOf(parseJsonResponse(reply), entries.map(entry => entry.beat)); } catch (_error) { mismatches = null; }
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

// Free vision models checked on the VM 2026-10-07 (ministral-14b: 3 of 3 rounds flagged exactly the three known mismatches on six pictures in one request). Gemini is first
// (best quality, but its free daily quota runs out); the others are the failover. Keys come from the environment only.
const EXTERNAL_VISION = [
  // (NVIDIA's llama-3.2 vision models answer one picture per request, so they cannot take a whole Short in one request.)
  // Mistral's free mode may log requests: the pictures are public Commons files and the sentences public facts.
  { name: 'Mistral ministral-14b', baseURL: 'https://api.mistral.ai/v1', envKey: 'MISTRAL_API_KEY', model: 'ministral-14b-latest' },
  { name: 'Mistral medium', baseURL: 'https://api.mistral.ai/v1', envKey: 'MISTRAL_API_KEY', model: 'mistral-medium-latest' }
];

/**
 * The vision judge: the free OpenAI-compatible vision models (Mistral), then the free Gemini models; the OpenAI-compatible ones whose keys are configured, never a
 * text-only model. A provider that errors (a spent daily quota rests for 30 min, anything else for 2) or whose answer fails
 * `validate` is skipped for the next one. No Gemini client and no key means no judge (checkImageFit then fails closed).
 * Options: models (Gemini ids), only (a provider name, for calibration), env, post (injected in tests), now.
 */
function makeVisionJudge(llm, { models = null, timeoutMs = FIT_TIMEOUT_MS, env = process.env, post = null, now = Date.now, only = null } = {}) {
  const wanted = only || env.VISION_ONLY || null;
  // Order: the calibrated free vision models first, Gemini last. Gemini's free quota is the one the production writer (and the old system) live on,
  // and on the footage check it judged far more strictly than the others (0 of 5 beats for a story the others passed 5 of 5).
  const entries = [];
  for (const external of EXTERNAL_VISION) if (env[external.envKey]) entries.push({ kind: 'openai', ...external, key: env[external.envKey] });
  if (llm?.gemini) {
    for (const model of models || [...new Set([llm.model, 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash-lite'].filter(Boolean))]) entries.push({ kind: 'gemini', name: `Gemini ${model}`, model });
  }
  const chain = wanted ? entries.filter(entry => entry.name.toLowerCase().includes(String(wanted).toLowerCase())) : entries;
  if (!chain.length) return null;
  const resting = new Map();
  const send = post || ((url, body, options) => require('axios').post(url, body, options));

  const callGemini = async (entry, { prompt, images }) => {
    let timer = null;
    try {
      const parts = [...images.map(image => ({ inlineData: { mimeType: image.mimeType, data: image.data } })), { text: prompt }];
      const response = await Promise.race([
        llm.gemini.models.generateContent({ model: entry.model, contents: [{ role: 'user', parts }], config: { maxOutputTokens: FIT_MAX_TOKENS, responseMimeType: 'application/json' } }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`vision request timed out after ${timeoutMs} ms`)), timeoutMs); })
      ]);
      return typeof response?.text === 'string' ? response.text : '';
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const callOpenAi = async (entry, { prompt, images }) => {
    const content = [...images.map(image => ({ type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } })), { type: 'text', text: prompt }];
    const response = await send(`${entry.baseURL}/chat/completions`, { model: entry.model, max_tokens: FIT_MAX_TOKENS, temperature: 0, messages: [{ role: 'user', content }] },
      { headers: { Authorization: `Bearer ${entry.key}` }, timeout: timeoutMs });
    const text = response?.data?.choices?.[0]?.message?.content;
    return typeof text === 'string' ? text : '';
  };

  const judge = async request => {
    let lastError = null;
    for (const entry of chain) {
      if ((resting.get(entry.name) || 0) > now()) continue;
      try {
        const text = entry.kind === 'gemini' ? await callGemini(entry, request) : await callOpenAi(entry, request);
        if (!String(text).trim()) throw new Error('empty vision response');
        if (request.validate && !request.validate(text)) throw Object.assign(new Error(`${entry.name} gave an unusable answer`), { unusable: true });
        judge.lastProvider = entry.name;
        return text;
      } catch (error) {
        lastError = error;
        const spent = Number(error?.response?.status) === 429 || /quota|429|RESOURCE_EXHAUSTED/i.test(String(error?.message || '') + JSON.stringify(error?.response?.data || ''));
        if (!error.unusable) resting.set(entry.name, now() + (spent ? 30 : 2) * 60000);
      }
    }
    throw lastError || new Error('no vision model is available right now');
  };
  judge.providers = chain.map(entry => entry.name);
  return judge;
}

module.exports = { describePictures, checkImageFit, buildFitPrompt, mismatchesOf, makeVisionJudge, readImageForModel, fitEntries };
