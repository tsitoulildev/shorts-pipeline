// Real-FFmpeg test for speech-aware caption timing and the first-1.5-seconds hook check.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runFFmpeg, checkFFmpeg } = require('../utils/ffmpeg');
const timing = require('../utils/speech-timing');

async function ff(args) { await runFFmpeg(['-y', ...args], { timeoutMs: 120000 }); }

async function main() {
  assert.ok(await checkFFmpeg(), 'FFmpeg is required');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'speech-timing-'));
  try {
    // Voice: silent until 1.6 s, pauses at 4.6-5.2 s and 7.2-7.7 s, speech ends at 10.7 s of 11.5 s.
    const voice = path.join(dir, 'voice.mp3');
    await ff(['-f', 'lavfi', '-i', 'sine=frequency=190:sample_rate=24000:duration=11.5',
      '-af', "tremolo=f=4:d=0.6,volume=0:enable='between(t,0,1.6)+between(t,4.6,5.2)+between(t,7.2,7.7)+between(t,10.7,11.5)'",
      '-ac', '1', '-c:a', 'libmp3lame', '-q:a', '4', voice]);
    const speech = await timing.detectSpeechWindow(voice);
    assert.ok(Math.abs(speech.speechStart - 1.6) < 0.15, `speech start ${speech.speechStart}`);
    assert.ok(Math.abs(speech.speechEnd - 10.7) < 0.2, `speech end ${speech.speechEnd}`);
    assert.equal(speech.pauses.length, 2, `pauses ${JSON.stringify(speech.pauses)}`);

    const words = 'He heard knocking inside the wall. It stopped when he listened. Then it answered his steps, one by one, slowly.'.split(/\s+/);
    const cues = timing.buildCaptionCues(words, { start: speech.speechStart, end: speech.speechEnd }, 4);
    assert.ok(cues[0].start >= 1.5 && cues[0].start < 1.8, `first cue at ${cues[0].start}`);
    assert.ok(Math.abs(cues[cues.length - 1].end - speech.speechEnd) < 0.3);
    assert.ok(cues.every(cue => cue.text.split(' ').length <= 4));
    // Cues never straddle a sentence end.
    assert.ok(cues.slice(0, -1).every(cue => !/[.!?]\s\S/.test(cue.text)));
    assert.ok(cues.every((cue, i) => i === 0 || cue.start >= cues[i - 1].end - 0.001), 'cues overlap');
    assert.equal(timing.evaluateCaptionSync({ speech, cues }).passed, true);
    // Round trip through SRT text.
    const reparsed = timing.parseSrt(timing.cuesToSrt(cues));
    assert.equal(reparsed.length, cues.length);
    assert.ok(Math.abs(reparsed[1].start - cues[1].start) < 0.002);
    // The old even per-word split would have started at 0 s while the voice starts at 1.6 s.
    const even = words.map((_, i) => i).filter(i => i % 4 === 0).map(i => ({ start: i * (10.7 / words.length), end: (i + 4) * (10.7 / words.length), text: 'x' }));
    assert.equal(timing.evaluateCaptionSync({ speech, cues: even }).passed, false);

    // Opening frames: a dark structured scene with a push-in passes; static or black does not.
    const still = path.join(dir, 'still.png');
    await ff(['-f', 'lavfi', '-i', 'color=c=0x0b0e16:s=1080x1920',
      '-vf', 'drawbox=x=430:y=700:w=220:h=220:color=0xb8bcc5@1:t=fill,drawbox=x=520:y=900:w=40:h=480:color=0xb8bcc5@1:t=fill,drawbox=x=330:y=1000:w=420:h=36:color=0xb8bcc5@1:t=fill',
      '-frames:v', '1', still]);
    const frames = 120;
    const zoom = `scale=1620:2880,zoompan=z='1+0.12*(on/${frames})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=30`;
    const moving = path.join(dir, 'moving.mp4');
    await ff(['-loop', '1', '-framerate', '30', '-t', '4', '-i', still, '-vf', `${zoom},format=yuv420p`, '-c:v', 'libx264', '-preset', 'ultrafast', moving]);
    const staticVideo = path.join(dir, 'static.mp4');
    await ff(['-loop', '1', '-framerate', '30', '-t', '4', '-i', still, '-vf', 'format=yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', staticVideo]);
    const black = path.join(dir, 'black.mp4');
    await ff(['-f', 'lavfi', '-i', 'color=c=black:s=1080x1920:r=30:d=4', '-vf', 'format=yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', black]);

    const mFrames = await timing.analyzeOpeningFrames(moving);
    const sFrames = await timing.analyzeOpeningFrames(staticVideo);
    const bFrames = await timing.analyzeOpeningFrames(black);
    console.log(`opening motion: moving=${mFrames.motion.toFixed(3)} static=${sFrames.motion.toFixed(3)} black=${bFrames.motion.toFixed(3)}; contrast moving=${mFrames.stddev.toFixed(1)}`);

    const okSpeech = { speechStart: 0.2 };
    const okCues = [{ start: 0.3, end: 1.5, text: 'x' }];
    assert.equal(timing.evaluateHook({ speech: okSpeech, cues: okCues, frames: mFrames }).passed, true, timing.evaluateHook({ speech: okSpeech, cues: okCues, frames: mFrames }).message);
    assert.match(timing.evaluateHook({ speech: okSpeech, cues: okCues, frames: sFrames }).message, /static/);
    assert.match(timing.evaluateHook({ speech: okSpeech, cues: okCues, frames: bFrames }).message, /black/);
    assert.match(timing.evaluateHook({ speech: { speechStart: 1.8 }, cues: okCues, frames: mFrames }).message, /voice starts/);
    assert.match(timing.evaluateHook({ speech: okSpeech, cues: [{ start: 2.2, end: 3, text: 'x' }], frames: mFrames }).message, /first caption/);
    assert.equal(timing.evaluateHook({ speech: okSpeech, cues: [], frames: mFrames }).passed, false);

    console.log('Speech timing: PASS');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exit(1); });
