/**
 * One shared rule for how long a single visual beat may be, so the script writer,
 * the scene planner and the visual_cadence quality gate can never disagree.
 *
 * A beat's on-screen time is its share of the spoken words times the narration length.
 * Narration is normalized to at most MAX_NARRATION_SECONDS, so the worst case for a
 * beat is share * MAX_NARRATION_SECONDS. The writer must keep every beat's share
 * under the limit that stays inside the gate's tolerance.
 */
const MAX_NARRATION_SECONDS = 44.25;
const GATE_TOLERANCE_SECONDS = 1;
const SAFETY = 0.95;

/** Pacing target in seconds (also read by the visual_cadence gate). */
function maxBeatSeconds(env = process.env) {
  return Math.max(8, Math.min(18, Number(env.MAX_VISUAL_BEAT_SECONDS || 12)));
}

/** Largest share of the narration one beat may carry. */
function maxBeatWordShare(env = process.env) {
  return ((maxBeatSeconds(env) + GATE_TOLERANCE_SECONDS) * SAFETY) / MAX_NARRATION_SECONDS;
}

const words = text => String(text || '').split(/\s+/).filter(Boolean).length;

/** Spoken words per beat, exactly as the scene planner counts them (hook joins beat 1). */
function beatWordCounts(script = {}) {
  const hook = script.hook?.text || script.hook || '';
  const sections = script.mainContent?.sections || [];
  return sections.slice(0, 7).map((section, index) => {
    const body = (Array.isArray(section.content) ? section.content : [section.content]).filter(Boolean).join(' ');
    return words(index === 0 ? `${hook} ${body}` : body);
  });
}

/** Human-readable problems with the beat sizes (empty when balanced). */
function beatBalanceIssues(script = {}, env = process.env) {
  const counts = beatWordCounts(script);
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (!total || counts.length < 2) return [];
  const limit = maxBeatWordShare(env);
  const issues = [];
  counts.forEach((count, index) => {
    const share = count / total;
    if (share > limit) {
      const allowed = Math.floor(limit * total);
      issues.push(
        `beat ${index + 1} carries ${count} of ${total} spoken words (${Math.round(share * 100)}%); ` +
        `no beat may exceed ${Math.round(limit * 100)}% (about ${allowed} words${index === 0 ? ', hook included' : ''}) - split it or move words into other beats`
      );
    }
  });
  return issues;
}

module.exports = { MAX_NARRATION_SECONDS, maxBeatSeconds, maxBeatWordShare, beatWordCounts, beatBalanceIssues };
