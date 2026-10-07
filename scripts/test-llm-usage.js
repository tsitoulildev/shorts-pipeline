// Offline: LLM usage counters track calls, successes, failures and latency without any provider.
const assert = require('assert');
const { AITextService } = require('../utils/ai-text-service');

(async () => {
  AITextService.resetUsage();
  const service = Object.create(AITextService.prototype);
  let mode = 'ok';
  service._generateTextRouted = async () => {
    if (mode === 'fail') throw new Error('boom');
    return 'text';
  };

  assert.strictEqual(await service.generateText('a'), 'text');
  assert.strictEqual(await service.generateText('b'), 'text');
  mode = 'fail';
  await assert.rejects(() => service.generateText('c'), /boom/);

  const usage = AITextService.usageSnapshot();
  assert.strictEqual(usage.calls, 3);
  assert.strictEqual(usage.ok, 2);
  assert.strictEqual(usage.failed, 1);
  assert.ok(usage.totalMs >= 0 && usage.avgMs >= 0);
  assert.ok(!JSON.stringify(usage).match(/key|token|secret/i), 'usage must stay secret-free');
  AITextService.resetUsage();
  assert.strictEqual(AITextService.usageSnapshot().calls, 0);
  console.log('LLM usage: PASS');
})().catch(error => { console.error(error); process.exit(1); });
