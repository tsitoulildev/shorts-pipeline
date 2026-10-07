/**
 * Dark Stickman beat animation (free, local, deterministic).
 *
 * Turns one beat (the same prompt the still renderer uses) into a short clip:
 *  - the reference figure moves from a rest pose into the beat's pose (only joint angles change,
 *    so CHARACTER and CHARACTER_HASH are untouched), then breathes with a small head sway;
 *  - the beat's prop reacts (door opens a gap, phone screen glows, knock rings pulse);
 *  - shot 1 is the beat's own composition with a slow camera push; beats long enough get a
 *    second, closer shot on the figure (a cut inside the beat), except the hook and the twist,
 *    which stay on their own framing so the first frame and the final reveal never change.
 *
 * Off unless ANIMATED_SCENES=true. Any failure is reported to the caller, which keeps the still.
 */
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { buildStickmanScene, POSES, COMPOSITIONS } = require('./stickman-scene');
const { runFFmpeg } = require('./ffmpeg');

let sharp = null;
try { sharp = require('sharp'); } catch (_error) { sharp = null; }

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const lerp = (a, b, t) => a + (b - a) * t;
const easeInOut = t => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);

function isAnimationEnabled(env = process.env) {
  return /^(1|true|yes)$/i.test(String(env.ANIMATED_SCENES || '').trim());
}

// 12 fps is classic 2D animation "on twos"; the final timeline is still encoded at 30 fps.
function animationFps(env = process.env) {
  const value = Number(env.ANIMATED_SCENES_FPS);
  return Number.isFinite(value) && value > 0 ? clamp(Math.round(value), 8, 30) : 12;
}

// Frames are rasterized at this fraction of 1080x1920 and upscaled by FFmpeg. The style is soft
// and dark, so 0.5 looks the same on a phone and renders about 4x faster than full size.
function renderScale(env = process.env) {
  const value = Number(env.ANIMATED_SCENES_RENDER_SCALE);
  return Number.isFinite(value) && value > 0 ? clamp(value, 0.25, 1) : 0.5;
}

/** Interpolate two angle sets; bone lengths never enter here. */
function blendPose(a, b, t) {
  const pair = (x, y) => [lerp(x[0], y[0], t), lerp(x[1], y[1], t)];
  return {
    lean: lerp(a.lean, b.lean, t),
    tilt: lerp(a.tilt, b.tilt, t),
    armF: [pair(a.armF[0], b.armF[0]), pair(a.armF[1], b.armF[1])],
    legs: [pair(a.legs[0], b.legs[0]), pair(a.legs[1], b.legs[1])]
  };
}

/** The walk pose with arms and legs swapped: the other half of a step. */
function mirroredWalk() {
  const w = POSES.walk;
  return { lean: w.lean, tilt: w.tilt, armF: [w.armF[1], w.armF[0]], legs: [w.legs[1], w.legs[0]] };
}

/** Where a beat starts from, so its action reads as a movement into the beat's pose. */
function restPoseFor(target) {
  if (target === 'stare') return { ...POSES.stare, tilt: -12 };
  if (target === 'walk') return mirroredWalk();
  return POSES.stare;
}

/**
 * Plan one beat. Pure: returns everything needed to draw frame i without rendering anything.
 */
function planBeat(prompt, durationSeconds, options = {}) {
  const fps = options.fps || animationFps();
  const duration = Math.max(0.5, Number(durationSeconds) || 0);
  const frames = Math.max(2, Math.round(duration * fps));
  const still = buildStickmanScene(prompt);
  const meta = still.meta;
  const composition = COMPOSITIONS.find(item => item.name === meta.composition) || COMPOSITIONS[0];
  const isHook = meta.composition === 'hook-closeup';
  const isTwist = meta.composition === 'twist-wide';
  // A cut to a closer shot needs time for both shots and must not hide the shadow presence.
  const cutaway = !isHook && !isTwist && !meta.presence && duration >= 3.5;
  const cutAt = cutaway ? Math.round(frames * 0.56) : frames;
  const target = POSES[meta.pose] || POSES.stare;
  const rest = restPoseFor(meta.pose);
  const focus = {
    focusX: composition.figureX,
    focusY: composition.floor - composition.scale * 560
  };
  return { prompt, fps, duration, frames, cutAt, cutaway, isHook, isTwist, meta, target, rest, focus };
}

