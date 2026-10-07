/**
 * Visual consistency and variety gates for Dark Stickman Shorts.
 *
 * - Character consistency: every beat carries the same reference-character hash.
 * - Scene variety: poses and environments differ across beats (structural, from metadata).
 * - Visual distance: decoded pixels of any two beats must differ (perceptual, from files),
 *   so two beats cannot pass as "different" by a single changed byte.
 */
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { runFFmpeg } = require('./ffmpeg');
const { CHARACTER_HASH } = require('./stickman-scene');

const THUMB_W = 36;
const THUMB_H = 64;
const MIN_VISUAL_DISTANCE = Number(process.env.MIN_BEAT_VISUAL_DISTANCE || 0.6);

async function grayThumbnail(imagePath, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'beat-thumb-'));
  try {
    const out = path.join(directory, 'thumb.gray');
    await runFFmpeg([
      '-y', '-i', imagePath, '-frames:v', '1',
      '-vf', `scale=${THUMB_W}:${THUMB_H},format=gray`, '-f', 'rawvideo', out
    ], { timeoutMs: 60000, signal: options.signal });
    const data = await fs.readFile(out);
    if (data.length !== THUMB_W * THUMB_H) throw new Error(`Could not decode ${imagePath}`);
    return data;
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

function meanAbsDifference(a, b) {
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}

/** Smallest pairwise mean absolute difference (0-255 scale) across beat thumbnails. */
function minPairwiseDistance(thumbnails) {
  let min = Infinity;
  let pair = null;
  for (let a = 0; a < thumbnails.length; a += 1) {
    for (let b = a + 1; b < thumbnails.length; b += 1) {
      const distance = meanAbsDifference(thumbnails[a], thumbnails[b]);
      if (distance < min) { min = distance; pair = [a + 1, b + 1]; }
    }
  }
  return { min, pair };
}

function evaluateVisualDistance(thumbnails) {
  if (!Array.isArray(thumbnails) || thumbnails.length < 2) return { passed: false, message: 'Not enough decodable beat images to compare' };
  const { min, pair } = minPairwiseDistance(thumbnails);
  return min >= MIN_VISUAL_DISTANCE
    ? { passed: true, message: `Closest two beats still differ by ${min.toFixed(2)} (limit ${MIN_VISUAL_DISTANCE})` }
    : { passed: false, message: `Beats ${pair[0]} and ${pair[1]} are visually almost identical (difference ${min.toFixed(2)}, limit ${MIN_VISUAL_DISTANCE})` };
}

/** `visuals` are the per-beat `visual` metadata objects written by the renderer. */
// Official earlier versions of the reference character, by version name (hash of CHARACTER).
const PREVIOUS_CHARACTER_HASHES = Object.freeze({ 'dark-stickman-v3': 'fb8300b2f70a' });

function evaluateCharacterConsistency(visuals, { required = true } = {}) {
  const known = visuals.filter(item => item && item.characterHash);
  if (known.length !== visuals.length) {
    return required
      ? { passed: false, message: `${visuals.length - known.length} of ${visuals.length} beats carry no reference-character evidence` }
      : { passed: true, message: 'Reference-character evidence is only recorded by the built-in renderer' };
  }
  const hashes = new Set(known.map(item => item.characterHash));
  if (hashes.size !== 1) return { passed: false, message: `Beats use ${hashes.size} different character versions` };
  // Shorts rendered before the v4 redesign (and still waiting for review) keep passing as long as every
  // beat is the previous official character; anything else is an outdated or unknown renderer.
  if (!hashes.has(CHARACTER_HASH) && !hashes.has(PREVIOUS_CHARACTER_HASHES['dark-stickman-v3'])) {
    return { passed: false, message: 'Beats were rendered with an outdated character version' };
  }
  return { passed: true, message: `All ${known.length} beats use the reference character ${known[0].characterVersion} (${[...hashes][0]})` };
}

function evaluateSceneVariety(visuals) {
  const known = visuals.filter(item => item && item.pose && item.environment);
  const total = visuals.length;
  if (known.length !== total) return { passed: false, message: `${total - known.length} of ${total} beats carry no pose/environment evidence` };
  const poses = new Set(known.map(item => item.pose));
  const environments = new Set(known.map(item => item.environment));
  const needPoses = Math.ceil(total * 0.5);
  const needEnvironments = Math.ceil(total * 0.4);
  const neighbours = known.every((item, index) => index === 0 ||
    item.pose !== known[index - 1].pose || item.environment !== known[index - 1].environment);
  const ok = poses.size >= needPoses && environments.size >= needEnvironments && neighbours;
  return ok
    ? { passed: true, message: `${poses.size} poses and ${environments.size} environments across ${total} beats` }
    : {
      passed: false,
      message: `Too repetitive: ${poses.size}/${needPoses} poses, ${environments.size}/${needEnvironments} environments` +
        `${neighbours ? '' : ', two neighbouring beats share pose and place'}`
    };
}

module.exports = {
  MIN_VISUAL_DISTANCE, grayThumbnail, minPairwiseDistance, evaluateVisualDistance,
  evaluateCharacterConsistency, evaluateSceneVariety, PREVIOUS_CHARACTER_HASHES
};
