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

async function makeImage(file, width, height, color) {
  await runFFmpeg(['-y', '-f', 'lavfi', '-i', `testsrc2=s=${width}x${height}:d=1,format=rgb24`, '-frames:v', '1', '-update', '1', file]);
  void color;
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
    await makeImage(tmp, dims[i][0], dims[i][1]);
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
    metadata: { creativeReview: { passed: true, facts: { passed: true } } }
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
  const swapped = clone(script); swapped.beats[0].images = script.beats[1].images; swapped.metadata = script.metadata;
  failing({ ...base, script: swapped }, 'claims_map_to_source');
  fs.unlinkSync(path.join(folder, beats[0].images[0].file));
  failing(base, 'image_files_intact');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('dark-history production tests passed');
})().catch(error => { console.error(error); process.exit(1); });
