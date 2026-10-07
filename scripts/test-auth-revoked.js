// invalid_grant (revoked/expired YouTube login) must not kill a Short: it stays scheduled, the owner
// gets one clear alert (not one per retry), and an older "failed: invalid_grant" entry is revived.
const assert = require('node:assert/strict');
const { PublishingSchedulingAgent } = require('../agents/publishing-scheduling-agent');

async function main() {
  const prior = { upload: process.env.YOUTUBE_UPLOAD_ENABLED };
  process.env.YOUTUBE_UPLOAD_ENABLED = 'true';
  try {
    const writes = [];
    const alerts = [];
    const db = {
      getProductionBundle: async () => ({ provenance: { status: 'verified' }, reviewStatus: 'approved' }),
      updateScheduleEntry: async entry => { writes.push(entry.status); }
    };
    const agent = new PublishingSchedulingAgent(db, {});
    agent.logger = { info() {}, warn() {}, error() {}, success() {} };
    agent.notify = async n => { alerts.push(n); };
    agent.isNarrationReady = async () => true;
    agent.assertPreUploadQuality = async () => ({ passed: true });
    agent.uploadToYouTube = async entry => {
      entry.uploadAttempted = true;
      const error = new Error('invalid_grant');
      error.status = 400;
      error.response = { status: 400, data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } };
      throw error;
    };
    const entry = {
      id: 'auth-test', productionId: 'auth-test', title: 'Auth test', status: 'scheduled',
      publishTime: new Date(Date.now() - 60_000).toISOString(), metadata: { seo: {}, video: { path: '/x.mp4' } }
    };
    agent.publishQueue = [entry];

    assert.equal(agent.isAuthError(new Error('invalid_grant')), true);
    assert.equal(agent.isAuthError(new Error('socket hang up')), false);

    assert.equal(await agent.processPublishQueue(), 0);
    assert.equal(entry.status, 'scheduled', 'an auth failure must not mark the Short failed');
    assert.ok(new Date(entry.publishTime) > new Date(), 'the retry must be deferred, not hot-looped');
    assert.equal(entry.uploadAttempted, false, 'nothing reached YouTube');
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].type, 'auth_required');
    assert.match(alerts[0].message, /re-authoriz/i);
    assert.match(alerts[0].message, /In production/);

    // Retried while still revoked: no second alert within 12 h.
    entry.publishTime = new Date(Date.now() - 1000).toISOString();
    await agent.processPublishQueue();
    assert.equal(alerts.length, 1, 'alert must not repeat on every retry');
    assert.equal(entry.status, 'scheduled');

    // Login fixed: the very next queue run uploads it.
    agent.uploadToYouTube = async () => ({ id: 'vid123' });
    agent.reconcileUploadedVideo = async e => { e.status = 'published'; return e; };
    entry.publishTime = new Date(Date.now() - 1000).toISOString();
    assert.equal(await agent.processPublishQueue(), 1);
    assert.equal(entry.status, 'published');

    // A Short an older build already marked failed for invalid_grant is revived once.
    const old = {
      id: 'old', productionId: 'old', title: 'Old', status: 'failed', uploadAttempted: true,
      error: 'invalid_grant', publishTime: '2026-10-04T00:00:00.000Z', metadata: { seo: {}, video: { path: '/x.mp4' } }
    };
    const other = { ...old, id: 'other', productionId: 'other', error: 'Video file is corrupt' };
    agent.publishQueue = [old, other];
    assert.equal(await agent.reviveAuthFailures(), 1);
    assert.equal(old.status, 'scheduled');
    assert.equal(other.status, 'failed', 'unrelated failures must stay failed');

    // Regression: in production the in-memory queue never contains `failed` rows (getPublishQueue only
    // loads scheduled/paused/uploading), so the revive step must fetch them from the database itself.
    const fromDb = { ...old, id: 'from-db', productionId: 'from-db', status: 'failed', uploadAttempted: undefined, error: 'invalid_grant' };
    db.getAuthFailedScheduleEntries = async () => [fromDb];
    agent.publishQueue = [];
    assert.equal(await agent.reviveAuthFailures(), 1, 'a failed/invalid_grant row that is only in the database must be revived');
    assert.equal(fromDb.status, 'scheduled');
    assert.ok(agent.publishQueue.includes(fromDb), 'the revived Short must join the in-memory queue so it is published');
    assert.equal(await agent.reviveAuthFailures(), 0, 'reviving twice must not duplicate work');
    assert.equal(agent.publishQueue.filter(item => item.id === 'from-db').length, 1);

    // The database method must exist and must select only auth-failed rows that never reached YouTube.
    const dbSource = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'database', 'db.js'), 'utf8');
    const method = dbSource.slice(dbSource.indexOf('async getAuthFailedScheduleEntries'), dbSource.indexOf('async getScheduleEntriesInRange'));
    assert.match(method, /status = 'failed'/);
    assert.match(method, /youtube_id IS NULL/);
    assert.match(method, /invalid_grant/);
    console.log('Revoked YouTube login handling: PASS');
  } finally {
    if (prior.upload === undefined) delete process.env.YOUTUBE_UPLOAD_ENABLED; else process.env.YOUTUBE_UPLOAD_ENABLED = prior.upload;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
