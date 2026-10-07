/**
 * Speech-aware timing for horror Shorts (FFmpeg only, no extra dependencies).
 *
 * 1. detectSpeechWindow(): where the voice really starts/ends and where it pauses.
 * 2. buildCaptionCues(): caption cues placed by word weight inside that window, so
 *    captions follow pauses instead of an even per-word split.
 * 3. analyzeOpeningFrames() + evaluateHook(): a measured check of the first 1.5 s
 *    (voice onset, first caption, a visible and moving first frame).
 */
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { runFFmpeg, getMediaDuration } = require('./ffmpeg');

const HOOK_WINDOW_SECONDS = 1.5;

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Voice onset/end and internal pauses from silencedetect. */
async function detectSpeechWindow(audioPath, options = {}) {
  const noise = num(options.noiseDb, -40);
  const minPause = num(options.minPauseSeconds, 0.25);
  let duration = null;
  try { duration = await getMediaDuration(audioPath); } catch (_error) { duration = null; }
  let stderr = '';
  try {
    const result = await runFFmpeg([
      '-hide_banner', '-nostats', '-i', audioPath, '-vn',
      '-af', `silencedetect=noise=${noise}dB:d=${minPause}`, '-f', 'null', '-'
    ], { timeoutMs: options.timeoutMs || 120000, signal: options.signal });
    stderr = String(result?.stderr || '');
  } catch (error) {
    if (error?.code === 'JOB_CANCELLED' || error?.code === 'FFMPEG_TIMEOUT') throw error;
    stderr = String(error?.stderr || '');
  }
  if (!Number.isFinite(duration)) throw new Error(`Could not determine duration for ${audioPath}`);

  const silences = [];
  let open = null;
  for (const line of stderr.split('\n')) {
    const start = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (start) { open = Math.max(0, Number(start[1])); continue; }
    const end = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (end && open !== null) { silences.push({ start: open, end: Math.min(duration, Number(end[1])) }); open = null; }
  }
  if (open !== null) silences.push({ start: open, end: duration });

  let speechStart = 0;
  let speechEnd = duration;
  const first = silences[0];
  if (first && first.start <= 0.05) speechStart = first.end;
  const last = silences[silences.length - 1];
  if (last && last.end >= duration - 0.2 && last.start > speechStart) speechEnd = last.start;
  const pauses = silences.filter(item => item.start > speechStart + 0.05 && item.end < speechEnd + 0.05 && item.start < speechEnd - 0.05);
  return { duration, speechStart, speechEnd, pauses };
}

