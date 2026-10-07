// A definite quota/rate-limit answer from videos.insert (HTTP 403/429) means nothing was uploaded: the Short is
// retried later instead of being marked failed. An unknown outcome (5xx / no status) still goes to reconciliation.
const assert = require('node:assert/strict');
const { PublishingSchedulingAgent } = require('../agents/publishing-scheduling-agent');

async function run(error) {
  const prior = process.env.YOUTUBE_UPLOAD_ENABLED;
  process.env.YOUTUBE_UPLOAD_ENABLED = 'true';
  try {
    const alerts = [];
    const db = {
      getProductionBundle: async () => ({ provenance: { status: 'verified' }, reviewStatus: 'approved' }),
      updateScheduleEntry: async () => {}
    };
    const agent = new PublishingSchedulingAgent(db, {});
    agent.logger = { info() {}, warn() {}, error() {}, success() {} };
    agent.alert = async alert => { alerts.push(alert); };
    agent.notify = async alert => { alerts.push(alert); };
    agent.isNarrationReady = async () => true;
    agent.assertPreUploadQuality = async () => ({ passed: true });
    agent.uploadToYouTube = async entry => { entry.uploadAttempted = true; throw error; };
    const entry = {
      id: 'q', productionId: 'q', title: 'Quota test', status: 'scheduled',
      publishTime: new Date(Date.now() - 60_000).toISOString(), metadata: { seo: {}, video: { path: '/x.mp4' } }
    };
    agent.publishQueue = [entry];
    await agent.processPublishQueue();
    return { entry, alerts };
  } finally {
    if (prior === undefined) delete process.env.YOUTUBE_UPLOAD_ENABLED;
    else process.env.YOUTUBE_UPLOAD_ENABLED = prior;
  }
}

(async () => {
  const quota = Object.assign(new Error('The request cannot be completed because you have exceeded your quota.'), {
    status: 403, errors: [{ reason: 'quotaExceeded' }]
  });
  let { entry } = await run(quota);
  assert.equal(entry.status, 'scheduled', 'a quota answer must not fail the Short');
  assert.ok(new Date(entry.publishTime) > new Date(Date.now() + 5 * 3600 * 1000), 'retry is deferred about 6 hours');
  assert.equal(entry.uploadAttempted, false);

  ({ entry } = await run(Object.assign(new Error('Too many requests'), { status: 429 })));
  assert.equal(entry.status, 'scheduled', '429 is retried');

  ({ entry } = await run(Object.assign(new Error('Backend error'), { status: 503 })));
  assert.equal(entry.status, 'reconciliation_required', 'an unknown outcome is reconciled, never blindly retried');

  ({ entry } = await run(Object.assign(new Error('Forbidden: invalid video'), { status: 400 })));
  assert.equal(entry.status, 'failed', 'a permanent client error still fails the Short');
  console.log('Quota retry: PASS');
})().catch(error => { console.error(error); process.exit(1); });

// Two simultaneous publishes of the same production: only one reaches the upload.
(async () => {
  const prior = process.env.YOUTUBE_UPLOAD_ENABLED;
  process.env.YOUTUBE_UPLOAD_ENABLED = 'true';
  try {
    const db = {
      getProductionBundle: async () => ({ provenance: { status: 'verified' }, reviewStatus: 'approved' }),
      updateScheduleEntry: async () => {}
    };
    const agent = new PublishingSchedulingAgent(db, {});
    agent.logger = { info() {}, warn() {}, error() {}, success() {} };
    agent.isNarrationReady = async () => { await new Promise(resolve => setTimeout(resolve, 20)); return true; };
    agent.assertPreUploadQuality = async () => ({ passed: true });
    let uploads = 0;
    agent.uploadToYouTube = async () => { uploads += 1; return { id: 'vid1' }; };
    agent.reconcileUploadedVideo = async entry => entry;
    const entry = {
      id: 'dup', productionId: 'dup', title: 'Dup test', status: 'scheduled',
      publishTime: new Date(Date.now() - 60_000).toISOString(), metadata: { seo: {}, video: { path: '/x.mp4' } }
    };
    agent.publishQueue = [entry];
    const results = await Promise.allSettled([agent.publishContent('dup'), agent.publishContent('dup')]);
    assert.equal(uploads, 1, 'the same production is uploaded once');
    assert.ok(results.some(item => item.status === 'rejected' && item.reason.code === 'UPLOAD_IN_PROGRESS'));
    // The lock is released afterwards.
    assert.equal(agent.uploadsInFlight.size, 0);
    console.log('Single upload per production: PASS');
  } finally {
    if (prior === undefined) delete process.env.YOUTUBE_UPLOAD_ENABLED;
    else process.env.YOUTUBE_UPLOAD_ENABLED = prior;
  }
})().catch(error => { console.error(error); process.exit(1); });
