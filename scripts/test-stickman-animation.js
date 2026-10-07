// Animated Dark Stickman beats (ANIMATED_SCENES): same character in every frame, the hook clip
// passes the real hook_opening frame analysis, and the generator only animates when the flag is on
// and keeps the still for any beat it cannot animate.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runFFmpeg, checkFFmpeg, getMediaDuration } = require('../utils/ffmpeg');
const scene = require('../utils/stickman-scene');
const anim = require('../utils/stickman-animation');
const { HOOK_LIMITS, analyzeOpeningFrames } = require('../utils/speech-timing');

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const prompt = (index, total, text) => `HORROR STICKMAN BRAND LOCK:\nno text, cinematic shadow\nBEAT POSITION: ${index} of ${total}\nSCENE: ${text}\nSTORY BEAT: ${text}`;

function assertBones(skeleton, label) {
  const C = scene.CHARACTER;
  for (const arm of skeleton.arms) {
    assert.ok(Math.abs(dist(skeleton.shoulder, arm.elbow) - C.upperArm) < 0.01, `${label}: upper arm length`);
    assert.ok(Math.abs(dist(arm.elbow, arm.hand) - C.foreArm) < 0.01, `${label}: forearm length`);
  }
  for (const leg of skeleton.legs) {
    assert.ok(Math.abs(dist(skeleton.hip, leg.knee) - C.thigh) < 0.01, `${label}: thigh length`);
    assert.ok(Math.abs(dist(leg.knee, leg.foot) - C.shin) < 0.01, `${label}: shin length`);
  }
  assert.ok(Math.abs(dist(skeleton.hip, skeleton.shoulder) - C.torso) < 0.01, `${label}: torso length`);
}

async function grayFrame(videoPath, seconds, directory, name) {
  const out = path.join(directory, `${name}.gray`);
  await runFFmpeg(['-y', '-ss', String(seconds), '-i', videoPath, '-frames:v', '1', '-vf', 'scale=72:128,format=gray', '-f', 'rawvideo', out]);
  return fs.readFile(out);
}

