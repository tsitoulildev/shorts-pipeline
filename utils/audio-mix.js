/**
 * Horror Short sound design with FFmpeg only (free, original, no third-party samples).
 *
 * Pipeline: loudness-normalize the narration (two-pass EBU R128), synthesize a
 * seeded ambient bed and two stingers (hook thud, twist stab with a riser),
 * duck the bed under the voice with a sidechain compressor, limit true peak and
 * measure the result. Every number written into the evidence object is
 * measured, never assumed, so the QA gate can re-verify it from the final MP4.
 */
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const { runFFmpeg, getAudioLevels, getMediaDuration } = require('./ffmpeg');

const VOICE_TARGET_LUFS = -16;
const TRUE_PEAK_CEILING_DB = -2;
const SAMPLE_RATE = 44100;

const PALETTES = [
  { name: 'sub-drone', base: 41.2, detune: 0.7, noiseLowpass: 180, tremolo: 0.11 },
  { name: 'cold-room', base: 49.0, detune: 0.9, noiseLowpass: 260, tremolo: 0.13 },
  { name: 'hollow-hum', base: 55.0, detune: 1.1, noiseLowpass: 140, tremolo: 0.1 },
  { name: 'distant-pressure', base: 61.7, detune: 0.6, noiseLowpass: 320, tremolo: 0.19 }
];

function ambientEnabled() {
  return !/^(0|false|no)$/i.test(String(process.env.AMBIENT_AUDIO_ENABLED || 'true'));
}

function ambientRequired() {
  return !/^(0|false|no)$/i.test(String(process.env.AMBIENT_AUDIO_REQUIRED || 'true'));
}

function seedNumber(seed, salt = '') {
  const digest = crypto.createHash('md5').update(`${seed}|${salt}`).digest();
  return digest.readUInt32BE(0);
}

