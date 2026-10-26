// Real-FFmpeg test for speech-aware caption timing.
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
    // Round trip through SRT text.
    const srt = timing.cuesToSrt(cues);
    assert.equal((srt.match(/-->/g) || []).length, cues.length);
    assert.match(srt, /00:00:01,[0-9]{3} --> /);

    console.log('Speech timing: PASS');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exit(1); });
