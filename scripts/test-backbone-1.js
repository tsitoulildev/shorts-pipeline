// Backbone: (1) a swallowed ffmpeg/TTS failure is named in the job error; (2) an entry left in 'uploaded' by a crash is
// verified and published by the cron, while an upload still running in this process is left alone.
const assert = require('node:assert/strict');
const { GenerationRecoveryService } = require('../utils/generation-recovery-service');
const { PublishingSchedulingAgent } = require('../agents/publishing-scheduling-agent');

(async () => {
  const saved = [];
  const db = {
    getGenerationCheckpoint: async () => null,
    saveGenerationCheckpoint: async (_job, _stage, data) => { saved.push(data); },
    deleteGenerationCheckpoints: async () => {}
  };
  const recovery = new GenerationRecoveryService(db, { maxAttempts: 1, baseDelayMs: 0 });
  const simulated = {
    id: 'p1',
    assets: { finalVideo: { path: '/x.assembly.json', simulated: true, blockedReason: 'ffmpeg exited 1: Unknown filter subtitles' }, audio: { error: 'No live narration provider returned usable audio' } }
  };
  await assert.rejects(
    recovery.run('job1', 'production', 70, async () => simulated),
    /incomplete or missing artifact \(ffmpeg exited 1: Unknown filter subtitles \| No live narration provider returned usable audio\)/
  );
  assert.ok(saved.some(item => /Unknown filter subtitles/.test(item.error || '')), 'checkpoint stores the real cause');

  const updates = [];
  const agent = new PublishingSchedulingAgent({ updateScheduleEntry: async e => { updates.push(e.status); } }, {});
  agent.logger = { info() {}, warn() {}, error() {}, success() {} };
  agent.alert = async () => {};
  agent.youtube = { videos: { list: async () => ({ data: { items: [{ id: 'VID1', status: { uploadStatus: 'processed' } }] } }) } };
  agent.reviveAuthFailures = async () => 0;
  const stuck = { id: 's1', productionId: 's1', title: 'Stuck', status: 'uploaded', youtubeId: 'VID1', publishTime: new Date().toISOString() };
  const running = { id: 's2', productionId: 's2', title: 'Running', status: 'uploaded', youtubeId: 'VID2', publishTime: new Date().toISOString() };
  agent.uploadsInFlight = new Set(['s2']);
  agent.publishQueue = [stuck, running];
  await agent.processPublishQueue();
  assert.equal(stuck.status, 'published', 'a crash-orphaned upload is verified and published');
  assert.equal(running.status, 'uploaded', 'an upload still running in this process is not touched');
  console.log('Backbone 1: PASS');
})().catch(e => { console.error(e); process.exit(1); });
