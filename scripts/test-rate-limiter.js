// The per-minute token budget of the free providers: a request waits until it fits, a request larger than the limit never does, and the chain skips a
// model whose budget is not free soon instead of sending a request that the provider would answer with a 429.
const assert = require('node:assert/strict');
const { RateLimiter } = require('../utils/llm-rate-limiter');
const { AITextService } = require('../utils/ai-text-service');
const { CooldownTracker } = require('../utils/llm-cooldown');
const { getCandidates, completionBudget } = require('../utils/free-llm-catalog');

let now = 1000000;
const limiter = new RateLimiter({ now: () => now });
const tpm = { tpm: 8000 };
assert.equal(limiter.waitMs('g', tpm, { input: 3000, output: 3000 }), 0);
limiter.record('g', { input: 3000, output: 2500 });
assert.equal(limiter.waitMs('g', tpm, { input: 1000, output: 1000 }), 0, '5500 used + 2000 fits in 8000');
const wait = limiter.waitMs('g', tpm, { input: 3000, output: 3000 });
assert.ok(wait > 59000 && wait <= 61000, `6000 more does not fit: it waits for the window (${wait} ms)`);
now += 61000;
assert.equal(limiter.waitMs('g', tpm, { input: 3000, output: 3000 }), 0, 'a minute later the window is empty');
assert.equal(limiter.waitMs('g', tpm, { input: 9000, output: 100 }), Infinity, 'larger than the limit: never');
const split = { itpm: 7000, otpm: 1000 };
limiter.record('q', { input: 3000, output: 800 });
assert.ok(limiter.waitMs('q', split, { input: 1000, output: 400 }) > 0, 'output tokens per minute are limited on their own');
assert.equal(limiter.waitMs('q', split, { input: 1000, output: 100 }), 0);
assert.equal(limiter.waitMs('x', null, { input: 99999, output: 99999 }), 0, 'no limits: no wait');

// the catalog: limits and caps reach the candidates; models with 0 live successes are gone
const candidates = getCandidates({ task: 'script', maxTokens: 1600, providerIds: ['groq', 'nvidia', 'mistral'], env: {} });
const names = candidates.map(item => item.model);
for (const gone of ['mistral-medium-latest', 'moonshotai/kimi-k3']) assert.ok(!names.includes(gone), `${gone} is out of the chain`);
assert.ok(!candidates.some(item => item.providerId === 'nvidia' && item.model === 'openai/gpt-oss-20b'), 'NVIDIA gpt-oss-20b is out of the chain');
assert.ok(!candidates.some(item => item.providerId === 'nvidia' && item.model !== 'nvidia/nemotron-3-super-120b-a12b'));
const gpt = candidates.find(item => item.model === 'openai/gpt-oss-120b');
assert.deepEqual(gpt.limits, { tpm: 8000 });
assert.deepEqual(gpt.extra, { reasoning_effort: 'low' });
const qwen = candidates.find(item => item.model === 'qwen/qwen3.8-27b');
assert.equal(completionBudget(qwen, 1600), 1000, 'qwen: at most 1000 output tokens');

(async () => {
  // the chain: the first model has no budget for 40 s: it is skipped and the second answers, without a request to the first
  const requests = [];
  const service = Object.create(AITextService.prototype);
  service.logger = { info() {}, warn() {} };
  service.cooldowns = new CooldownTracker();
  service.freePrimaryId = null;
  const answer = { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
  service.freeClients = { groq: { chat: { completions: { create: async request => { requests.push(request.model); return answer; } } } } };
  service._limiter().record('groq:openai/gpt-oss-120b', { input: 4000, output: 3900 });
  const first = { providerId: 'groq', providerName: 'Groq', model: 'openai/gpt-oss-120b', tokenParam: 'max_completion_tokens', reasoning: true, headroom: 800, maxOutput: 65000, limits: { tpm: 8000 }, extra: { reasoning_effort: 'low' } };
  const second = { providerId: 'groq', providerName: 'Groq', model: 'openai/gpt-oss-20b', tokenParam: 'max_completion_tokens', reasoning: true, headroom: 800, maxOutput: 65000 };
  const failures = [];
  const result = await service._runFreeChain([first, second], 'p'.repeat(6000), 1600, 0, failures);
  assert.equal(result.text, 'ok');
  assert.deepEqual(requests, ['openai/gpt-oss-20b'], 'no request to the model without a budget');
  assert.match(failures.join(), /no token budget/);
  console.log('rate limiter: ok');
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
