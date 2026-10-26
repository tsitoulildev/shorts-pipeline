/** How long one visual beat may stay on screen (seconds): the pacing target read by the visual_cadence quality check. */
function maxBeatSeconds(env = process.env) {
  return Math.max(8, Math.min(18, Number(env.MAX_VISUAL_BEAT_SECONDS || 12)));
}

module.exports = { maxBeatSeconds };