function wordWeights(words) {
  return words.map(word => {
    const speech = Math.max(2, String(word).replace(/[^\p{L}\p{N}]/gu, '').length);
    let pause = 0;
    if (/[.!?…]["')\]]*$/.test(word)) pause = 5;
    else if (/[,;:—–-]["')\]]*$/.test(word)) pause = 2.5;
    return { speech, pause };
  });
}

/**
 * Cues of at most `perCue` words that never straddle a sentence end. Time inside
 * [start, end] is shared by word weight, with extra weight for the pause after
 * punctuation; a cue ends when its last word has been spoken, not after the pause.
 */
function buildCaptionCues(words, window, perCue = 4) {
  const list = words.filter(Boolean);
  if (!list.length) return [];
  const start = num(window.start, 0);
  const end = Math.max(start + 0.5, num(window.end, start + list.length * 0.4));
  const weights = wordWeights(list);
  weights[weights.length - 1].pause = 0; // nothing follows the last word, so no pause is spent on it
  const total = weights.reduce((sum, item) => sum + item.speech + item.pause, 0);
  const span = end - start;
  const before = [];
  let running = 0;
  for (const item of weights) { before.push(running); running += item.speech + item.pause; }

  const cues = [];
  let from = 0;
  while (from < list.length) {
    let to = from;
    while (to < list.length - 1 && to - from + 1 < perCue && !/[.!?…]["')\]]*$/.test(list[to])) to += 1;
    const cueStart = start + (before[from] / total) * span;
    const cueEnd = start + ((before[to] + weights[to].speech) / total) * span;
    cues.push({ start: cueStart, end: Math.max(cueEnd, cueStart + 0.3), text: list.slice(from, to + 1).join(' ') });
    from = to + 1;
  }
  // Keep cues ordered and non-overlapping after the 0.3 s minimum.
  for (let i = 1; i < cues.length; i += 1) {
    if (cues[i].start < cues[i - 1].end) cues[i - 1].end = Math.max(cues[i - 1].start + 0.1, cues[i].start - 0.02);
  }
  return cues;
}

function formatSrtTime(seconds) {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const pad = (value, size) => String(value).padStart(size, '0');
  return `${pad(Math.floor(totalMs / 3600000), 2)}:${pad(Math.floor((totalMs % 3600000) / 60000), 2)}:${pad(Math.floor((totalMs % 60000) / 1000), 2)},${pad(totalMs % 1000, 3)}`;
}

function cuesToSrt(cues) {
  return cues.map((cue, index) => `${index + 1}\n${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}\n${cue.text}\n\n`).join('');
}

function parseSrt(text) {
  const cues = [];
  const pattern = /(\d+):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d+):(\d{2}):(\d{2})[,.](\d{3})\s*\n([\s\S]*?)(?:\n\s*\n|$)/g;
  let match;
  while ((match = pattern.exec(String(text || '')))) {
    const at = (h, m, s, ms) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
    cues.push({ start: at(match[1], match[2], match[3], match[4]), end: at(match[5], match[6], match[7], match[8]), text: match[9].trim() });
  }
  return cues;
}

async function grabGrayFrame(videoPath, atSeconds, directory, label, signal) {
  const out = path.join(directory, `${label}.gray`);
  await runFFmpeg([
    '-y', '-ss', String(atSeconds), '-i', videoPath, '-frames:v', '1',
    '-vf', 'scale=72:128,format=gray', '-f', 'rawvideo', out
  ], { timeoutMs: 60000, signal });
  const data = await fs.readFile(out);
  if (data.length !== 72 * 128) throw new Error(`No decodable frame at ${atSeconds}s`);
  return data;
}

function frameStats(data) {
  let sum = 0;
  for (const value of data) sum += value;
  const mean = sum / data.length;
  let variance = 0;
  for (const value of data) variance += (value - mean) * (value - mean);
  return { mean, stddev: Math.sqrt(variance / data.length) };
}

/** Brightness, structure and motion of the opening seconds, from decoded pixels. */
async function analyzeOpeningFrames(videoPath, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-frames-'));
  try {
    const first = await grabGrayFrame(videoPath, 0, directory, 'f0', options.signal);
    const late = await grabGrayFrame(videoPath, HOOK_WINDOW_SECONDS - 0.1, directory, 'f1', options.signal);
    let diff = 0;
    for (let i = 0; i < first.length; i += 1) diff += Math.abs(first[i] - late[i]);
    return { ...frameStats(first), motion: diff / first.length };
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

const HOOK_LIMITS = {
  maxVoiceOnset: 1.0,
  maxFirstCaption: 1.0,
  minFirstFrameMean: 6,
  minFirstFrameStddev: 8,
  minOpeningMotion: num(process.env.HOOK_MIN_MOTION, 0.15)
};

/** Measured first-1.5-seconds decision. */
function evaluateHook({ speech, cues, frames }) {
  const failures = [];
  const onset = speech ? speech.speechStart : null;
  if (!Number.isFinite(onset)) failures.push('voice onset could not be measured');
  else if (onset > HOOK_LIMITS.maxVoiceOnset) failures.push(`voice starts at ${onset.toFixed(2)}s (limit ${HOOK_LIMITS.maxVoiceOnset}s)`);
  const firstCue = Array.isArray(cues) && cues.length ? cues[0].start : null;
  if (!Number.isFinite(firstCue)) failures.push('no caption cue found');
  else if (firstCue > HOOK_LIMITS.maxFirstCaption) failures.push(`first caption appears at ${firstCue.toFixed(2)}s (limit ${HOOK_LIMITS.maxFirstCaption}s)`);
  if (!frames) failures.push('opening frames could not be analyzed');
  else {
    if (frames.mean < HOOK_LIMITS.minFirstFrameMean) failures.push(`first frame is almost black (mean ${frames.mean.toFixed(1)})`);
    if (frames.stddev < HOOK_LIMITS.minFirstFrameStddev) failures.push(`first frame has no visible structure (contrast ${frames.stddev.toFixed(1)})`);
    if (frames.motion < HOOK_LIMITS.minOpeningMotion) failures.push(`picture is static during the first ${HOOK_WINDOW_SECONDS}s (motion ${frames.motion.toFixed(2)})`);
  }
  if (failures.length) return { passed: false, message: `Hook window failed: ${failures.join('; ')}` };
  return {
    passed: true,
    message: `Hook ok: voice at ${onset.toFixed(2)}s, caption at ${firstCue.toFixed(2)}s, first frame contrast ${frames.stddev.toFixed(1)}, opening motion ${frames.motion.toFixed(2)}`
  };
}

/** Captions must follow the voice: start with it, end with it, stay ordered and readable. */
function evaluateCaptionSync({ speech, cues }) {
  if (!speech || !Array.isArray(cues) || !cues.length) return { passed: false, message: 'Captions or speech window could not be read' };
  const problems = [];
  const first = cues[0];
  const last = cues[cues.length - 1];
  if (Math.abs(first.start - speech.speechStart) > 0.5) problems.push(`first caption at ${first.start.toFixed(2)}s but the voice starts at ${speech.speechStart.toFixed(2)}s`);
  if (Math.abs(last.end - speech.speechEnd) > 1.0) problems.push(`last caption ends at ${last.end.toFixed(2)}s but the voice ends at ${speech.speechEnd.toFixed(2)}s`);
  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i];
    if (cue.end - cue.start < 0.25 || cue.end - cue.start > 5) { problems.push(`cue ${i + 1} lasts ${(cue.end - cue.start).toFixed(2)}s`); break; }
    if (i > 0 && cue.start < cues[i - 1].end - 0.03) { problems.push(`cue ${i + 1} overlaps the previous cue`); break; }
  }
  return problems.length
    ? { passed: false, message: `Caption sync failed: ${problems.join('; ')}` }
    : { passed: true, message: `${cues.length} captions follow the voice (${first.start.toFixed(2)}s to ${last.end.toFixed(2)}s)` };
}

module.exports = {
  HOOK_WINDOW_SECONDS, HOOK_LIMITS, detectSpeechWindow, buildCaptionCues, cuesToSrt, parseSrt,
  analyzeOpeningFrames, evaluateHook, evaluateCaptionSync, formatSrtTime
};
