/**
 * The bounded write -> review -> rewrite loop of the writer. A script that fails its review goes back to the writer with concrete notes; the best passing draft is
 * returned with its verdict and attempts on script.metadata.creativeReview, and when no draft passes the job is rejected (fail closed). The judges themselves are in
 * dark-history/grounded-writer.js (fact-check, pictures, prose).
 */
const MAX_REVISIONS = Math.max(0, Math.min(3, Number(process.env.CREATIVE_MAX_REVISIONS ?? 2)));
const POLISH_TARGET = Number(process.env.SCRIPT_POLISH_TARGET) || 8.5;

/** Text appended to the writer prompt for a rewrite. */
function revisionBrief(review) {
  const lines = [`Previous draft scored ${review.overall}/10 (${review.failures.join('; ') || 'below target'}).`];
  for (const note of review.notes.slice(0, 6)) lines.push(`- ${note}`);
  lines.push('Rewrite the narration so that it says only what the source says, and fix every point above.');
  return lines.join('\n');
}

/**
 * Bounded write -> review -> rewrite loop. `write(brief)` returns a script;
 * the best passing script is returned with its evidence on script.metadata.creativeReview.
 * If no attempt passes, throws CREATIVE_REVIEW_REJECTED so the job is skipped (fail closed).
 */
async function reviewedScriptLoop({ write, review, maxRevisions = MAX_REVISIONS, logger = null, polishTarget = POLISH_TARGET }) {
  const attempts = [];
  let brief = null;
  let best = null;
  let bestPassing = null;
  for (let attempt = 0; attempt <= maxRevisions; attempt += 1) {
    const script = await write(brief);
    if (attempt > 0 && best && String(script.fullScript || '') === String(best.script.fullScript || '')) {
      // The writer produced the identical script (no AI provider to take notes): stop instead of looping.
      attempts.push({ attempt: attempt + 1, overall: best.verdict.overall, passed: false, source: best.verdict.source, failures: ['rewrite produced the identical script'] });
      break;
    }
    const verdict = await review(script);
    attempts.push({ attempt: attempt + 1, overall: verdict.overall, passed: verdict.passed, source: verdict.source, failures: verdict.failures, notes: (verdict.notes || []).slice(0, 12).map(note => String(note).slice(0, 300)) });
    logger?.info?.(`Creative review attempt ${attempt + 1}: ${verdict.overall}/10 [${verdict.source}${script.metadata?.generationSource ? `, writer ${script.metadata.generationSource}` : ''}] ${verdict.passed ? 'passed' : `rejected (${verdict.failures.join('; ')})`}`);
    // The editor's reasons are what decides whether the premise, the writer or the gate needs work; keep them in the log.
    if (!verdict.passed && Array.isArray(verdict.notes) && verdict.notes.length) {
      logger?.info?.(`Creative review notes for attempt ${attempt + 1}: ${verdict.notes.slice(0, 5).join(' || ').replace(/\s+/g, ' ').slice(0, 900)}`);
    }
    if (!best || verdict.overall > best.verdict.overall) best = { script, verdict };
    if (verdict.passed) {
      script.metadata = { ...(script.metadata || {}), creativeReview: { ...verdict, attempts, revisions: attempt } };
      if (!bestPassing || verdict.overall > bestPassing.verdict.overall) bestPassing = { script, verdict };
      // A pass is the floor, not the goal: while rewrites remain and the draft is only just good enough,
      // ask for a better one and keep the best passing draft. The gate itself is unchanged.
      if (verdict.overall >= polishTarget || attempt >= maxRevisions) break;
      logger?.info?.(`Draft passed at ${verdict.overall}/10, below the polish target ${polishTarget}; asking for a stronger rewrite (best so far is kept)`);
    }
    brief = revisionBrief(verdict);
  }
  if (bestPassing) {
    bestPassing.script.metadata = { ...(bestPassing.script.metadata || {}), creativeReview: { ...bestPassing.verdict, attempts, revisions: attempts.length - 1 } };
    return bestPassing.script;
  }
  // The job error is what the owner sees in the alert, so it names every attempt and why the loop
  // stopped (all revisions used, or the writer returned the same script and no rewrite was possible).
  const trail = attempts.map(item => `#${item.attempt} ${item.overall}/10 ${item.failures.join(', ') || 'no failures listed'}`).join(' | ');
  // A deterministic emergency script means the AI writer could not run (quota, provider error, contract); say so,
  // otherwise the alert only shows the low score of a script no AI wrote.
  const writerNote = best.script?.metadata?.generationSource === 'deterministic-fallback'
    ? ` (the AI writer failed and an emergency script was reviewed: ${String(best.script.metadata.fallbackReason || 'no reason recorded').slice(0, 200)})`
    : '';
  const editorNote = (best.verdict.notes || []).filter(Boolean)[0];
  const editorText = editorNote ? ` (editor: ${String(editorNote).replace(/\s+/g, ' ').slice(0, 160)})` : '';
  const error = new Error(`Creative review rejected the script after ${attempts.length} attempt(s): ${best.verdict.failures.join('; ') || 'no revision possible'} [${trail}]${writerNote}${editorText}`);
  error.code = 'CREATIVE_REVIEW_REJECTED';
  error.attempts = attempts;
  error.reviewAttempts = attempts;
  throw error;
}

module.exports = { MAX_REVISIONS, revisionBrief, reviewedScriptLoop };
