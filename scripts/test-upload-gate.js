const assert = require('node:assert/strict');
const { PublishingSchedulingAgent } = require('../agents/publishing-scheduling-agent');

async function main() {
  const prior = process.env.YOUTUBE_UPLOAD_ENABLED;
  process.env.YOUTUBE_UPLOAD_ENABLED = 'false';
  let writes = 0;
  let uploads = 0;
  const db = {
    getProductionBundle: async () => ({ provenance: { status: 'verified' }, reviewStatus: 'approved' }),
    updateScheduleEntry: async () => { writes++; }
  };
  const agent = new PublishingSchedulingAgent(db, {});
  agent.youtube = { videos: { insert: async () => { uploads++; } } };
  agent.logger = { info() {}, warn() {}, error() {} };
  const scheduled = {
    id: 'gate-test',
    productionId: 'gate-test',
    title: 'Gate test',
    status: 'scheduled',
    publishTime: new Date(Date.now() - 60_000).toISOString(),
    metadata: { seo: {}, video: { path: '/unreachable.mp4' } }
  };
  agent.publishQueue = [scheduled];
  try {
    await assert.rejects(agent.publishContent('gate-test'), { code: 'UPLOAD_DISABLED' });
    await assert.rejects(agent.uploadToYouTube(scheduled), { code: 'UPLOAD_DISABLED' });
    assert.equal(await agent.processPublishQueue(), 0);
    assert.equal(scheduled.status, 'scheduled');
    assert.equal(writes, 0, 'gate must run before database changes');
    assert.equal(uploads, 0, 'gate must run before the YouTube API');
    console.log('YouTube upload gate: PASS');
  } finally {
    if (prior === undefined) delete process.env.YOUTUBE_UPLOAD_ENABLED;
    else process.env.YOUTUBE_UPLOAD_ENABLED = prior;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
