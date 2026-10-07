// Offline: Ken Burns documentary render with real FFmpeg on generated stand-in photos, plus the documentary gate.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runFFmpeg, checkFFmpeg } = require('../utils/ffmpeg');
const { kenBurnsFilter, beatTimeline } = require('../utils/dark-history/documentary-render');
const { produceDocumentaryShort, buildSeo } = require('../utils/dark-history/produce');
const { checkDocumentaryProduction } = require('../utils/dark-history/documentary-gate');
const { attributionText } = require('../utils/dark-history/attribution');
const { buildDescription } = require('../utils/dark-history/grounded-writer');

const SENTENCES = [
  'The ship was found drifting in the Atlantic Ocean in December.',
  'The lifeboat was missing from the deck of the vessel.',
  'The cargo of alcohol was still intact in the hold below.',
  'Nobody who had been on board was ever seen again.'
];

// four different scenes (the same pattern at another size would be a near-duplicate picture)
async function makeImage(file, width, height, index = 0) {
  const source = ['testsrc2', 'smptebars', 'mandelbrot', 'gradients'][index % 4];
  await runFFmpeg(['-y', '-f', 'lavfi', '-i', `${source}=s=${width}x${height},format=rgb24`, '-frames:v', '1', '-update', '1', file]);
}

(async () => {
  assert.ok(await checkFFmpeg(), 'FFmpeg must be available (ffmpeg-static or PATH)');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-prod-'));
  const folder = path.join(dir, 'images');
  fs.mkdirSync(folder);

  // Stand-in "downloaded" photos: landscape, wide, and a very tall portrait (aspect must be kept, never stretched).
  const dims = [[1600, 1067], [1500, 600], [900, 1600], [1280, 960]];
  const beats = [];
  for (let i = 0; i < dims.length; i += 1) {
    const tmp = path.join(folder, `raw${i}.png`);
    await makeImage(tmp, dims[i][0], dims[i][1], i);
    const buffer = fs.readFileSync(tmp);
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const file = `${sha256.slice(0, 16)}.png`;
    fs.renameSync(tmp, path.join(folder, file));
    beats.push({
      heading: `Beat ${i + 1}`, text: SENTENCES[i],
      images: [{ title: `Photo ${i + 1}.png`, file, sha256, width: dims[i][0], height: dims[i][1], mime: 'image/png', license: i === 1 ? 'CC BY 4.0' : 'Public domain', author: i === 1 ? 'A. Photographer' : null,
        descriptionUrl: `https://commons.wikimedia.org/wiki/File:Photo_${i + 1}.png`, fileUrl: `https://upload.wikimedia.org/wikipedia/commons/${i}/photo${i + 1}.png`, licenseUrl: null }]
    });
  }
  const article = { title: 'Mary Celeste', url: 'https://en.wikipedia.org/wiki/Mary_Celeste' };
  const story = {
    article_url: article.url, revision_id: 123456,
    plan: { title: 'Mary Celeste', extract: SENTENCES.join(' '), folder, beats },
    attribution: attributionText(article, beats)
  };
  const script = {
    title: 'The Ship Found Empty', hook: SENTENCES[0],
    beats: beats.map((b, i) => ({ heading: b.heading, narration: SENTENCES[i], evidence: [SENTENCES[i]], images: b.images })),
    metadata: { creativeReview: { passed: true, facts: { passed: true }, imageFit: { passed: true, checkedBeats: 4 } } }
  };
  script.fullScript = SENTENCES.join(' ');

  // Filter geometry: output frame is fixed 1080x1920; the photo keeps its aspect ratio (tall photo is capped, not squeezed).
  assert.match(kenBurnsFilter('zoom-in', 3, { width: 1600, height: 1067 }), /s=1080x720:/);
  assert.match(kenBurnsFilter('pan-left', 3, { width: 900, height: 1600 }), /s=844x1500:/);
  const timeline = beatTimeline([{ narration: 'a b c d' }, { narration: 'a b' }], { duration: 10, speechStart: 1, speechEnd: 9 });
  assert.ok(Math.abs(timeline[0].seconds - (1 + 8 * (4 / 6))) < 1e-9 && Math.abs(timeline[1].seconds - (10 - (1 + 8 * (4 / 6)))) < 1e-9, 'beat time follows its word share and covers the whole narration');

  // Real render: voice stand-in = 12 s tone; the pipeline never calls a TTS or image provider.
  let narrated = null;
  const narrate = async (text, out) => {
    narrated = text;
    await runFFmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=12', '-ar', '24000', '-ac', '1', out]);
  };
  const result = await produceDocumentaryShort({ story, script, narrate, workDir: path.join(dir, 'out') });
  assert.strictEqual(narrated, SENTENCES.join(' '));
  assert.strictEqual(result.video.width, 1080);
  assert.strictEqual(result.video.height, 1920);
  assert.ok(result.video.hasAudio);
  assert.ok(Math.abs(result.video.duration - 12) < 0.8, `duration ${result.video.duration} follows the narration`);
  assert.strictEqual(result.render.segments.length, 4);
  assert.ok(new Set(result.render.segments.map(s => s.motion)).size === 4, 'motion varies between beats');
  assert.ok(fs.existsSync(result.thumbnailPath) && fs.statSync(result.thumbnailPath).size > 2000, 'thumbnail from the real image exists');
  assert.ok(fs.readFileSync(path.join(dir, 'out', 'captions.srt'), 'utf8').includes('ship'), 'captions carry the narration');

  // Ken Burns really moves: a mid-clip frame differs from a frame near the end of the same clip.
  const seg = result.render.segments[0];
  const frame = async (t, name) => { const f = path.join(dir, name); await runFFmpeg(['-y', '-ss', String(t), '-i', seg.clip, '-frames:v', '1', '-update', '1', f]); return crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex'); };
  assert.notStrictEqual(await frame(0.1, 'f1.png'), await frame(Math.max(0.3, seg.seconds - 0.2), 'f2.png'));

  // SEO: attribution unchanged in the description, title length, tags.
  const seo = buildSeo(script, story);
  assert.ok(seo.description.includes(story.attribution));
  assert.ok(seo.title.length <= 70 && seo.tags.includes('Mary Celeste'));

  // The gate passes the real production and rejects every kind of damage.
  assert.deepStrictEqual(result.gate.checks.filter(c => !c.passed), [], JSON.stringify(result.gate.checks.filter(c => !c.passed)));
  assert.strictEqual(result.gate.passed, true);
  const base = { story, script, description: result.seo.description, video: result.video };
  const failing = (input, id) => {
    const verdict = checkDocumentaryProduction(input);
    assert.strictEqual(verdict.passed, false, `must fail: ${id}`);
    assert.ok(verdict.checks.some(c => c.id === id && !c.passed), `${id} must be the failing check, got ${JSON.stringify(verdict.checks.filter(c => !c.passed).map(c => c.id))}`);
  };
  const clone = value => JSON.parse(JSON.stringify(value));
  const withStory = mutate => { const s = clone(story); mutate(s); return { ...base, story: s, script: { ...clone(script), beats: clone(script.beats), metadata: script.metadata } }; };

  failing(withStory(s => { s.plan.beats[1].images[0].license = 'CC BY-NC 4.0'; }), 'license_free_per_image');
  failing(withStory(s => { s.plan.beats[2].images[0].license = ''; }), 'license_free_per_image');
  failing(withStory(s => { s.plan.beats[2].images[0].license = 'All rights reserved'; }), 'license_free_per_image');
  failing(withStory(s => { s.plan.beats[1].images[0].author = null; }), 'author_for_cc_by');
  failing(withStory(s => { s.plan.beats[0].images[0].descriptionUrl = 'https://example.com/x.jpg'; }), 'source_url_per_image');
  failing(withStory(s => { s.plan.beats[3].images = []; }), 'footage_per_beat');
  failing(withStory(s => { s.plan.beats[0].images[0].sha256 = 'f'.repeat(64); }), 'image_files_intact');
  failing(withStory(s => { s.revision_id = null; }), 'source_recorded');
  failing({ ...base, description: base.description.replace(story.attribution, 'Images: various') }, 'attribution_in_description');
  failing({ ...base, description: buildDescription(script, story).replace(/https:\/\/commons\.wikimedia\.org\/wiki\/File:Photo_2\.png/, 'removed') }, 'attribution_in_description');
  failing({ ...base, video: { ...base.video, width: 1920, height: 1080 } }, 'video_format');
  failing({ ...base, video: { ...base.video, duration: 75 } }, 'video_format');
  const invented = clone(script); invented.beats[1].narration += ' Forty-two sailors vanished.'; invented.beats[1].images = script.beats[1].images; invented.metadata = script.metadata;
  failing({ ...base, script: invented }, 'claims_map_to_source');
  const unreviewed = { ...clone(script), metadata: {} };
  failing({ ...base, script: unreviewed }, 'claims_verified_by_editor');
  const withFit = (imageFit) => { const copy = clone(script); copy.metadata = { creativeReview: { passed: true, facts: { passed: true }, ...(imageFit ? { imageFit } : {}) } }; return copy; };
  failing({ ...base, script: withFit(null) }, 'images_fit_narration');
  failing({ ...base, script: withFit({ passed: false, checkedBeats: 4 }) }, 'images_fit_narration');
  failing({ ...base, script: withFit({ passed: true, checkedBeats: 3 }) }, 'images_fit_narration');
  const swapped = clone(script); swapped.beats[0].images = script.beats[1].images; swapped.metadata = script.metadata;
  failing({ ...base, script: swapped }, 'claims_map_to_source');

  // Captions sit in the lower part of the frame, clear of the Shorts UI. (Seen on the first VM render: the style was written
  // for 1920 px but libass scaled it from a 288 px script, so the captions landed in the top third over the picture.)
  const { subtitleFilter } = require('../utils/dark-history/documentary-render');
  const sharp = require('sharp');
  const srt = path.join(dir, 'caption-test.srt');
  fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:02,500\nDISCOVERED ADRIFT\n');
  const black = path.join(dir, 'caption-test.mp4');
  await runFFmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=black:s=1080x1920:d=2.5:r=30', '-vf', subtitleFilter(srt), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', black]);
  const shot = path.join(dir, 'caption-test.png');
  await runFFmpeg(['-y', '-ss', '1', '-i', black, '-frames:v', '1', '-update', '1', shot]);
  const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
  let top = Infinity; let bottom = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const at = (y * info.width + x) * info.channels;
      if (data[at] > 235 && data[at + 1] > 235 && data[at + 2] > 235) { top = Math.min(top, y); bottom = Math.max(bottom, y); break; }
    }
  }
  assert.ok(bottom > 0, 'the caption is drawn');
  assert.ok(top > 0.55 * info.height && bottom < 0.92 * info.height, `caption rows ${top}-${bottom} of ${info.height} must lie in the lower part of the frame`);
  assert.ok(bottom - top > 30 && bottom - top < 200, `caption height ${bottom - top} px is readable but not huge`);

  // Captions stay readable on any picture, also a newspaper page: they sit in a dark box. (Owner review: captions fell on a page of
  // text and could not be read.) White picture, caption box = a run of dark pixels under the white letters.
  const whiteVideo = path.join(dir, 'caption-white.mp4');
  await runFFmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=white:s=1080x1920:d=2.5:r=30', '-vf', subtitleFilter(srt), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', whiteVideo]);
  const whiteShot = path.join(dir, 'caption-white.png');
  await runFFmpeg(['-y', '-ss', '1', '-i', whiteVideo, '-frames:v', '1', '-update', '1', whiteShot]);
  const whiteRaw = await sharp(whiteShot).raw().toBuffer({ resolveWithObject: true });
  let darkTotal = 0; let darkLowest = 0;
  for (let y = 0; y < whiteRaw.info.height; y += 1) {
    let rowDark = 0;
    for (let x = 0; x < whiteRaw.info.width; x += 1) if (whiteRaw.data[(y * whiteRaw.info.width + x) * whiteRaw.info.channels] < 110) rowDark += 1;
    darkTotal += rowDark;
    if (rowDark) darkLowest = y;
  }
  // letter outlines alone darken ~14,000 pixels of a white picture; a box under the letters ~46,000
  assert.ok(darkTotal > 30000, `a dark caption box (not only letter outlines) sits on a white picture: ${darkTotal} dark pixels`);
  assert.ok(darkLowest > 0.55 * whiteRaw.info.height && darkLowest < 0.92 * whiteRaw.info.height, 'the box is in the lower part of the frame');

  // A tall picture (a newspaper page) is not repeated by its own blurred copy at the sides: the bars are plain dark.
  const { renderStill } = require('../utils/dark-history/documentary-render');
  const tallPng = path.join(dir, 'tall.png');
  await runFFmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc2=s=900x1600,format=rgb24', '-frames:v', '1', '-update', '1', tallPng]);
  const tallClip = await renderStill(tallPng, 1, 'zoom-in', path.join(dir, 'tall.mp4'), { size: { width: 900, height: 1600 } });
  const tallShot = path.join(dir, 'tall-frame.png');
  await runFFmpeg(['-y', '-ss', '0.5', '-i', tallClip, '-frames:v', '1', '-update', '1', tallShot]);
  const tallRaw = await sharp(tallShot).raw().toBuffer({ resolveWithObject: true });
  let barMin = 255; let barMax = 0;
  for (let y = 100; y < tallRaw.info.height - 100; y += 7) for (let x = 0; x < 50; x += 1) { const v = tallRaw.data[(y * tallRaw.info.width + x) * tallRaw.info.channels]; barMin = Math.min(barMin, v); barMax = Math.max(barMax, v); }
  assert.ok(barMax < 40 && barMax - barMin < 12, `the side bar of a tall picture is plain dark (luma ${barMin}-${barMax}), not a blurred ghost of the picture`);

  // No picture is held for more than a few seconds: a beat that would keep one picture on screen too long stops the render
  // (owner review: one desk photo stayed up for about 15 s). The gate re-checks the stored scene durations before every upload.
  const { MAX_IMAGE_SECONDS } = require('../utils/dark-history/documentary-render');
  assert.ok(MAX_IMAGE_SECONDS <= 10);
  const lopsided = { ...script, beats: script.beats.map((b, i) => (i === 0 ? { ...b, narration: Array(40).fill('word').join(' ') } : { ...b, narration: 'ok ok' })) };
  await assert.rejects(() => produceDocumentaryShort({ story, script: lopsided, narrate: async (text, out) => runFFmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=30', '-ar', '24000', '-ac', '1', out]), workDir: path.join(dir, 'lopsided') }), error => error.code === 'IMAGE_HELD_TOO_LONG');
  failing({ ...base, video: base.video, segments: [{ seconds: 4 }, { seconds: MAX_IMAGE_SECONDS + 3 }] }, 'image_hold_limit');
  assert.strictEqual(checkDocumentaryProduction({ ...base, segments: [{ seconds: 4 }, { seconds: 5 }] }).checks.find(c => c.id === 'image_hold_limit').passed, true);

  // Near-duplicate pictures (two photographs of the same desk, a page and its twin) are refused by the gate, and so is a story
  // whose pictures were never fingerprinted.
  const { dhash } = require('../utils/dark-history/dhash');
  const hashed = clone(story);
  for (const beat of hashed.plan.beats) for (const image of beat.images) image.dhash = await dhash(path.join(folder, image.file));
  const twin = clone(hashed);
  twin.plan.beats[1].images[0].dhash = twin.plan.beats[0].images[0].dhash;
  const hashedScript = clone(script); hashedScript.metadata = script.metadata; hashedScript.beats = script.beats;
  const hashedBase = { ...base, story: hashed, script: hashedScript };
  assert.strictEqual(checkDocumentaryProduction(hashedBase).checks.find(c => c.id === 'no_near_duplicate_images').passed, true);
  const twinVerdict = checkDocumentaryProduction({ ...hashedBase, story: twin });
  assert.ok(twinVerdict.checks.some(c => c.id === 'no_near_duplicate_images' && !c.passed), 'near-duplicate pictures fail the gate');
  const bare = clone(story);
  for (const beat of bare.plan.beats) for (const image of beat.images) delete image.dhash;
  assert.ok(checkDocumentaryProduction({ ...base, story: bare }).checks.some(c => c.id === 'no_near_duplicate_images' && !c.passed), 'pictures without a fingerprint fail the gate');

  // A narration the Short cannot hold is refused before any rendering (the gate allows 60 s).
  const tooLong = async (text, out) => runFFmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=62', '-ar', '24000', '-ac', '1', out]);
  await assert.rejects(() => produceDocumentaryShort({ story, script, narrate: tooLong, workDir: path.join(dir, 'long') }), error => error.code === 'NARRATION_TOO_LONG' && /62/.test(error.message));
  assert.ok(!fs.existsSync(path.join(dir, 'long', 'short.mp4')), 'nothing was rendered for a narration that is too long');

  fs.unlinkSync(path.join(folder, beats[0].images[0].file));
  failing(base, 'image_files_intact');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('dark-history production tests passed');
})().catch(error => { console.error(error); process.exit(1); });
