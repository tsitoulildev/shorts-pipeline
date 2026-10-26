/**
 * Speech-aware timing (FFmpeg only, no extra dependencies).
 *
 * 1. detectSpeechWindow(): where the voice really starts/ends and where it pauses.
 * 2. buildCaptionCues(): caption cues placed by word weight inside that window, so
 *    captions follow pauses instead of an even per-word split.
 */
const { runFFmpeg, getMediaDuration } = require('./ffmpeg');

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

module.exports = { detectSpeechWindow, buildCaptionCues, cuesToSrt, formatSrtTime };
