'use strict';
const assert = require('assert');
const { reviewedScriptLoop } = require('../utils/creative-review');

(async () => {
  const run = async overalls => {
    let i = 0;
    const calls = [];
    const script = await reviewedScriptLoop({
      write: async brief => { calls.push(brief); i += 1; return { fullScript: `draft ${i}`, metadata: {} }; },
      review: async s => { const o = overalls[Number(s.fullScript.split(' ')[1]) - 1]; return { overall: o, passed: o >= 7, failures: o >= 7 ? [] : ['low'], notes: ['make it better'], source: 't' }; },
      maxRevisions: 2, polishTarget: 8.5
    });
    return { script, calls };
  };
  let r = await run([7.2, 8.8, 9]);
  assert.strictEqual(r.script.fullScript, 'draft 2'); assert.strictEqual(r.calls.length, 2);
  r = await run([7.4, 6.0, 6.5]);
  assert.strictEqual(r.script.fullScript, 'draft 1', 'a worse rewrite must not replace the passing draft');
  r = await run([9]);
  assert.strictEqual(r.calls.length, 1);
  await assert.rejects(run([5, 6, 6.5]), e => e.code === 'CREATIVE_REVIEW_REJECTED');
  console.log('best-of-drafts tests passed');
})().catch(e => { console.error(e); process.exit(1); });
