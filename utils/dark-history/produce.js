// Produces one Dark History Short from a claimed pool story and a grounded script, then runs the documentary gate.
// Never uploads. Callers must check `gate.passed` before anything leaves the machine (phase 6 wires the scheduler).
const fs = require('fs');
const path = require('path');
const { renderDocumentary, renderThumbnail } = require('./documentary-render');
const { buildDescription, storyForScript } = require('./grounded-writer');
const { checkDocumentaryProduction } = require('./documentary-gate');
const { probeMediaStreams, getMediaDuration } = require('../ffmpeg');
const { ensureHashes } = require('./dhash');

// the documentary gate allows 60 s; refuse a longer narration before spending minutes on the render
const MAX_NARRATION_SECONDS = 58;

/** Title <= 70 chars, tags from the article, #Shorts hashtags; the description carries the attribution unchanged. */
function buildSeo(script, story) {
  const title = script.title.length > 70 ? `${script.title.slice(0, 67).trim()}...` : script.title;
  const topic = story.plan.title;
  return {
    title,
    description: `${buildDescription(script, story)}\n\n#Shorts #History #DarkHistory`,
    tags: [...new Set([topic, `${topic} explained`, 'dark history', 'true story', 'history mystery', 'unsolved history', 'shorts'])].slice(0, 12)
  };
}

/**
 * produceDocumentaryShort({ story, script, narrate, workDir }) -> { videoPath, thumbnailPath, seo, gate, render }.
 * `narrate(text, outputPath)` writes the voice file (the existing TTS chain); injected so tests run offline.
 */
async function produceDocumentaryShort({ story: poolStory, script, narrate, workDir, signal }) {
  // the beats the writer skipped are not shown and not credited: everything below works on the story as it is shown
  const story = storyForScript(poolStory, script);
  await ensureHashes(story.plan.beats, story.plan.folder); // fingerprints for the near-duplicate gate (recorded on the story)
  fs.mkdirSync(workDir, { recursive: true });
  const narrationPath = path.join(workDir, 'narration.mp3');
  await narrate(script.beats.map(b => b.narration).join(' '), narrationPath);
  const spoken = await getMediaDuration(narrationPath);
  if (!(spoken <= MAX_NARRATION_SECONDS)) {
    const error = new Error(`narration is ${Number(spoken).toFixed(1)} s; a Short must stay under 60 s (${MAX_NARRATION_SECONDS} s of speech at most)`);
    error.code = 'NARRATION_TOO_LONG';
    throw error;
  }
  const render = await renderDocumentary({ script, imageFolder: story.plan.folder, narrationPath, outDir: workDir, signal });
  const thumbnailPath = await renderThumbnail({ imagePath: path.join(story.plan.folder, script.beats[0].images[0].file), title: script.title, outPath: path.join(workDir, 'thumbnail.jpg'), signal });
  const seo = buildSeo(script, story);

  const streams = await probeMediaStreams(render.videoPath);
  const video = { width: streams.width, height: streams.height, duration: render.duration, hasAudio: streams.hasAudio };
  const gate = checkDocumentaryProduction({ story, script, description: seo.description, video, segments: render.segments });
  return { videoPath: render.videoPath, thumbnailPath, seo, gate, render, video, story };
}

module.exports = { produceDocumentaryShort, buildSeo };
