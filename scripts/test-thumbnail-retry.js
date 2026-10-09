// The thumbnail call is retried (YouTube can refuse it right after an upload) and gives up quietly after the last attempt.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PublishingSchedulingAgent } = require('../agents/publishing-scheduling-agent');

const silent = { info() {}, warn() {}, error() {} };
const file = path.join(os.tmpdir(), `thumb-${process.pid}.jpg`);
fs.writeFileSync(file, 'x');
const make = failures => {
  const agent = new PublishingSchedulingAgent({}, {});
  agent.logger = silent;
  agent.thumbnailRetryDelayMs = 1;
  const calls = [];
  agent.youtube = { thumbnails: { set: async () => { calls.push(1); if (calls.length <= failures) throw new Error('The request might not be properly authorized.'); } } };
  return { agent, calls };
};
(async () => {
  const ok = make(0); await ok.agent.uploadThumbnail('v', file); assert.equal(ok.calls.length, 1);
  const retry = make(2); await retry.agent.uploadThumbnail('v', file); assert.equal(retry.calls.length, 3, 'two refusals, then it works');
  const never = make(99); await never.agent.uploadThumbnail('v', file); assert.equal(never.calls.length, 4, 'gives up after four attempts without throwing');
  const missing = make(0); await missing.agent.uploadThumbnail('v', file + '.nope'); assert.equal(missing.calls.length, 0);
  fs.rmSync(file, { force: true });
  console.log('thumbnail retry: ok');
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