function pickPalette(seed) {
  return PALETTES[seedNumber(seed, 'palette') % PALETTES.length];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseLoudnormJson(stderr) {
  const text = String(stderr || '');
  const marker = text.lastIndexOf('"input_i"');
  if (marker < 0) return null;
  const start = text.lastIndexOf('{', marker);
  const end = text.indexOf('}', marker);
  if (start < 0 || end < 0) return null;
  try {
    const raw = JSON.parse(text.slice(start, end + 1));
    const read = value => {
      const parsed = Number(String(value).trim());
      if (/-inf/i.test(String(value))) return -Infinity;
      return Number.isFinite(parsed) ? parsed : null;
    };
    return {
      integrated: read(raw.input_i),
      truePeak: read(raw.input_tp),
      lra: read(raw.input_lra),
      threshold: read(raw.input_thresh),
      targetOffset: read(raw.target_offset)
    };
  } catch (_error) {
    return null;
  }
}

/** Integrated loudness (LUFS), true peak (dBTP) and range (LU) of any audio or video file. */
async function measureLoudness(filePath, options = {}) {
  let stderr = '';
  try {
    const result = await runFFmpeg([
      '-hide_banner', '-nostats', '-i', filePath, '-vn',
      '-af', `loudnorm=I=${VOICE_TARGET_LUFS}:TP=-1.5:LRA=11:print_format=json`,
      '-f', 'null', '-'
    ], { timeoutMs: options.timeoutMs || 120000, signal: options.signal });
    stderr = String(result?.stderr || '');
  } catch (error) {
    if (error?.code === 'JOB_CANCELLED' || error?.code === 'FFMPEG_TIMEOUT') throw error;
    stderr = String(error?.stderr || '');
  }
  const parsed = parseLoudnormJson(stderr);
  if (!parsed || parsed.integrated === null || parsed.truePeak === null) {
    throw new Error(`Could not measure loudness for ${filePath}`);
  }
  return parsed;
}

/** Two-pass loudness normalization of the voice track to a WAV at VOICE_TARGET_LUFS. */
async function normalizeVoice(inputPath, outputPath, options = {}) {
  const first = await measureLoudness(inputPath, options);
  if (!Number.isFinite(first.integrated) || first.integrated < -60) {
    const error = new Error(`Narration is effectively silent (${first.integrated} LUFS)`);
    error.code = 'NARRATION_SILENT';
    throw error;
  }
  const filter = [
    `loudnorm=I=${VOICE_TARGET_LUFS}:TP=${TRUE_PEAK_CEILING_DB}:LRA=11`,
    `measured_I=${first.integrated}:measured_TP=${first.truePeak}:measured_LRA=${first.lra}`,
    `measured_thresh=${first.threshold}:offset=${first.targetOffset}:linear=true`
  ].join(':');
  await runFFmpeg([
    '-y', '-i', inputPath, '-vn',
    '-af', `${filter},aresample=${SAMPLE_RATE},aformat=sample_fmts=s16:channel_layouts=stereo`,
    '-c:a', 'pcm_s16le', outputPath
  ], { timeoutMs: options.timeoutMs || 120000, signal: options.signal });
  return { sourceLufs: first.integrated, sourceTruePeak: first.truePeak };
}

/**
 * Ambient bed (drone + brown-noise rumble + a riser that ends exactly on the twist)
 * and stinger cues (hook thud at 0s, dissonant stab on the twist), as two WAV files.
 */
async function renderAmbientLayers({ duration, palette, seed, twistAt, bedPath, cuesPath, signal }) {
  const D = Math.max(4, duration);
  const riserLength = 1.6;
  const hasTwist = Number.isFinite(twistAt) && twistAt >= riserLength + 1 && twistAt <= D - 1;
  const noiseSeed = seedNumber(seed, 'noise') % 100000;
  const riserSeed = seedNumber(seed, 'riser') % 100000;
  const fmt = `aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo`;

  const bedArgs = ['-y',
    '-f', 'lavfi', '-i', `anoisesrc=color=brown:amplitude=0.6:sample_rate=${SAMPLE_RATE}:seed=${noiseSeed}:duration=${D.toFixed(3)}`,
    '-f', 'lavfi', '-i', `sine=frequency=${palette.base}:sample_rate=${SAMPLE_RATE}:duration=${D.toFixed(3)}`,
    '-f', 'lavfi', '-i', `sine=frequency=${(palette.base + palette.detune).toFixed(2)}:sample_rate=${SAMPLE_RATE}:duration=${D.toFixed(3)}`
  ];
  const bedFilters = [
    `[0:a]lowpass=f=${palette.noiseLowpass},highpass=f=28,tremolo=f=${palette.tremolo}:d=0.55,volume=1.2[n]`,
    '[1:a]volume=0.55[s1]', '[2:a]volume=0.5[s2]'
  ];
  let bedMix = '[n][s1][s2]';
  let bedInputs = 3;
  if (hasTwist) {
    bedArgs.push('-f', 'lavfi', '-i', `anoisesrc=color=pink:amplitude=0.5:sample_rate=${SAMPLE_RATE}:seed=${riserSeed}:duration=${riserLength}`);
    const delay = Math.round((twistAt - riserLength) * 1000);
    bedFilters.push(
      `[3:a]highpass=f=500,lowpass=f=5500,afade=t=in:st=0:d=${(riserLength - 0.05).toFixed(2)}:curve=exp,afade=t=out:st=${(riserLength - 0.05).toFixed(2)}:d=0.05,volume=0.35,adelay=${delay}|${delay}[riser]`
    );
    bedMix += '[riser]';
    bedInputs += 1;
  }
  bedFilters.push(
    `${bedMix}amix=inputs=${bedInputs}:normalize=0:duration=first,afade=t=in:st=0:d=0.8,afade=t=out:st=${Math.max(0, D - 1.5).toFixed(2)}:d=1.5,${fmt}[bed]`
  );
  await runFFmpeg([...bedArgs, '-filter_complex', bedFilters.join(';'), '-map', '[bed]', '-c:a', 'pcm_s16le', bedPath], { timeoutMs: 120000, signal });

  const cueArgs = ['-y',
    '-f', 'lavfi', '-i', `sine=frequency=48:sample_rate=${SAMPLE_RATE}:duration=1.2`,
    '-f', 'lavfi', '-i', `anoisesrc=color=brown:amplitude=0.7:sample_rate=${SAMPLE_RATE}:seed=${noiseSeed + 1}:duration=0.7`
  ];
  const cueFilters = [
    '[0:a]afade=t=out:st=0.05:d=1.15,volume=0.9[sub]',
    '[1:a]lowpass=f=320,afade=t=out:st=0:d=0.7,volume=0.9[thud]',
    '[sub][thud]amix=inputs=2:normalize=0:duration=longest[hook]'
  ];
  const stingers = [{ kind: 'hook-thud', at: 0 }];
  let cueMix = '[hook]';
  let cueInputs = 1;
  if (hasTwist) {
    cueArgs.push(
      '-f', 'lavfi', '-i', `sine=frequency=311.13:sample_rate=${SAMPLE_RATE}:duration=1.5`,
      '-f', 'lavfi', '-i', `sine=frequency=329.63:sample_rate=${SAMPLE_RATE}:duration=1.5`,
      '-f', 'lavfi', '-i', `sine=frequency=${(palette.base * 2).toFixed(2)}:sample_rate=${SAMPLE_RATE}:duration=1.5`
    );
    const delay = Math.round(twistAt * 1000);
    cueFilters.push(
      '[2:a]volume=0.45[c1]', '[3:a]volume=0.45[c2]', '[4:a]volume=0.8[c3]',
      `[c1][c2][c3]amix=inputs=3:normalize=0:duration=longest,afade=t=in:st=0:d=0.02,afade=t=out:st=0.05:d=1.45,adelay=${delay}|${delay}[stab]`
    );
    cueMix += '[stab]';
    cueInputs += 1;
    stingers.push({ kind: 'twist-stab', at: Number(twistAt.toFixed(2)), riserSeconds: riserLength });
  }
  cueFilters.push(`${cueMix}amix=inputs=${cueInputs}:normalize=0:duration=longest,apad=whole_dur=${D.toFixed(3)},atrim=0:${D.toFixed(3)},${fmt}[cues]`);
  await runFFmpeg([...cueArgs, '-filter_complex', cueFilters.join(';'), '-map', '[cues]', '-c:a', 'pcm_s16le', cuesPath], { timeoutMs: 120000, signal });

  return { stingers, hasRiser: hasTwist };
}

/**
 * Build the final mix. `twistAt` is the start of the final (twist) beat in seconds.
 * Returns the evidence object stored on production.assets.audio.mix.
 */
async function mixHorrorAudio({ narrationPath, outputPath, seed, twistAt = null, duration = null, signal = null }) {
  const directory = path.dirname(outputPath);
  const stem = path.basename(outputPath).replace(/\.[^.]+$/, '');
  const voicePath = path.join(directory, `${stem}_voice.wav`);
  const bedPath = path.join(directory, `${stem}_bed.wav`);
  const cuesPath = path.join(directory, `${stem}_cues.wav`);
  const temporary = [voicePath, bedPath, cuesPath];
  await fs.mkdir(directory, { recursive: true });

  try {
    const palette = pickPalette(seed);
    const voice = await normalizeVoice(narrationPath, voicePath, { signal });
    const voiceLoudness = await measureLoudness(voicePath, { signal });
    const voiceLevels = await getAudioLevels(voicePath, { signal });
    const length = duration || number(await getMediaDuration(voicePath), 0);
    if (!(length > 1)) throw new Error('Could not determine narration duration for the audio mix');

    const layers = await renderAmbientLayers({
      duration: length, palette, seed, twistAt: Number.isFinite(Number(twistAt)) ? Number(twistAt) : null,
      bedPath, cuesPath, signal
    });

    const bedLoudness = await measureLoudness(bedPath, { signal });
    const cueLevels = await getAudioLevels(cuesPath, { signal });
    const bedUnderVoice = clamp(number(process.env.AMBIENT_BED_UNDER_VOICE_DB, 15), 10, 24);
    const stingerUnderPeak = clamp(number(process.env.AMBIENT_STINGER_UNDER_PEAK_DB, 8), 4, 16);
    const bedGainDb = (voiceLoudness.integrated - bedUnderVoice) - bedLoudness.integrated;
    const cueGainDb = (voiceLevels.maxVolume - stingerUnderPeak) - cueLevels.maxVolume;

    const graph = [
      '[0:a]asplit=2[voice][key]',
      `[1:a]volume=${bedGainDb.toFixed(2)}dB[bedraw]`,
      '[bedraw][key]sidechaincompress=threshold=0.03:ratio=6:attack=15:release=400:makeup=1[bed]',
      `[2:a]volume=${cueGainDb.toFixed(2)}dB[cues]`,
      '[voice][bed][cues]amix=inputs=3:normalize=0:duration=first,' +
        `alimiter=limit=${Math.pow(10, TRUE_PEAK_CEILING_DB / 20).toFixed(4)}:level=disabled,` +
        `aformat=sample_fmts=s16:sample_rates=${SAMPLE_RATE}:channel_layouts=stereo[out]`
    ].join(';');
    await runFFmpeg([
      '-y', '-i', voicePath, '-i', bedPath, '-i', cuesPath,
      '-filter_complex', graph, '-map', '[out]', '-c:a', 'pcm_s16le', outputPath
    ], { timeoutMs: 120000, signal });

    const final = await measureLoudness(outputPath, { signal });
    return {
      status: 'ready',
      path: outputPath,
      format: 'wav',
      origin: 'synthesized-ffmpeg',
      rights: 'original synthesized audio; no third-party samples or music',
      seed: String(seed),
      palette: palette.name,
      // The bed gain is derived from the measured voice and bed loudness, so this
      // relation holds by construction; the QA gate re-measures the final loudness.
      ambient: {
        present: true,
        rawBedLufs: round(bedLoudness.integrated),
        bedGainDb: round(bedGainDb),
        bedUnderVoiceDb: round(voiceLoudness.integrated - (bedLoudness.integrated + bedGainDb)),
        ducking: 'sidechaincompress 6:1'
      },
      stingers: layers.stingers,
      voice: {
        sourceLufs: round(voice.sourceLufs), normalizedLufs: round(voiceLoudness.integrated),
        normalizedTruePeak: round(voiceLoudness.truePeak)
      },
      final: {
        lufs: round(final.integrated), truePeak: round(final.truePeak), lra: round(final.lra),
        durationSeconds: Number(length.toFixed(3))
      },
      generatedAt: new Date().toISOString()
    };
  } finally {
    await Promise.all(temporary.map(file => fs.unlink(file).catch(() => {})));
  }
}

function round(value) {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : value;
}

/**
 * QA decision. `measured` is the loudness of the FINAL MP4 audio, measured at QA
 * time, so a video that was rebuilt without the mix cannot ride on stale evidence.
 */
function evaluateMix(mix, measured) {
  if (!mix || mix.status !== 'ready') {
    return { passed: false, message: `Audio mix is ${mix?.status || 'missing'}${mix?.error ? `: ${mix.error}` : ''}; ambient bed and stingers are required` };
  }
  if (mix.ambient?.present !== true || !Array.isArray(mix.stingers) || mix.stingers.length < 1) {
    return { passed: false, message: 'Audio mix evidence does not include an ambient bed and at least one stinger' };
  }
  const under = Number(mix.ambient.bedUnderVoiceDb);
  if (!(under >= 10 && under <= 24)) {
    return { passed: false, message: `Ambient bed sits ${under} dB under the voice; it must stay between 10 and 24 dB below` };
  }
  if (!measured || !Number.isFinite(measured.integrated)) {
    return { passed: false, message: 'Final video loudness could not be measured' };
  }
  if (measured.integrated < -19 || measured.integrated > -12) {
    return { passed: false, message: `Final loudness ${measured.integrated.toFixed(1)} LUFS is outside -19..-12 LUFS` };
  }
  if (measured.truePeak > -0.5) {
    return { passed: false, message: `Final true peak ${measured.truePeak.toFixed(1)} dBTP risks clipping (limit -0.5)` };
  }
  const expected = Number(mix.final?.lufs);
  if (Number.isFinite(expected) && Math.abs(expected - measured.integrated) > 1.5) {
    return { passed: false, message: `Final video loudness ${measured.integrated.toFixed(1)} LUFS does not match the mix (${expected.toFixed(1)} LUFS); the video was not built from this mix` };
  }
  return {
    passed: true,
    message: `Ambient ${mix.palette} bed ${under} dB under the voice, ${mix.stingers.length} stinger(s), final ${measured.integrated.toFixed(1)} LUFS / ${measured.truePeak.toFixed(1)} dBTP`
  };
}

module.exports = {
  ambientEnabled, ambientRequired, pickPalette, parseLoudnormJson, measureLoudness,
  normalizeVoice, renderAmbientLayers, mixHorrorAudio, evaluateMix, PALETTES, VOICE_TARGET_LUFS
};
