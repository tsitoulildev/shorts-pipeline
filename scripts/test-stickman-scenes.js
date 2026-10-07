// Reference-character, variety and visual-distance tests (SVG rasterized with FFmpeg's librsvg
// here; production uses sharp, which reads the same SVG).
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runFFmpeg, checkFFmpeg } = require('../utils/ffmpeg');
const scene = require('../utils/stickman-scene');
const variety = require('../utils/visual-variety');
const { HOOK_LIMITS } = require('../utils/speech-timing');

// Rasterize like production (sharp) when installed; FFmpeg's librsvg is the local fallback.
let sharp = null;
try { sharp = require('sharp'); } catch (_error) { sharp = null; }
async function rasterize(svg, svgPath, pngPath) {
  if (sharp) { await sharp(Buffer.from(svg)).png().toFile(pngPath); return 'sharp'; }
  await fs.writeFile(svgPath, svg);
  await runFFmpeg(['-y', '-i', svgPath, '-frames:v', '1', pngPath], { timeoutMs: 60000 });
  return 'ffmpeg';
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const prompt = (index, total, text) => `HORROR STICKMAN BRAND LOCK:\nno text, cinematic shadow\nBEAT POSITION: ${index} of ${total}\nSCENE: ${text}\nSTORY BEAT: ${text}`;

const STORIES = {
  mixed: ['knocking inside the wall hallway', 'ear against wall phone buzzing', 'outside street lamp someone behind', 'bedroom door locked', 'knocking answered his steps shadow figure'],
  allBedroom: Array(7).fill('in the bedroom he stared at the bed and the door while the wall knocked'),
  allPhone: Array(6).fill('the phone buzzed again with a message from his own number'),
  plain: ['a quiet night', 'a sound', 'a pause', 'a step', 'a breath', 'a whisper', 'silence'],
  four: ['a door', 'a call', 'a step', 'the end']
};

async function main() {
  assert.ok(await checkFFmpeg(), 'FFmpeg is required');
  const C = scene.CHARACTER;

  // 1. Reference character: identical proportions in every pose, feet on the floor.
  for (const name of Object.keys(scene.POSES)) {
    const s = scene.skeleton(name);
    for (const arm of s.arms) {
      assert.ok(Math.abs(dist(s.shoulder, arm.elbow) - C.upperArm) < 0.01, `${name}: upper arm length`);
      assert.ok(Math.abs(dist(arm.elbow, arm.hand) - C.foreArm) < 0.01, `${name}: forearm length`);
    }
    for (const leg of s.legs) {
      assert.ok(Math.abs(dist(s.hip, leg.knee) - C.thigh) < 0.01, `${name}: thigh length`);
      assert.ok(Math.abs(dist(leg.knee, leg.foot) - C.shin) < 0.01, `${name}: shin length`);
      assert.ok(leg.foot.y <= 0.01, `${name}: foot below the floor`);
    }
    assert.ok(Math.abs(Math.max(...s.legs.map(l => l.foot.y))) < 0.01, `${name}: neither foot touches the floor`);
    assert.ok(Math.abs(dist(s.hip, s.shoulder) - C.torso) < 0.01, `${name}: torso length`);
  }
  assert.match(scene.CHARACTER_HASH, /^[0-9a-f]{12}$/);

  // 2. Determinism and metadata.
  const a = scene.buildStickmanScene(prompt(2, 5, STORIES.mixed[1]));
  const b = scene.buildStickmanScene(prompt(2, 5, STORIES.mixed[1]));
  assert.equal(a.svg, b.svg);
  assert.equal(a.meta.characterHash, scene.CHARACTER_HASH);
  assert.ok(a.svg.startsWith('<svg') && a.svg.includes('viewBox="0 0 1080 1920"'));

  // 3. Brand-lock words must not create props (the old phone-and-shadow-in-every-beat bug).
  const plain = scene.buildStickmanScene(prompt(3, 5, 'a quiet night'));
  assert.deepEqual(plain.meta.props, []);
  assert.ok(!plain.svg.includes('stroke="#d7d9df"'), 'a phone appeared without a story cue');

  // 4. Structural variety holds for every story shape, including single-setting stories.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stickman-scenes-'));
  try {
    for (const [name, beats] of Object.entries(STORIES)) {
      const rendered = beats.map((text, i) => scene.buildStickmanScene(prompt(i + 1, beats.length, text)));
      const visuals = rendered.map(item => ({ ...item.meta }));
      const verdict = variety.evaluateSceneVariety(visuals);
      assert.equal(verdict.passed, true, `${name}: ${verdict.message}`);
      assert.equal(variety.evaluateCharacterConsistency(visuals).passed, true, name);
      assert.equal(rendered[0].meta.composition, 'hook-closeup', `${name}: hook must be the close-up`);
      assert.equal(rendered[rendered.length - 1].meta.pose, 'recoil', `${name}: twist pose`);

      const thumbs = [];
      for (let i = 0; i < rendered.length; i += 1) {
        const png = path.join(dir, `${name}${i}.png`);
        await rasterize(rendered[i].svg, path.join(dir, `${name}${i}.svg`), png);
        thumbs.push(await variety.grayThumbnail(png));
      }
      const distance = variety.evaluateVisualDistance(thumbs);
      assert.equal(distance.passed, true, `${name}: ${distance.message}`);
    }

    // 4b. The hook close-up is the first frame the hook_opening gate measures (72x128 gray, same
    // as analyzeOpeningFrames). It must clear that gate's brightness and contrast floors with
    // margin in every environment, so the fix lives in the renderer and never in the gate.
    const hookSettings = ['a man stares at the kettle in a quiet room', 'the phone buzzed on the bedroom nightstand', 'a long hallway with a door at the end', 'an empty street under one lamp', 'a mirror in the corner and someone behind him', 'the elevator doors slid open'];
    for (let i = 0; i < hookSettings.length; i += 1) {
      const hook = scene.buildStickmanScene(prompt(1, 6, hookSettings[i]));
      assert.equal(hook.meta.composition, 'hook-closeup');
      const hookPng = path.join(dir, `hook${i}.png`);
      const hookGray = path.join(dir, `hook${i}.gray`);
      await rasterize(hook.svg, path.join(dir, `hook${i}.svg`), hookPng);
      await runFFmpeg(['-y', '-i', hookPng, '-frames:v', '1', '-vf', 'scale=72:128,format=gray', '-f', 'rawvideo', hookGray], { timeoutMs: 60000 });
      const pixels = await fs.readFile(hookGray);
      assert.equal(pixels.length, 72 * 128);
      let sum = 0;
      for (const v of pixels) sum += v;
      const mean = sum / pixels.length;
      let variance = 0;
      for (const v of pixels) variance += (v - mean) * (v - mean);
      const stddev = Math.sqrt(variance / pixels.length);
      assert.ok(mean >= HOOK_LIMITS.minFirstFrameMean * 1.5, `hook frame ${i} too dark (mean ${mean.toFixed(1)}, ${hook.meta.environment})`);
      assert.ok(stddev >= HOOK_LIMITS.minFirstFrameStddev * 1.5, `hook frame ${i} has no readable structure (contrast ${stddev.toFixed(1)}, ${hook.meta.environment})`);
    }

    // 5. The gates reject what they are meant to reject.
    const same = Array.from({ length: 5 }, () => ({ pose: 'stare', environment: 'room-corner', characterHash: scene.CHARACTER_HASH, characterVersion: C.version }));
    assert.equal(variety.evaluateSceneVariety(same).passed, false);
    assert.equal(variety.evaluateSceneVariety([{ pose: 'stare' }, null, null, null]).passed, false);
    const mixedVersions = [{ characterHash: scene.CHARACTER_HASH }, { characterHash: 'abcdef123456' }];
    assert.equal(variety.evaluateCharacterConsistency(mixedVersions).passed, false);
    assert.equal(variety.evaluateCharacterConsistency([{ characterHash: 'abcdef123456' }, { characterHash: 'abcdef123456' }]).passed, false, 'outdated version');
    assert.equal(variety.evaluateCharacterConsistency([null, null]).passed, false);
    assert.equal(variety.evaluateCharacterConsistency([null, null], { required: false }).passed, true);
    // Shorts rendered before the v4 redesign (waiting for review) still pass if every beat is v3; mixing does not.
    const v3 = variety.PREVIOUS_CHARACTER_HASHES['dark-stickman-v3'];
    assert.notEqual(v3, scene.CHARACTER_HASH, 'the current character must differ from v3');
    assert.equal(variety.evaluateCharacterConsistency([{ characterHash: v3, characterVersion: 'dark-stickman-v3' }, { characterHash: v3 }]).passed, true, 'v3 Short awaiting review');
    assert.equal(variety.evaluateCharacterConsistency([{ characterHash: v3 }, { characterHash: scene.CHARACTER_HASH }]).passed, false, 'v3 mixed with v4');

    // 5a. Environment v2: every place carries its own set dressing (depth, practical light, furniture).
    const signatures = {
      'room-corner': ['url(#paper)', 'url(#warm)'],
      bedroom: ['url(#paper)', 'url(#warm)', 'Q '],
      hallway: ['#170c10', 'url(#cold)'],
      street: ['url(#cold)', 'M0 470 Q']
    };
    const seen = new Set();
    for (let total = 4; total <= 7; total += 1) {
      for (let index = 1; index <= total; index += 1) {
        for (const text of ['a quiet night in the bedroom', 'outside on the street', 'the hallway', 'a sound']) {
          const built = scene.buildStickmanScene(prompt(index, total, text));
          const env = built.meta.environment;
          seen.add(env);
          for (const mark of signatures[env]) assert.ok(built.svg.includes(mark), `${env}: set dressing "${mark}" missing`);
        }
      }
    }
    assert.equal(seen.size, 4, `not every environment was exercised: ${[...seen].join(', ')}`);

    // 5b. v4 look: the protagonist always has the same cold eyes and a crisp rim-lit silhouette;
    // red glowing eyes appear only on the Other (presence / twist).
    for (const [name, beats] of Object.entries(STORIES)) {
      beats.forEach((text, index) => {
        const built = scene.buildStickmanScene(prompt(index + 1, beats.length, text));
        const svg = built.svg;
        assert.ok(svg.includes(`fill="${C.eyeColor}"`), `${name} beat ${index + 1}: protagonist eyes missing or recoloured`);
        assert.ok(svg.includes(`fill="${C.rimLight}"`), `${name} beat ${index + 1}: no rim light on the figure`);
        const isTwist = index + 1 === beats.length && beats.length > 1;
        const other = svg.includes(`fill="${C.otherEyeColor}"`);
        if (isTwist) assert.ok(other, `${name}: the twist has no red-eyed Other`);
        if (other) assert.ok(isTwist || /shadow|behind|presence|someone|figure|person outside|not you|reflection/.test(scene.sceneText(prompt(index + 1, beats.length, text))), `${name} beat ${index + 1}: red eyes without a presence`);
      });
    }
    const t = await variety.grayThumbnail(path.join(dir, 'mixed0.png'));
    const almost = Buffer.from(t); almost[0] = Math.min(255, almost[0] + 1);
    assert.equal(variety.evaluateVisualDistance([t, almost]).passed, false, 'a one-pixel change must not count as a different image');
    assert.equal(variety.evaluateVisualDistance([t]).passed, false);

    console.log(`Stickman scenes: PASS (rasterizer: ${sharp ? 'sharp' : 'ffmpeg'})`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exit(1); });
