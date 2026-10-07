// Real-FFmpeg test for the horror audio mix: normalization, ambient bed under the
// voice (proved inside a deliberate voice gap), stingers, limiter and the QA decision.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runFFmpeg, getAudioLevels, getMediaDuration, checkFFmpeg } = require('../utils/ffmpeg');
const mixer = require('../utils/audio-mix');

async function speechFixture(file, gain) {
  // Speech-like fixture: 4 Hz amplitude-modulated 190/380 Hz tones, with a 2.5 s pause at 10-12.5 s.
  await runFFmpeg([
    '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=190:sample_rate=24000:duration=24',
    '-f', 'lavfi', '-i', 'sine=frequency=380:sample_rate=24000:duration=24',
    '-filter_complex',
    `[0:a][1:a]amix=inputs=2:normalize=0,tremolo=f=4:d=0.8,volume=${gain}dB,volume=0:enable='between(t,10,12.5)'[v]`,
    '-map', '[v]', '-ac', '1', '-c:a', 'libmp3lame', '-q:a', '4', file
  ], { timeoutMs: 60000 });
}

async function segmentLevel(file, start, length) {
  const slice = file.replace(/\.[^.]+$/, `_${start}.wav`);
  await runFFmpeg(['-y', '-ss', String(start), '-t', String(length), '-i', file, '-vn', '-c:a', 'pcm_s16le', slice], { timeoutMs: 60000 });
  return getAudioLevels(slice);
}

async function main() {
  assert.ok(await checkFFmpeg(), 'FFmpeg is required for the audio mix test');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-mix-test-'));
  try {
    const quiet = path.join(dir, 'quiet.mp3');
    const loud = path.join(dir, 'loud.mp3');
    await speechFixture(quiet, -34);
    await speechFixture(loud, -3);

    const results = [];
    for (const [name, input] of [['quiet', quiet], ['loud', loud]]) {
      const out = path.join(dir, `${name}_mix.wav`);
      const mix = await mixer.mixHorrorAudio({ narrationPath: input, outputPath: out, seed: `seed-${name}`, twistAt: 18 });
      results.push({ name, mix, out });
      assert.equal(mix.status, 'ready');
      assert.equal(mix.ambient.present, true);
      assert.deepEqual(mix.stingers.map(item => item.kind), ['hook-thud', 'twist-stab']);
      assert.ok(Math.abs(mix.voice.normalizedLufs - mixer.VOICE_TARGET_LUFS) < 1.2, `${name}: voice at ${mix.voice.normalizedLufs} LUFS`);
      assert.ok(mix.final.lufs >= -19 && mix.final.lufs <= -12, `${name}: final ${mix.final.lufs} LUFS`);
      assert.ok(mix.final.truePeak <= -0.5, `${name}: true peak ${mix.final.truePeak}`);
      assert.ok(Math.abs((await getMediaDuration(out)) - 24) < 0.3, `${name}: mix length must follow the narration`);
      assert.ok(mix.ambient.bedUnderVoiceDb >= 10 && mix.ambient.bedUnderVoiceDb <= 24);

      // Ambient proof: inside the voice pause the mix must not be silent, and must sit
      // far below the speech level.
      const gap = await segmentLevel(out, 10.4, 1.4);
      const speech = await segmentLevel(out, 4, 3);
      assert.ok(gap.meanVolume > -62, `${name}: no ambient bed in the voice gap (${gap.meanVolume} dB)`);
      assert.ok(speech.meanVolume - gap.meanVolume >= 10, `${name}: bed is not clearly under the voice (${speech.meanVolume} vs ${gap.meanVolume} dB)`);

      const measured = await mixer.measureLoudness(out);
      const verdict = mixer.evaluateMix(mix, measured);
      assert.equal(verdict.passed, true, verdict.message);
    }

    // Every palette must render with the installed FFmpeg (a filter option out of range
    // only fails for the seeds that pick that palette).
    for (const palette of mixer.PALETTES) {
      const seed = Array.from({ length: 500 }, (_, i) => `p${i}`).find(candidate => mixer.pickPalette(candidate).name === palette.name);
      assert.ok(seed, `no seed found for ${palette.name}`);
      const out = path.join(dir, `${palette.name}.wav`);
      const mix = await mixer.mixHorrorAudio({ narrationPath: quiet, outputPath: out, seed, twistAt: 15 });
      assert.equal(mix.palette, palette.name);
      assert.equal(mixer.evaluateMix(mix, await mixer.measureLoudness(out)).passed, true, palette.name);
    }
    // A Short without a usable twist time still gets a bed and the hook stinger.
    const noTwist = await mixer.mixHorrorAudio({ narrationPath: quiet, outputPath: path.join(dir, 'notwist.wav'), seed: 'n' });
    assert.deepEqual(noTwist.stingers.map(item => item.kind), ['hook-thud']);

    // Normalization makes very different source levels land together.
    assert.ok(Math.abs(results[0].mix.final.lufs - results[1].mix.final.lufs) < 1.5, 'quiet and loud narration must end at the same loudness');

    // The same seed is deterministic; different seeds pick from several palettes.
    assert.equal(mixer.pickPalette('abc').name, mixer.pickPalette('abc').name);
    assert.ok(new Set(Array.from({ length: 40 }, (_, i) => mixer.pickPalette(`s${i}`).name)).size >= 3);

    // QA decision: stale or missing evidence and a bare narration track are rejected.
    const good = results[0].mix;
    const measuredGood = await mixer.measureLoudness(results[0].out);
    assert.equal(mixer.evaluateMix(null, measuredGood).passed, false);
    assert.equal(mixer.evaluateMix({ ...good, status: 'failed', error: 'x' }, measuredGood).passed, false);
    assert.equal(mixer.evaluateMix({ ...good, stingers: [] }, measuredGood).passed, false);
    assert.equal(mixer.evaluateMix(good, { integrated: -30, truePeak: -5 }).passed, false);
    assert.equal(mixer.evaluateMix(good, { integrated: measuredGood.integrated, truePeak: 0.3 }).passed, false);
    const bareNarration = await mixer.measureLoudness(loud);
    assert.equal(mixer.evaluateMix(good, bareNarration).passed, false, 'a video carrying the bare narration must not pass');

    // Silent narration is refused instead of mixed.
    const silent = path.join(dir, 'silent.mp3');
    await runFFmpeg(['-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '5', '-c:a', 'libmp3lame', silent], { timeoutMs: 30000 });
    await assert.rejects(mixer.mixHorrorAudio({ narrationPath: silent, outputPath: path.join(dir, 's.wav'), seed: 's' }), { code: 'NARRATION_SILENT' });

    console.log('Audio mix: PASS');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
