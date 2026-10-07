// Documentary renderer: Ken Burns motion on the REAL images of each beat, the narration, burned-in captions.
// FFmpeg only (free). Nothing here is generated or AI-made: every frame comes from a downloaded, license-checked file.
const fs = require('fs').promises;
const path = require('path');
const { runFFmpeg, getMediaDuration } = require('../ffmpeg');
const { detectSpeechWindow, buildCaptionCues, cuesToSrt } = require('../speech-timing');

const W = 1080;
const H = 1920;
const FPS = 30;

const MOTIONS = ['zoom-in', 'pan-right', 'zoom-out', 'pan-left'];

/**
 * Filter for one still: a blurred, darkened copy fills the 9:16 frame, the sharp photo sits on top at full
 * width and moves slowly (zoom in/out or a pan). Output is always exactly 1080x1920 at 30 fps.
 */
function kenBurnsFilter(motion, seconds, size = { width: 4, height: 3 }) {
  // the photo keeps its own aspect ratio (never stretched): frame height follows the image, capped for very tall photos
  const even = n => Math.max(2, Math.round(n / 2) * 2);
  const fgWidth = even(Math.min(W, (1500 * size.width) / size.height));
  const fgHeight = even((fgWidth * size.height) / size.width);
  const frames = Math.max(1, Math.round(seconds * FPS));
  const p = `on/${frames}`;
  const move = {
    'zoom-in': `z='1+0.12*${p}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,
    'zoom-out': `z='1.12-0.12*${p}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,
    'pan-right': `z='1.12':x='(iw-iw/zoom)*${p}':y='ih/2-(ih/zoom/2)'`,
    'pan-left': `z='1.12':x='(iw-iw/zoom)*(1-${p})':y='ih/2-(ih/zoom/2)'`
  }[motion];
  return [
    '[0:v]split[a][b]',
    `[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=40:6,eq=brightness=-0.2[bg]`,
    // photo: scaled 2x the frame width first so the slow zoom has no pixel jitter, then framed back to 1080 wide
    `[b]scale=${fgWidth * 2}:${fgHeight * 2},zoompan=${move}:d=1:s=${fgWidth}x${fgHeight}:fps=${FPS}[fg]`,
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p,setsar=1`
  ].join(';');
}

async function renderStill(imagePath, seconds, motion, outPath, options = {}) {
  const size = options.size || { width: 4, height: 3 };
  await runFFmpeg([
    '-y', '-loop', '1', '-framerate', String(FPS), '-i', imagePath, '-t', seconds.toFixed(3),
    '-filter_complex', kenBurnsFilter(motion, seconds, size), '-r', String(FPS),
    '-c:v', 'libx264', '-preset', process.env.FFMPEG_PRESET || 'veryfast', '-crf', process.env.FFMPEG_CRF || '20', '-an', outPath
  ], { timeoutMs: 180000, signal: options.signal });
  return outPath;
}

/** Seconds per beat: the beat's share of the spoken words inside the real speech window; beat 1 absorbs the lead-in, the last the tail. */
function beatTimeline(beats, window) {
  const counts = beats.map(b => b.narration.split(/\s+/).filter(Boolean).length);
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  const span = window.speechEnd - window.speechStart;
  let cumulative = 0;
  return counts.map((count, i) => {
    cumulative += count;
    const end = i === counts.length - 1 ? window.duration : window.speechStart + (cumulative / total) * span;
    const start = i === 0 ? 0 : window.speechStart + ((cumulative - count) / total) * span;
    return { start, seconds: Math.max(0.8, end - start) };
  });
}

// libass lays an SRT out on a 384x288 script and scales it to the frame (x6.67 at 1920 px high): FontSize 10 is ~66 px, MarginV 64 is ~430 px above the bottom edge.
// (The first version used FontSize 22 / MarginV 210, i.e. 147 px letters 1400 px up, in the top third of the picture.)
const subtitleFilter = srtPath => `subtitles='${path.resolve(srtPath).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")}':force_style='FontName=Arial,FontSize=10,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=1,Shadow=0,Alignment=2,MarginV=64'`;

/**
 * renderDocumentary({ script, imageFolder, narrationPath, outDir }) -> { videoPath, srtPath, duration, segments }.
 * script.beats[i] = { narration, images: [{ file }] } (images are the downloaded records of phase 2).
 */
async function renderDocumentary({ script, imageFolder, narrationPath, outDir, signal }) {
  await fs.mkdir(outDir, { recursive: true });
  const window = await detectSpeechWindow(narrationPath, { signal });
  const timeline = beatTimeline(script.beats, window);

  const segments = [];
  let motionIndex = 0;
  for (let i = 0; i < script.beats.length; i += 1) {
    const images = script.beats[i].images;
    const each = timeline[i].seconds / images.length;
    for (const image of images) {
      const clip = path.join(outDir, `clip_${String(segments.length + 1).padStart(2, '0')}.mp4`);
      await renderStill(path.join(imageFolder, image.file), each, MOTIONS[motionIndex % MOTIONS.length], clip, { signal, size: { width: image.width, height: image.height } });
      segments.push({ beat: i + 1, file: image.file, seconds: each, motion: MOTIONS[motionIndex % MOTIONS.length], clip });
      motionIndex += 1;
    }
  }

  const list = path.join(outDir, 'clips.txt');
  await fs.writeFile(list, segments.map(s => `file '${path.resolve(s.clip).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
  const words = script.beats.map(b => b.narration).join(' ').split(/\s+/).filter(Boolean);
  const srtPath = path.join(outDir, 'captions.srt');
  await fs.writeFile(srtPath, cuesToSrt(buildCaptionCues(words, { start: window.speechStart, end: window.speechEnd })));

  const videoPath = path.join(outDir, 'short.mp4');
  await runFFmpeg([
    '-y', '-f', 'concat', '-safe', '0', '-i', list, '-i', narrationPath,
    '-vf', subtitleFilter(srtPath), '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', process.env.FFMPEG_PRESET || 'veryfast', '-crf', process.env.FFMPEG_CRF || '20',
    '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', videoPath
  ], { timeoutMs: 420000, signal });
  return { videoPath, srtPath, duration: await getMediaDuration(videoPath), segments, speechWindow: window };
}

/** 1280x720 thumbnail from the first beat's REAL image (darkened, title over it). */
async function renderThumbnail({ imagePath, title, outPath, signal }) {
  const text = String(title).replace(/[:'\\%]/g, ' ').slice(0, 60);
  await runFFmpeg([
    '-y', '-i', imagePath,
    '-vf', `scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,eq=brightness=-0.18:contrast=1.1,drawtext=text='${text}':fontcolor=white:fontsize=64:borderw=4:bordercolor=black:x=(w-text_w)/2:y=h-170`,
    '-frames:v', '1', '-update', '1', outPath
  ], { timeoutMs: 60000, signal });
  return outPath;
}

module.exports = { renderDocumentary, renderStill, renderThumbnail, kenBurnsFilter, beatTimeline, subtitleFilter, MOTIONS, W, H };
