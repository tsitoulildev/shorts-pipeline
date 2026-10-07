// Offline: a model the provider answers with 410 Gone is disabled, not retried on every request.
const assert = require('assert');
const { CooldownTracker } = require('../utils/llm-cooldown');

const tracker = new CooldownTracker();
const gone = Object.assign(new Error('410 status code (no body)'), { status: 410 });
assert.strictEqual(tracker.recordFailure('nvidia', 'minimaxai/minimax-m3', gone).action, 'model-disabled');
assert.strictEqual(tracker.state('nvidia', 'minimaxai/minimax-m3'), 'model-disabled');
assert.strictEqual(tracker.isAvailable('nvidia', 'minimaxai/minimax-m3'), false);
// Other models of the same provider stay usable.
assert.strictEqual(tracker.isAvailable('nvidia', 'nvidia/nemotron-3-super-120b-a12b'), true);
console.log('LLM cooldown 410: PASS');

// A short per-minute rate limit is waited out once; a long one is not.
(async () => {
  const { AITextService } = require('../utils/ai-text-service');
  const candidates = [{ providerId: 'groq', model: 'm1' }, { providerId: 'groq', model: 'm2' }];
  const make = () => {
    const service = Object.create(AITextService.prototype);
    service.logger = { info() {}, warn() {} };
    service.cooldowns = new CooldownTracker();
    const slept = [];
    service._sleep = async ms => { slept.push(ms); };
    let calls = 0;
    service._runFreeChain = async () => {
      calls += 1;
      return calls === 1 ? { ok: false, lastError: new Error('429') } : { ok: true, text: 'answer' };
    };
    return { service, slept, calls: () => calls };
  };

  let { service, slept, calls } = make();
  service.cooldowns._cooldown(service.cooldowns.key('groq', 'm1'), 0, 'x'); // no-op guard for API shape
  service.cooldowns.cooldowns.clear();
  service.cooldowns.recordFailure('groq', 'm1', Object.assign(new Error('429 rate'), { status: 429, headers: { 'retry-after-ms': '1500' } }));
  service.cooldowns.recordFailure('groq', 'm2', Object.assign(new Error('429 rate'), { status: 429, headers: { 'retry-after-ms': '9000' } }));
  const result = await service._runFreeChainPatient(candidates, 'p', 100, 0.5, []);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(calls(), 2, 'one retry after the wait');
  assert.ok(slept.length === 1 && slept[0] >= 1500 && slept[0] <= 1900, `waited for the shortest cooldown, got ${slept}`);

  ({ service, slept, calls } = make());
  service.cooldowns.recordFailure('groq', 'm1', Object.assign(new Error('429 rate'), { status: 429, headers: { 'retry-after-ms': '90000' } }));
  const long = await service._runFreeChainPatient(candidates, 'p', 100, 0.5, []);
  assert.strictEqual(long.ok, false);
  assert.strictEqual(calls(), 1, 'a long cooldown is not waited out');
  assert.strictEqual(slept.length, 0);
  console.log('Free chain waits for short rate limits: PASS');
})().catch(error => { console.error(error); process.exit(1); });
