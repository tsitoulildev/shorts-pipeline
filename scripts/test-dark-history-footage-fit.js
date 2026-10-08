// Footage fit at the pool entrance: a story enters the pool (and is produced) only with >= 4 beats whose picture shows something the beat's own
// source passage names or describes; a beat whose picture does not falls, the story is rejected with the reason when fewer than 4 remain,
// and an unavailable vision model is a transient skip (never a pass, never a rejection). Offline: the vision judge is a stub.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { softPhoto } = require('./lib/stand-in-photos');
const { checkFootageFit, ensureFootageFit, buildFootagePrompt } = require('../utils/dark-history/footage-fit');
const { attributionText } = require('../utils/dark-history/attribution');

const read = async file => ({ mimeType: 'image/jpeg', data: path.basename(String(file)) });
const verdicts = fitting => async ({ images, prompt, validate }) => {
  // one entry per picture in order; `fitting` lists the 1-based picture numbers that fit
  const answer = JSON.stringify({ beats: images.map((_, i) => ({ beat: i + 1, shows: `picture ${i + 1}`, subject: 'the passage', fits: fitting.includes(i + 1), ...(fitting.includes(i + 1) ? {} : { reason: 'unrelated' }) })) });
  assert.ok(validate(answer), 'the stub answers in the format the check validates');
  assert.ok(/names or describes/.test(prompt));
  return answer;
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'footage-fit-'));
  const makeStory = async (count, extraImages = 0) => {
    const beats = [];
    for (let i = 0; i < count; i += 1) {
      const images = [];
      for (let j = 0; j <= (i === 0 ? extraImages : 0); j += 1) {
        const file = `p${i}_${j}.png`;
        await softPhoto(path.join(dir, file), 800, 600, i * 13 + j * 5 + 1);
        images.push({ title: `Pic ${i + 1}.${j + 1}.jpg`, file, license: 'Public domain', descriptionUrl: `https://commons.wikimedia.org/wiki/File:Pic_${i + 1}_${j + 1}.jpg`, author: null });
      }
      beats.push({ heading: `Beat ${i + 1}`, text: `Passage ${i + 1} about the thing shown in picture ${i + 1}.`, images });
    }
    return { article_url: 'https://en.wikipedia.org/wiki/Test', plan: { title: 'Test', extract: 'x', folder: dir, beats }, attribution: attributionText({ title: 'Test', url: 'https://en.wikipedia.org/wiki/Test' }, beats) };
  };

  // the prompt carries each passage with its picture
  const story7 = await makeStory(7);
  assert.ok(buildFootagePrompt(story7.plan.beats.map((b, i) => ({ index: i + 1, passage: b.text, image: b.images[0] }))).includes('PASSAGE 3: Passage 3 about'));

  // pictures that do not fit make their beats fall; the rest stays
  const fit = await checkFootageFit({ story: story7, judge: verdicts([1, 2, 4, 5, 7]), readImage: read });
  assert.deepStrictEqual(fit.keptBeats, [0, 1, 3, 4, 6]);
  assert.deepStrictEqual(fit.dropped.map(d => d.heading), ['Beat 3', 'Beat 6']);

  // ensureFootageFit: the story is pruned, credits follow, the verdict is recorded and not asked again
  let asked = 0;
  const counting = async request => { asked += 1; return verdicts([1, 2, 4, 5, 7])(request); };
  const pruned = await ensureFootageFit(story7, { judge: counting, readImage: read });
  assert.strictEqual(pruned.plan.beats.length, 5);
  assert.ok(!pruned.attribution.includes('Pic 3.1') && pruned.attribution.includes('Pic 4.1'));
  assert.deepStrictEqual(pruned.plan.fit.dropped.map(d => d.heading), ['Beat 3', 'Beat 6']);
  assert.ok(pruned.plan.fit.checkedAt);
  await ensureFootageFit(pruned, { judge: counting, readImage: read });
  assert.strictEqual(asked, 1, 'a story that carries its verdict is not checked again');

  // a beat with several pictures keeps only those that fit, and survives when one fits
  const multi = await makeStory(5, 1); // beat 1 has two pictures: numbered 1 and 2
  const kept = await ensureFootageFit(multi, { judge: verdicts([2, 3, 4, 5, 6]), readImage: read });
  assert.deepStrictEqual(kept.plan.beats[0].images.map(i => i.title), ['Pic 1.2.jpg']);
  assert.strictEqual(kept.plan.beats.length, 5);

  // fewer than 4 beats left: not eligible, permanent, with the reasons
  const six = await makeStory(6);
  await assert.rejects(() => ensureFootageFit(six, { judge: verdicts([1, 2, 3]), readImage: read }), error => error.code === 'STORY_NOT_ELIGIBLE' && error.permanent === true && /only 3 beats have a picture that shows what its passage describes/.test(error.message) && /Beat 4/.test(error.message));

  // unchecked is never a pass: no judge, a judge that throws, an unusable answer, an unreadable picture are VISION_UNAVAILABLE (transient)
  const code = async options => { try { await ensureFootageFit(await makeStory(5), { readImage: read, ...options }); return null; } catch (error) { return error.code; } };
  assert.strictEqual(await code({ judge: null }), 'VISION_UNAVAILABLE');
  assert.strictEqual(await code({ judge: async () => { throw new Error('429'); } }), 'VISION_UNAVAILABLE');
  assert.strictEqual(await code({ judge: async () => 'I see pictures.' }), 'VISION_UNAVAILABLE');
  assert.strictEqual(await code({ judge: verdicts([1, 2, 3, 4, 5]), readImage: async () => { throw new Error('no file'); } }), 'VISION_UNAVAILABLE');
  // a verdict that leaves a picture out counts as "does not fit"
  const partial = async () => JSON.stringify({ beats: [{ beat: 1, fits: true }, { beat: 2, fits: true }, { beat: 3, fits: true }, { beat: 4, fits: true }] });
  assert.strictEqual((await checkFootageFit({ story: await makeStory(5), judge: partial, readImage: read })).keptBeats.length, 4);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_error) { /* open handle on Windows */ }
  console.log('dark-history footage-fit tests passed');
})().catch(error => { console.error(error); process.exit(1); });
