// NVIDIA model selection: only models measured to answer stay, per-model timeouts, timeouts/empty answers move on at once and keep failing
// models out for 30 minutes, a finished JSON answer in the reasoning field is used, per-model statistics are kept.
const assert = require('node:assert/strict');
const { CooldownTracker } = require('../utils/llm-cooldown');
const { AITextService } = require('../utils/ai-text-service');
const { FREE_PROVIDERS, getCandidates } = require('../utils/free-llm-catalog');

// catalog: every NVIDIA tier lists only measured models and each carries a timeout
const measured = new Set(['moonshotai/kimi-k3', 'nvidia/nemotron-3-super-120b-a12b', 'openai/gpt-oss-20b']);
for (const [tier, models] of Object.entries(FREE_PROVIDERS.nvidia.tiers)) {
  assert.ok(models.length >= 2, `${tier} keeps at least two models`);
  for (const model of models) {
    assert.ok(measured.has(model.id), `${model.id} was not measured as working`);
    assert.ok(model.timeoutMs >= 20000 && model.timeoutMs <= 60000, `${model.id} has a timeout`);
  }
}
const candidates = getCandidates({ task: 'script', maxTokens: 2200, providerIds: ['nvidia'], env: {} });
assert.ok(candidates.length && candidates.every(item => item.timeoutMs), 'candidates carry the per-model timeout');

// tracker: timeout, timeout, then out for 30 min; an empty answer counts the same; a success resets
let now = 1000;
const tracker = new CooldownTracker({ now: () => now });
const timeout = () => Object.assign(new Error('Request timed out.'), { code: 'ETIMEDOUT' });
const empty = () => Object.assign(new Error('returned an empty response'), { code: 'AI_EMPTY_RESPONSE' });
assert.deepEqual([tracker.recordFailure('nvidia', 'm', timeout()).ms, tracker.recordFailure('nvidia', 'm', empty()).ms], [20000, 60000]);
const out = tracker.recordFailure('nvidia', 'm', timeout());
assert.equal(out.action, 'expelled');
assert.equal(out.ms, 30 * 60 * 1000);
assert.equal(tracker.isAvailable('nvidia', 'm'), false);
now += 31 * 60 * 1000;
assert.equal(tracker.isAvailable('nvidia', 'm'), true);
tracker.recordSuccess('nvidia', 'm', 800);
assert.equal(tracker.recordFailure('nvidia', 'm', timeout()).ms, 20000, 'a success resets the count');
const stat = tracker.getStats().find(item => item.model === 'nvidia:m');
assert.deepEqual([stat.ok, stat.avgOkMs, stat.timeout, stat.empty, stat.expelled], [1, 800, 3, 1, 1]);

(async () => {
  const make = create => {
    const service = Object.create(AITextService.prototype);
    service.logger = { info() {}, warn() {} };
    service.cooldowns = new CooldownTracker();
    service.freePrimaryId = null;
    service.freeClients = { nvidia: { chat: { completions: { create } } } };
    return service;
  };
  const candidate = { providerId: 'nvidia', providerName: 'NVIDIA NIM', model: 'moonshotai/kimi-k3', tokenParam: 'max_tokens', reasoning: true, maxOutput: null, timeoutMs: 40000 };
  const reply = (message, finish = 'stop') => ({ choices: [{ message, finish_reason: finish }] });

  // the per-model timeout reaches the request; the reasoning headroom is added
  let seen = null;
  const service = make(async (request, options) => { seen = { request, options }; return reply({ content: '{"a":1}' }); });
  assert.equal(await service._generateFree(service.freeClients.nvidia, candidate, 'p', 1000, 0), '{"a":1}');
  assert.equal(seen.options.timeout, 40000);
  assert.ok(seen.request.max_tokens > 1000, 'reasoning models get headroom');

  // empty content + a finished JSON object in the reasoning field: used; without one: an empty-response error
  const rescued = make(async () => reply({ content: '', reasoning_content: 'thinking... the answer is {"title":"x","beats":[{"narration":"n"}]} done' }));
  assert.deepEqual(JSON.parse(await rescued._generateFree(rescued.freeClients.nvidia, candidate, 'p', 1000, 0)), { title: 'x', beats: [{ narration: 'n' }] });
  const cut = make(async () => reply({ content: null, reasoning_content: 'still thinking about {"title": ' }, 'length'));
  await assert.rejects(() => cut._generateFree(cut.freeClients.nvidia, candidate, 'p', 1000, 0), error => error.code === 'AI_EMPTY_RESPONSE' && /token budget/.test(error.message));

  // the chain: a timeout hands over to the next model at once and the timing model is cooling down
  const calls = [];
  const chain = make(async request => {
    calls.push(request.model);
    if (request.model === 'moonshotai/kimi-k3') throw Object.assign(new Error('Request timed out.'), { code: 'ETIMEDOUT' });
    return reply({ content: 'from-next' });
  });
  const second = { ...candidate, model: 'nvidia/nemotron-3-super-120b-a12b' };
  const failures = [];
  const result = await chain._runFreeChain([candidate, second], 'p', 1000, 0, failures);
  assert.equal(result.text, 'from-next');
  assert.deepEqual(calls, ['moonshotai/kimi-k3', 'nvidia/nemotron-3-super-120b-a12b']);
  assert.equal(chain.cooldowns.isAvailable('nvidia', 'moonshotai/kimi-k3'), false);
  const stats = chain.cooldowns.getStats();
  assert.equal(stats.find(item => item.model.endsWith('kimi-k3')).timeout, 1);
  assert.equal(stats.find(item => item.model.endsWith('nemotron-3-super-120b-a12b')).ok, 1);
  console.log('nvidia selection: ok');
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
