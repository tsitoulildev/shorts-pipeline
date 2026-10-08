// Footage fit at the pool entrance. A story is only worth writing when its pictures can be talked about: each beat needs a picture that shows
// something the beat's own source passage names or describes (a person, ship, place, document, object or event it mentions), not a related topic
// from the same article section. One vision request looks at all pictures of a story; a beat whose picture does not fit falls, a beat is never
// filled with another picture, and a story with fewer than 4 fitting beats is not eligible (rejected with the reasons). Fails closed: no vision
// model, an error or an unusable answer is VISION_UNAVAILABLE (transient: the story is neither stored nor rejected). This check is the same
// strictness as the narration check (image-fit.js) so the writer is not handed pictures it cannot narrate.
const path = require('path');
const { parseJsonResponse } = require('../json-response');
const { mismatchesOf, readImageForModel } = require('./image-fit');
const { attributionText } = require('./attribution');

const MIN_BEATS = 4;
const PASSAGE_CHARS = 450;

function fail(code, message, extra = {}) {
  return Object.assign(new Error(message), { code }, extra);
}

/** entries: [{ index (1-based picture number), passage, image }] */
function buildFootagePrompt(entries) {
  const lines = entries.map(entry => `IMAGE ${entry.index} (file title: "${String(entry.image?.title || '').replace(/\.(jpe?g|png)$/i, '')}"${entry.image?.description ? `; Commons description: ${String(entry.image.description).slice(0, 160)}` : ''})\nPASSAGE ${entry.index}: ${String(entry.passage || '').replace(/\s+/g, ' ').slice(0, PASSAGE_CHARS)}`).join('\n\n');
  return `You choose pictures for a true-story video. Each picture below belongs to the source passage with the same number (the pictures follow in the same order). A narrator will talk about what the viewer sees, using only facts from that passage.

For EVERY picture do three things, in this order:
1. "shows": what the picture shows, in a few words (look at the picture, not at the text).
2. "subject": the one person, ship, place, document, object or event of the passage that the picture would illustrate, or "none".
3. "fits": true only when the picture shows something that the passage itself names or describes, so a sentence from the passage can be spoken over it. A picture of a RELATED topic does not fit, even when the article is about it: a map of another region, a modern or generic photo, a portrait of someone the passage does not mention, a picture of a theory the passage does not describe. When you are unsure, "fits" is false.

${lines}

Return JSON only: {"beats":[{"beat":1,"shows":"...","subject":"...","fits":true}]} with one entry per picture, in order.`;
}

/** { keptBeats: [index], keptImages: Map<beatIndex, [image]>, dropped: [{ index, heading, reason }], pictures } */
async function checkFootageFit({ story, judge, readImage = readImageForModel }) {
  if (typeof judge !== 'function') throw fail('VISION_UNAVAILABLE', 'no vision model is available to check the footage');
  const entries = [];
  story.plan.beats.forEach((beat, beatIndex) => beat.images.forEach(image => entries.push({ index: entries.length + 1, beatIndex, passage: beat.text, image })));
  const images = [];
  for (const entry of entries) {
    try {
      images.push(await readImage(entry.image?.file && story.plan.folder ? path.join(story.plan.folder, entry.image.file) : null));
    } catch (error) {
      throw fail('VISION_UNAVAILABLE', `a picture could not be read (${String(error.message).slice(0, 100)})`);
    }
  }
  let reply;
  try {
    reply = await judge({ prompt: buildFootagePrompt(entries), images, validate: text => { try { return mismatchesOf(parseJsonResponse(text), entries.map(entry => entry.index), 'passage') !== null; } catch (_error) { return false; } } });
  } catch (error) {
    throw fail('VISION_UNAVAILABLE', `the footage could not be checked: ${String(error.message).slice(0, 160)}`);
  }
  let mismatches;
  try { mismatches = mismatchesOf(parseJsonResponse(reply), entries.map(entry => entry.index), 'passage'); } catch (_error) { mismatches = null; }
  if (!mismatches) throw fail('VISION_UNAVAILABLE', `the footage check returned an unusable answer: ${JSON.stringify(String(reply)).slice(0, 160)}`);
  const bad = new Map(mismatches.map(item => [Number(item?.beat ?? item?.id ?? item), String(item?.reason || 'the picture does not show what the passage describes').slice(0, 160)]));
  const keptImages = new Map();
  const dropped = [];
  story.plan.beats.forEach((beat, beatIndex) => {
    const mine = entries.filter(entry => entry.beatIndex === beatIndex);
    const good = mine.filter(entry => !bad.has(entry.index)).map(entry => entry.image);
    if (good.length) keptImages.set(beatIndex, good);
    else dropped.push({ index: beatIndex, heading: beat.heading, reason: bad.get(mine[0]?.index) || 'no picture fits' });
  });
  return { keptBeats: [...keptImages.keys()], keptImages, dropped, pictures: entries.length };
}

/**
 * The story with only the beats (and pictures) that fit, credits rebuilt, the verdict recorded in story.plan.fit (a story that carries one is
 * not checked again). Throws STORY_NOT_ELIGIBLE (permanent) when fewer than 4 beats remain, VISION_UNAVAILABLE when unchecked.
 */
async function ensureFootageFit(story, { judge, readImage } = {}) {
  if (story.plan.fit?.checkedAt) return story;
  const result = await checkFootageFit({ story, judge, readImage });
  if (result.keptBeats.length < MIN_BEATS) {
    throw fail('STORY_NOT_ELIGIBLE', `only ${result.keptBeats.length} beats have a picture that shows what its passage describes (dropped: ${result.dropped.map(item => `${item.heading}: ${item.reason}`).join('; ')})`, { permanent: true });
  }
  const beats = result.keptBeats.map(index => ({ ...story.plan.beats[index], images: result.keptImages.get(index) }));
  return {
    ...story,
    plan: { ...story.plan, beats, fit: { checkedAt: new Date().toISOString(), pictures: result.pictures, dropped: result.dropped.map(({ heading, reason }) => ({ heading, reason })) } },
    attribution: attributionText({ title: story.plan.title, url: story.article_url }, beats)
  };
}

module.exports = { checkFootageFit, ensureFootageFit, buildFootagePrompt, MIN_BEATS };
