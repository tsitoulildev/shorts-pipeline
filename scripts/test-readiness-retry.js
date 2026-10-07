'use strict';
const assert = require('assert');
const ProductionReadinessService = require('../utils/production-readiness-service');
const Svc = ProductionReadinessService.ProductionReadinessService || ProductionReadinessService;

(async () => {
  const quiet = { warn() {}, info() {}, error() {} };
  const svc = new Svc({}, {}, { logger: quiet, transientRetryDelayMs: 0 });
  let calls = 0;
  let r = await svc.executeCheck('text', 'Text', true, async () => { calls++; if (calls === 1) throw new Error('429 rate limit'); return { message: 'ok' }; });
  assert.strictEqual(r.status, 'passed'); assert.strictEqual(calls, 2);
  calls = 0;
  r = await svc.executeCheck('text', 'Text', true, async () => { calls++; throw new Error('429 rate limit'); });
  assert.strictEqual(r.status, 'failed'); assert.strictEqual(calls, 2);
  calls = 0;
  r = await svc.executeCheck('text', 'Text', true, async () => { calls++; throw new Error('invalid api key'); });
  assert.strictEqual(r.status, 'failed'); assert.strictEqual(calls, 1);
  console.log('readiness retry tests passed');
})().catch(e => { console.error(e); process.exit(1); });
