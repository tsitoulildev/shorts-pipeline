// Offline: a Gemini model marked "daily quota exhausted" must come back after the daily reset,
// and a creative-review rejection of an emergency script must name why the AI writer failed.
const assert = require('assert');
const { AITextService } = require('../utils/ai-text-service');
const review = require('../utils/creative-review');

(async () => {
  const quotaError = () => Object.assign(new Error('429 Quota exceeded for metric GenerateRequestsPerDayPerProjectPerModel-FreeTier'), { status: 429 });
  const service = Object.create(AITextService.prototype);
  service.logger = { warn() {}, info() {}, error() {} };
  service.shouldFallback = () => true;
  const calls = [];
  let quotaGone = false;
  service._generateGemini = async (client, name, model) => {
    calls.push(model);
    if (!quotaGone && model !== 'gemini-3.5-flash-lite') throw quotaError();
    return `ok:${model}`;
  };

  // Day 1: the two main models hit the daily limit, the lite model answers.
  assert.strictEqual(await service._generateGeminiWithModelFallback(null, 'G', 'gemini-3.8-flash', 'p'), 'ok:gemini-3.5-flash-lite');
  // Same day: exhausted models are skipped, not called again.
  calls.length = 0;
  await service._generateGeminiWithModelFallback(null, 'G', 'gemini-3.8-flash', 'p');
  assert.deepStrictEqual(calls, ['gemini-3.5-flash-lite']);

  // Reset time is in the future and at most 24 h away.
  const now = Date.now();
  const reset = service.nextGeminiQuotaReset(now);
  assert.ok(reset > now && reset - now <= 24 * 3600 * 1000 + 1000);

  // After the reset the process must try the main model again (the old code skipped it until a restart).
  for (const model of [...service.exhaustedGeminiModels.keys()]) service.exhaustedGeminiModels.set(model, now - 1);
  quotaGone = true;
  calls.length = 0;
  assert.strictEqual(await service._generateGeminiWithModelFallback(null, 'G', 'gemini-3.8-flash', 'p'), 'ok:gemini-3.8-flash');
  assert.deepStrictEqual(calls, ['gemini-3.8-flash']);

  // Rejection of an emergency script names the writer failure.
  const emergency = { fullScript: 'x y z', metadata: { generationSource: 'deterministic-fallback', fallbackReason: 'quota exhausted on every model' } };
  await assert.rejects(review.reviewedScriptLoop({
    write: async () => emergency,
    review: async () => ({ overall: 6.36, passed: false, source: 'heuristic-only', failures: ['overall 6.36 is below 7'], notes: [] }),
    maxRevisions: 1
  }), error => {
    assert.match(error.message, /AI writer failed/);
    assert.match(error.message, /quota exhausted on every model/);
    return true;
  });
  console.log('Gemini quota reset: PASS');
})().catch(error => { console.error(error); process.exit(1); });

// Failover on unusable answers: skipPrimary sends the request to the next provider; without it the primary answers.
(async () => {
  const service = Object.create(AITextService.prototype);
  service.logger = { warn() {}, info() {}, error() {} };
  service.gemini = {};
  service.fallbacks = [];
  service.model = 'gemini-3.8-flash';
  service.freeProviders = ['groq'];
  service.shouldFallback = AITextService.prototype.shouldFallback;
  const seen = [];
  service._generateGeminiWithModelFallback = async () => { seen.push('gemini'); return 'weak draft'; };
  service._freeCandidates = () => [{ providerId: 'groq', providerName: 'Groq', model: 'm' }];
  service._runFreeChain = async () => { seen.push('groq'); return { ok: true, text: 'strong draft' }; };
  assert.strictEqual(await service._generateTextRouted('p', {}), 'weak draft');
  assert.strictEqual(await service._generateTextRouted('p', { skipPrimary: true }), 'strong draft');
  assert.deepStrictEqual(seen, ['gemini', 'groq']);
  // With no alternative provider the primary still answers (nothing to switch to).
  service._freeCandidates = () => [];
  assert.strictEqual(await service._generateTextRouted('p', { skipPrimary: true }), 'weak draft');
  console.log('Provider switch on unusable answer: PASS');
})().catch(error => { console.error(error); process.exit(1); });

// The rejection keeps the editor's first note and the log carries the notes and the writer source.
(async () => {
  const lines = [];
  const logger = { info: line => lines.push(line), warn() {}, error() {} };
  await assert.rejects(review.reviewedScriptLoop({
    write: async () => ({ fullScript: `draft ${lines.length}`, metadata: { generationSource: 'ai' } }),
    review: async () => ({ overall: 6.71, passed: false, source: 'ai+heuristic', failures: ['originality 5 is below 6'], notes: ['The twist is a known trope: the voice repeats her breathing.'] }),
    maxRevisions: 1,
    logger
  }), error => {
    assert.match(error.message, /\(editor: The twist is a known trope/);
    return true;
  });
  assert.ok(lines.some(line => /\[ai\+heuristic, writer ai\]/.test(line)), 'source and writer are logged');
  assert.ok(lines.some(line => /notes for attempt 1: The twist is a known trope/.test(line)), 'editor notes are logged');
  console.log('Review diagnostics: PASS');
})().catch(error => { console.error(error); process.exit(1); });