/** Scene options for frame i of a planned beat. */
function frameOptions(plan, index) {
  const t = index / Math.max(1, plan.frames - 1);
  const seconds = index / plan.fps;
  const move = easeInOut(clamp((t - 0.06) / 0.42, 0, 1));
  let pose;
  if (plan.meta.pose === 'walk') {
    // Continuous step cycle, about one step every 0.8 s.
    const cycle = (Math.sin((seconds / 0.8) * Math.PI * 2) + 1) / 2;
    pose = blendPose(mirroredWalk(), POSES.walk, cycle);
  } else {
    pose = blendPose(plan.rest, plan.target, move);
  }
  const headTilt = 1.4 * Math.sin((seconds / 2.6) * Math.PI * 2);
  const propPhase = plan.meta.props.includes('phone')
    ? (0.5 + 0.5 * Math.sin(seconds * Math.PI * 2 * 0.9))
    : move;

  let camera;
  if (index < plan.cutAt) {
    const local = index / Math.max(1, plan.cutAt - 1);
    // Hook push matches the old push-in-fast still move; other beats creep in.
    const push = plan.isHook ? 0.12 : (plan.isTwist ? 0.05 : 0.06);
    camera = { zoom: 1 + push * local, focusX: 540, focusY: 960 };
  } else {
    const local = (index - plan.cutAt) / Math.max(1, plan.frames - plan.cutAt - 1);
    camera = { zoom: 1.42 + 0.04 * local, ...plan.focus };
  }
  return { pose, headTilt, propPhase, camera };
}

async function rasterizeFrames(svgs, directory, signal, scale = renderScale()) {
  const name = index => path.join(directory, `frame_${String(index).padStart(5, '0')}`);
  if (sharp) {
    const concurrency = clamp(os.cpus().length, 1, 4);
    let next = 0;
    const worker = async () => {
      while (next < svgs.length) {
        if (signal?.aborted) throw Object.assign(new Error('Animation cancelled'), { code: 'JOB_CANCELLED' });
        const index = next;
        next += 1;
        await sharp(Buffer.from(svgs[index]), { density: 72 * scale }).png({ compressionLevel: 1 }).toFile(`${name(index)}.png`);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    return { pattern: path.join(directory, 'frame_%05d.png'), rasterizer: 'sharp' };
  }
  // Without sharp (local checks only): FFmpeg's librsvg reads the SVG sequence directly.
  await Promise.all(svgs.map((svg, index) => fs.writeFile(`${name(index)}.svg`, svg)));
  return { pattern: path.join(directory, 'frame_%05d.svg'), rasterizer: 'ffmpeg-librsvg' };
}

/**
 * Render one beat to an MP4 clip (1080x1920, no audio). Returns evidence for provenance/QA.
 */
async function renderBeatClip(prompt, durationSeconds, outputPath, options = {}) {
  const started = Date.now();
  const plan = planBeat(prompt, durationSeconds, options);
  const svgs = [];
  for (let index = 0; index < plan.frames; index += 1) {
    svgs.push(buildStickmanScene(prompt, frameOptions(plan, index)).svg);
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stickman-anim-'));
  try {
    const { pattern, rasterizer } = await rasterizeFrames(svgs, directory, options.signal);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await runFFmpeg([
      '-y', '-framerate', String(plan.fps), '-i', pattern,
      '-vf', 'scale=1080:1920:flags=lanczos,format=yuv420p,setsar=1',
      '-c:v', 'libx264', '-preset', process.env.FFMPEG_PRESET || 'veryfast', '-crf', process.env.FFMPEG_CRF || '20',
      '-pix_fmt', 'yuv420p', '-an', outputPath
    ], { signal: options.signal, timeoutMs: 300000 });
    return {
      path: outputPath,
      frames: plan.frames,
      fps: plan.fps,
      duration: plan.frames / plan.fps,
      cutaway: plan.cutaway,
      pose: plan.meta.pose,
      composition: plan.meta.composition,
      characterHash: plan.meta.characterHash,
      rasterizer,
      renderMs: Date.now() - started
    };
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  isAnimationEnabled, animationFps, renderScale, blendPose, planBeat, frameOptions, renderBeatClip, restPoseFor
};