async function main() {
  assert.ok(await checkFFmpeg(), 'FFmpeg is required');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stickman-anim-test-'));
  const previous = { flag: process.env.ANIMATED_SCENES, fps: process.env.ANIMATED_SCENES_FPS };
  try {
    // 1. Off by default.
    delete process.env.ANIMATED_SCENES;
    assert.equal(anim.isAnimationEnabled(), false, 'animation must be off unless ANIMATED_SCENES=true');
    assert.equal(anim.isAnimationEnabled({ ANIMATED_SCENES: 'true' }), true);

    // 2. Without options the scene is exactly the still (the look does not change with the flag off).
    for (const text of ['ear against wall phone buzzing', 'bedroom door locked', 'mirror reflection not you']) {
      const p = prompt(2, 5, text);
      assert.equal(scene.buildStickmanScene(p, {}).svg, scene.buildStickmanScene(p).svg, 'empty options changed the still');
    }

    // 3. Every frame of every beat type keeps the reference character: same bone lengths, same hash.
    const beats = [
      prompt(1, 6, 'the phone buzzed again with a message from his own number'),
      prompt(2, 6, 'he walked down the hallway toward the knocking'),
      prompt(3, 6, 'he reached for the bedroom door handle'),
      prompt(4, 6, 'the knocking inside the wall answered him'),
      prompt(5, 6, 'he crouched by the bed and looked at the mirror'),
      prompt(6, 6, 'the shadow behind him was already inside the room')
    ];
    for (const p of beats) {
      const plan = anim.planBeat(p, 4.5, { fps: 12 });
      assert.equal(plan.frames, 54);
      for (let index = 0; index < plan.frames; index += 1) {
        const options = anim.frameOptions(plan, index);
        assertBones(scene.skeleton(options.pose), `${plan.meta.pose} frame ${index}`);
        const built = scene.buildStickmanScene(p, options);
        assert.equal(built.meta.characterHash, scene.CHARACTER_HASH, 'character hash changed inside a beat');
        assert.equal(built.meta.pose, plan.meta.pose, 'a beat changed its pose label mid-clip');
        const [, , w, h] = built.svg.match(/viewBox="([^"]+)"/)[1].split(' ').map(Number);
        assert.ok(Math.abs(w / h - 1080 / 1920) < 0.002, 'a frame is not 9:16');
      }
      // Hook and twist never cut away; long middle beats without a presence get a closer second shot.
      if (plan.isHook || plan.isTwist) assert.equal(plan.cutaway, false, `${plan.meta.composition} must stay on its own framing`);
    }
    assert.ok(beats.map(p => anim.planBeat(p, 4.5)).some(plan => plan.cutaway), 'no middle beat got a second shot');

    // 4. Hook clip: right size and length, and it passes the real hook_opening frame analysis with margin.
    const hookClip = path.join(directory, 'hook.mp4');
    const hook = await anim.renderBeatClip(beats[0], 3, hookClip, { fps: 12 });
    assert.equal(hook.characterHash, scene.CHARACTER_HASH);
    const probe = await runFFmpeg(['-hide_banner', '-i', hookClip, '-f', 'null', '-'])
      .then(result => `${result.stdout}${result.stderr}`, error => String(error.stderr || error.message));
    assert.match(probe, /1080x1920/, 'clip is not 1080x1920');
    const hookSeconds = await getMediaDuration(hookClip);
    assert.ok(Math.abs(hookSeconds - 3) < 0.15, `hook clip lasts ${hookSeconds}s, expected 3s`);
    const frames = await analyzeOpeningFrames(hookClip);
    assert.ok(frames.mean >= HOOK_LIMITS.minFirstFrameMean * 1.5, `hook first frame too dark: mean ${frames.mean.toFixed(1)}`);
    assert.ok(frames.stddev >= HOOK_LIMITS.minFirstFrameStddev * 1.5, `hook first frame has no structure: ${frames.stddev.toFixed(1)}`);
    assert.ok(frames.motion >= HOOK_LIMITS.minOpeningMotion * 2, `hook opening is static: motion ${frames.motion.toFixed(2)}`);
    console.log(`hook clip: ${hook.frames} frames via ${hook.rasterizer} in ${hook.renderMs} ms, mean ${frames.mean.toFixed(1)}, contrast ${frames.stddev.toFixed(1)}, motion ${frames.motion.toFixed(2)}`);

    // 5. A middle beat really moves (not a still with a zoom), across both shots.
    const midClip = path.join(directory, 'mid.mp4');
    const mid = await anim.renderBeatClip(beats[2], 4.5, midClip, { fps: 12 });
    assert.equal(mid.cutaway, true);
    const a = await grayFrame(midClip, 0.2, directory, 'a');
    const b = await grayFrame(midClip, 1.8, directory, 'b');
    const c = await grayFrame(midClip, 4.0, directory, 'c');
    const diff = (x, y) => x.reduce((sum, value, index) => sum + Math.abs(value - y[index]), 0) / x.length;
    assert.ok(diff(a, b) > 0.3, `the figure did not move inside shot 1 (${diff(a, b).toFixed(2)})`);
    assert.ok(diff(b, c) > 0.3, `the cut to shot 2 is not visible (${diff(b, c).toFixed(2)})`);
    console.log(`middle clip: ${mid.frames} frames in ${mid.renderMs} ms (${(mid.renderMs / mid.frames).toFixed(0)} ms/frame)`);

    // 6. Generator wiring: off -> stills only; on -> every local beat animated, other images kept still.
    const { AIVideoGenerator } = require('../utils/ai-video-generator');
    const generator = new AIVideoGenerator({});
    const images = [];
    for (let index = 1; index <= 3; index += 1) {
      const imagePath = path.join(directory, `beat${index}.png`);
      await generator.generateLocalStickmanImage(beats[index === 3 ? 5 : index - 1], imagePath);
      images.push(imagePath);
    }
    const foreign = path.join(directory, 'foreign.png');
    await fs.copyFile(images[0], foreign);
    const audio = path.join(directory, 'silence.mp3');
    await runFFmpeg(['-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '10', audio]);
    const timeline = [...images, foreign].map(imagePath => ({ path: imagePath, duration: 2.5 }));

    delete process.env.ANIMATED_SCENES;
    await generator.generateHybridVideo([], [...images, foreign], audio, path.join(directory, 'off.mp4'), 10, { imageTimeline: timeline });
    assert.equal(generator.lastAnimationResult, null, 'flag off must not animate');

    process.env.ANIMATED_SCENES = 'true';
    process.env.ANIMATED_SCENES_FPS = '12';
    const onPath = path.join(directory, 'on.mp4');
    await generator.generateHybridVideo([], [...images, foreign], audio, onPath, 10, { imageTimeline: timeline });
    const result = generator.lastAnimationResult;
    assert.ok(result && result.enabled, 'flag on did not record an animation result');
    assert.equal(result.totalBeats, 4);
    assert.equal(result.animatedBeats, 3, `expected 3 animated beats: ${JSON.stringify(result.beats.map(beat => beat.reason || 'ok'))}`);
    assert.equal(result.beats[3].animated, false, 'an image without a stickman prompt must keep its still');
    const onSeconds = await getMediaDuration(onPath);
    assert.ok(Math.abs(onSeconds - 10) < 0.8, `animated Short lasts ${onSeconds}s, expected about 10s`);
    console.log(`generator: ${result.animatedBeats}/${result.totalBeats} beats animated in ${result.renderMs} ms`);
  } finally {
    if (previous.flag === undefined) delete process.env.ANIMATED_SCENES; else process.env.ANIMATED_SCENES = previous.flag;
    if (previous.fps === undefined) delete process.env.ANIMATED_SCENES_FPS; else process.env.ANIMATED_SCENES_FPS = previous.fps;
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
  console.log('Stickman animation test completed successfully');
}

main().catch(error => { console.error(error); process.exit(1); });
