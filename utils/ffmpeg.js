const { execFile } = require('child_process');
const fs = require('fs');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

let cachedPath = null;

/**
 * Resolve the FFmpeg binary to use, in order of preference:
 * 1. FFMPEG_PATH environment variable
 * 2. Bundled binary from the optional ffmpeg-static package
 * 3. `ffmpeg` on the system PATH
 */
function getFFmpegPath() {
  if (cachedPath) {
    return cachedPath;
  }

  if (process.env.FFMPEG_PATH) {
    cachedPath = process.env.FFMPEG_PATH;
    return cachedPath;
  }

  try {
    cachedPath = require('ffmpeg-static');
  } catch (error) {
    cachedPath = null;
  }

  cachedPath = cachedPath || 'ffmpeg';
  return cachedPath;
}

async function checkFFmpeg() {
  try {
    await execFileAsync(getFFmpegPath(), ['-version']);
    return true;
  } catch (error) {
    return false;
  }
}

async function runFFmpeg(args, options = {}) {
  const configuredTimeout = Number(process.env.FFMPEG_TIMEOUT_MS || 30 * 60 * 1000);
  const timeout = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1000, Number(options.timeoutMs))
    : Math.max(1000, configuredTimeout);

  try {
    return await execFileAsync(getFFmpegPath(), args, {
      maxBuffer: 32 * 1024 * 1024,
      timeout,
      ...(options.signal == null ? {} : { signal: options.signal })
    });
  } catch (error) {
    if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || options.signal?.aborted) {
      const wrapped = new Error('FFmpeg was cancelled by the generation job');
      wrapped.code = 'JOB_CANCELLED';
      wrapped.cause = error;
      throw wrapped;
    }
    if (error?.killed || /timed out/i.test(String(error?.message || ''))) {
      const wrapped = new Error(`FFmpeg exceeded the ${Math.round(timeout / 1000)}s execution limit and was terminated`);
      wrapped.code = 'FFMPEG_TIMEOUT';
      wrapped.cause = error;
      throw wrapped;
    }
    throw error;
  }
}

function getFFprobePath() {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  const ffmpegPath = getFFmpegPath();
  if (ffmpegPath !== 'ffmpeg') {
    const candidate = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
    if (candidate !== ffmpegPath && fs.existsSync(candidate)) return candidate;
  }
  return 'ffprobe';
}

async function getMediaDuration(filePath) {
  try {
    const { stdout } = await execFileAsync(getFFprobePath(), [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', filePath
    ]);
    const duration = Number(String(stdout || '').trim());
    if (Number.isFinite(duration) && duration > 0) return duration;
  } catch (_error) {
    // The bundled ffmpeg-static package does not include ffprobe; use FFmpeg's metadata output below.
  }

  try {
    await runFFmpeg(['-i', filePath]);
  } catch (error) {
    const match = String(error.stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
    if (match) {
      const duration = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
      if (Number.isFinite(duration) && duration > 0) return duration;
    }
  }
  throw new Error(`Could not determine media duration for ${filePath}`);
}

/** Streams of a media file (video size and fps, audio present), from the ffmpeg banner. */
async function probeMediaStreams(filePath, options = {}) {
  let stderr = '';
  try {
    await runFFmpeg(['-hide_banner', '-i', filePath], { timeoutMs: options.timeoutMs || 60000, signal: options.signal });
  } catch (error) {
    if (error?.code === 'JOB_CANCELLED' || error?.code === 'FFMPEG_TIMEOUT') throw error;
    stderr = String(error?.stderr || '');
  }
  const videoLine = stderr.split('\n').find(line => /Stream #\S+.*Video:/.test(line)) || '';
  const size = videoLine.match(/\b(\d{2,5})x(\d{2,5})\b/);
  const fps = videoLine.match(/(\d+(?:\.\d+)?)\s*fps/);
  return {
    hasVideo: Boolean(videoLine),
    videoCodec: (videoLine.match(/Video:\s*([^\s,]+)/) || [])[1] || null,
    width: size ? Number(size[1]) : null,
    height: size ? Number(size[2]) : null,
    fps: fps ? Number(fps[1]) : null,
    hasAudio: /Stream #\S+.*Audio:/.test(stderr)
  };
}

function ffmpegInstallHint() {
  const hints = {
    win32: 'winget install Gyan.FFmpeg (then restart your terminal)',
    darwin: 'brew install ffmpeg',
    linux: 'sudo apt install ffmpeg (or your distro equivalent)'
  };

  const platformHint = hints[process.platform] || 'https://ffmpeg.org/download.html';
  return `FFmpeg not found. Install it with: ${platformHint} — or run "npm install" again to fetch the bundled ffmpeg-static binary, or set FFMPEG_PATH to your ffmpeg executable.`;
}

module.exports = { getFFmpegPath, getFFprobePath, getMediaDuration, probeMediaStreams, checkFFmpeg, runFFmpeg, ffmpegInstallHint };
