// A blocked or failing system must say so, once, in plain words, and fix what it can by itself.
// Regression for 2026-10-04: the scheduler logged "queued" six times between 06:00 and 16:00 UTC while no
// generation job existed, no alert reached the owner for ~20 hours, and the real cause was buried.
const assert = require('node:assert/strict');
const { DailyAutomation } = require('../schedules/daily-automation');
const { AutonomousChannelOperator } = require('../utils/autonomous-channel-operator');
const { OperatorService } = require('../utils/operator-service');
const { ProductionReadinessService } = require('../utils/production-readiness-service');
const { PublishingSchedulingAgent } = require('../agents/publishing-scheduling-agent');
const guard = require('../utils/youtube-channel-guard');

const silent = { info() {}, warn() {}, error() {}, success() {}, startTimer: () => ({ end() {} }) };
const EXPECTED_CHANNEL = 'UC' + 'a'.repeat(22); // fake id, supplied through the environment like on a real install
process.env.YOUTUBE_EXPECTED_CHANNEL_ID = EXPECTED_CHANNEL;
const HOUR = 3600000;

function makeDb({ strategyStatus = 'active', lastGeneration = null } = {}) {
  const settings = {};
  if (lastGeneration) settings.last_content_generation = lastGeneration;
  return {
    settings,
    getChannelStrategy: async () => ({ id: 's1', status: strategyStatus, cadence_per_week: 21 }),
    getAllRows: async sql => (/queued/.test(sql) ? (settings.__busy ? [{ busy: 1 }] : []) : []),
    getSetting: async key => (key in settings ? settings[key] : null),
    setSetting: async (key, value) => { settings[key] = value; },
    executeQuery: async () => {},
    createNotification: async () => 'notice'
  };
}

function makeScheduler(db, options) {
  const scheduler = new DailyAutomation({}, db, options);
  scheduler.logger = silent;
  return scheduler;
}

function blockedError() {
  const error = new Error('Automated generation is blocked by the production readiness gate because blocking checks failed: youtube_access.');
  error.code = 'READINESS_BLOCKED';
  return error;
}

async function waitFor(condition, label) {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function testSchedulerSelfHealsAndAlertsOnce() {
  // 1. Stale block: the refreshed readiness passes, so the very same tick retries and produces.
  let calls = 0;
  let readinessRuns = 0;
  const alerts = [];
  const healed = makeScheduler(makeDb(), {
    readiness: { run: async () => { readinessRuns += 1; return { status: 'passed', blockingFailures: [] }; } },
    notify: async n => { alerts.push(n); },
    generateContent: async () => {
      calls += 1;
      if (calls === 1) throw blockedError();
      return { id: 'job1' };
    }
  });
  await healed.runDailyContentGeneration();
  assert.equal(calls, 2, 'a stale readiness block must be refreshed and retried in the same tick');
  assert.equal(readinessRuns, 1);
  assert.equal(alerts.length, 0, 'no alert when the system healed itself');

  // 2. A real block: refresh is tried once, not on every tick, and the owner gets an alert with a dedupe key.
  let runs = 0;
  const realAlerts = [];
  const blocked = makeScheduler(makeDb(), {
    readiness: { run: async () => { runs += 1; return { status: 'failed', blockingFailures: ['youtube_access'] }; } },
    notify: async n => { realAlerts.push(n); },
    generateContent: async () => { throw blockedError(); }
  });
  await blocked.runDailyContentGeneration();
  await blocked.runDailyContentGeneration();
  assert.equal(runs, 1, 'the readiness self-heal is rate limited (each run makes live probe calls)');
  assert.equal(realAlerts.length, 2, 'the scheduler reports every failure; the notifier dedupes');
  for (const alert of realAlerts) {
    assert.equal(alert.type, 'automation_failure');
    assert.equal(alert.level, 'error');
    assert.match(alert.message, /production readiness gate/);
    assert.match(alert.dedupeKey, /READINESS_BLOCKED/);
    assert.ok(alert.dedupeMinutes >= 60);
  }
}

async function testSkipReasonsAreTrue() {
  const inactive = makeScheduler(makeDb({ strategyStatus: 'paused' }), {});
  assert.equal(await inactive.shouldGenerateContentToday(), false);
  assert.match(inactive.lastSkipReason, /strategy is not active/);

  const recent = makeScheduler(makeDb({ lastGeneration: new Date(Date.now() - HOUR).toISOString() }), {});
  assert.equal(await recent.shouldGenerateContentToday(), false);
  assert.match(recent.lastSkipReason, /pacing: next Short is due in [67]\.\d h/);

  const due = makeScheduler(makeDb({ lastGeneration: new Date(Date.now() - 9 * HOUR).toISOString() }), {});
  assert.equal(await due.shouldGenerateContentToday(), true);
  assert.equal(due.lastSkipReason, null);
}

async function testStallWatchdog() {
  const alerts = [];
  const notify = async n => { alerts.push(n); };
  const old = new Date(Date.now() - 20 * HOUR).toISOString();

  const stalled = makeScheduler(makeDb({ lastGeneration: old }), { notify });
  const result = await stalled.checkProductionStall();
  assert.ok(result && result.hours >= 19);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, 'production_stalled');
  assert.equal(alerts[0].dedupeKey, 'production_stalled');
  assert.match(alerts[0].title, /No new Short for 20 hours/);

  const fresh = makeScheduler(makeDb({ lastGeneration: new Date(Date.now() - 5 * HOUR).toISOString() }), { notify });
  assert.equal(await fresh.checkProductionStall(), null, 'no alert inside the pacing window');

  const busyDb = makeDb({ lastGeneration: old });
  busyDb.settings.__busy = true;
  assert.equal(await makeScheduler(busyDb, { notify }).checkProductionStall(), null, 'a running job is not a stall');

  const paused = makeScheduler(makeDb({ lastGeneration: old }), { notify });
  paused.isEnabled = false;
  assert.equal(await paused.checkProductionStall(), null, 'a paused scheduler is not a stall');
  assert.equal(alerts.length, 1);
}

async function testNotifierDedupe() {
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  const created = [];
  const stored = {};
  const service = Object.create(OperatorService.prototype);
  service.logger = silent;
  service.db = {
    getSetting: async key => (key in stored ? stored[key] : null),
    setSetting: async (key, value) => { stored[key] = value; },
    createNotification: async n => { created.push(n); return `n${created.length}`; }
  };
  const alert = { type: 'automation_failure', level: 'error', title: 't', message: 'm', dedupeKey: 'k1', dedupeMinutes: 360 };
  assert.equal(await service.notify(alert), 'n1');
  assert.equal(await service.notify(alert), null, 'a repeat inside the window is suppressed');
  assert.equal(created.length, 1);
  assert.equal(await service.notify({ ...alert, dedupeKey: 'k2' }) !== null, true, 'a different cause still alerts');
  assert.equal(await service.notify({ type: 'x', title: 't', message: 'm' }) !== null, true, 'no dedupeKey: always delivered');
  stored['notify_last:k1'] = new Date(Date.now() - 7 * HOUR).toISOString();
  assert.equal(await service.notify(alert) !== null, true, 'after the window the alert is sent again');
}

function makeOperatorDb(runs) {
  return {
    getActiveOperatorRun: async () => null,
    createOperatorRun: async () => { runs.r1 = { id: 'r1', status: 'queued', generatedJobs: [] }; return { ...runs.r1 }; },
    getOperatorRun: async id => (runs[id] ? { ...runs[id] } : null),
    updateOperatorRun: async (id, changes) => { runs[id] = { ...runs[id], ...changes }; return runs[id]; },
    createContentIdea: async () => ({ id: 'idea1' }),
    updateContentIdea: async () => {},
    getGenerationJob: async () => null
  };
}

const plan = [{ topic: 'A door that was never there', angle: 'a', format: 'story', length: 'short', rationale: 'r', pillar: 'p', sourceUrls: [] }];

async function testOperatorKeepsTheCause() {
  const runs = {};
  const notes = [];
  const failing = new AutonomousChannelOperator(makeOperatorDb(runs), {
    researchAndPlan: async () => ({ research: {}, plan }),
    startGenerationJob: async () => { throw new Error('Generation is busy (1/1 active jobs). Try again when the current job finishes.'); },
    waitForGenerationJob: async () => { throw new Error('unreachable'); },
    notify: async n => { notes.push(n); },
    requiresHumanApproval: async () => false
  });
  failing.logger = silent;
  await failing.start({ id: 's1', status: 'active' });
  await waitFor(() => notes.length === 1, 'the failure notification');
  assert.equal(runs.r1.status, 'failed');
  assert.match(runs.r1.error, /Every planned video failed during generation: Generation is busy/, 'the run must keep the real cause');
  assert.equal(notes[0].type, 'autonomous_run_failure', 'a run that produced nothing is not "completed"');
  assert.equal(notes[0].level, 'error');
  assert.match(notes[0].message, /Cause: Generation is busy/);
  assert.match(notes[0].dedupeKey, /^autonomous_run_failure:/);

  const okRuns = {};
  const okNotes = [];
  const succeeding = new AutonomousChannelOperator(makeOperatorDb(okRuns), {
    researchAndPlan: async () => ({ research: {}, plan }),
    startGenerationJob: async () => ({ id: 'j1', status: 'completed', production_id: 'p1', details: { reviewStatus: 'approved' } }),
    waitForGenerationJob: async () => { throw new Error('unreachable'); },
    notify: async n => { okNotes.push(n); },
    requiresHumanApproval: async () => false
  });
  succeeding.logger = silent;
  await succeeding.start({ id: 's1', status: 'active' });
  await waitFor(() => okNotes.length === 1, 'the success notification');
  assert.equal(okRuns.r1.status, 'completed');
  assert.equal(okNotes[0].type, 'autonomous_run_complete');
  assert.equal(okNotes[0].title, 'Autonomous plan completed');
}

async function testChannelGuard() {
  assert.equal(guard.expectedChannelId(process.env), EXPECTED_CHANNEL, 'the expected channel comes from YOUTUBE_EXPECTED_CHANNEL_ID');
  assert.equal(guard.expectedChannelId({}), null, 'the repository no longer names a channel');
  assert.equal(guard.expectedChannelId({ YOUTUBE_EXPECTED_CHANNEL_ID: 'UCother' }), 'UCother');
  assert.equal(guard.expectedChannelId({}, {}), null);
  assert.equal(guard.assertExpectedChannel({ id: EXPECTED_CHANNEL }, process.env).id, EXPECTED_CHANNEL);
  assert.throws(() => guard.assertExpectedChannel({ id: 'anything' }, {}, {}), error => error.code === 'CHANNEL_NOT_CONFIGURED' && guard.isChannelMismatch(error), 'nothing configured: the upload is refused, not allowed');
  assert.throws(
    () => guard.assertExpectedChannel({ id: 'UCwrong', snippet: { title: 'Other channel' } }, process.env),
    error => error.code === 'CHANNEL_MISMATCH' && /Other channel/.test(error.message) && error.message.includes(EXPECTED_CHANNEL)
  );
  assert.throws(() => guard.assertExpectedChannel(null, process.env), error => error.code === 'CHANNEL_MISMATCH');

  // The readiness probe must fail for a valid login on the wrong channel (this is what the first re-auth missed).
  const wrong = { id: 'UCwrong', snippet: { title: 'Other channel' } };
  const right = { id: EXPECTED_CHANNEL, snippet: { title: 'Test Channel' } };
  const probeFor = channel => {
    const service = Object.create(ProductionReadinessService.prototype);
    service.probes = {};
    service.credentialManager = { getYouTubeClient: () => ({ channels: { list: async () => ({ data: { items: [channel] } }) } }) };
    return service.probeYouTube();
  };
  await assert.rejects(probeFor(wrong), error => error.code === 'CHANNEL_MISMATCH');
  const ok = await probeFor(right);
  assert.equal(ok.details.channelId, EXPECTED_CHANNEL);
}

async function testPublishingChecksTheChannelBeforeUploading() {
  const prior = process.env.YOUTUBE_UPLOAD_ENABLED;
  process.env.YOUTUBE_UPLOAD_ENABLED = 'true';
  try {
    const alerts = [];
    const db = {
      getProductionBundle: async () => ({ provenance: { status: 'verified' }, reviewStatus: 'approved' }),
      updateScheduleEntry: async () => {}
    };
    const agent = new PublishingSchedulingAgent(db, {});
    agent.logger = silent;
    agent.notify = async n => { alerts.push(n); };
    agent.isNarrationReady = async () => true;
    agent.assertPreUploadQuality = async () => ({ passed: true });
    agent.getVideoStream = async () => 'stream';
    agent.reconcileUploadedVideo = async entry => { entry.status = 'published'; return entry; };
    let inserts = 0;
    let channel = { id: 'UCwrong', snippet: { title: 'Other channel' } };
    agent.youtube = {
      channels: { list: async () => ({ data: { items: [channel] } }) },
      videos: { insert: async () => { inserts += 1; return { data: { id: 'vid1' } }; } }
    };
    const entry = {
      id: 'guard-test', productionId: 'guard-test', title: 'Guard test', status: 'scheduled',
      publishTime: new Date(Date.now() - 60_000).toISOString(),
      metadata: {
        seo: { title: 'The door that was never there', description: 'A calm, unsettling micro-story.', tags: ['horror', 'stickman'], categoryId: '24', defaultLanguage: 'en', defaultAudioLanguage: 'en' },
        video: { path: '/x.mp4' }
      }
    };
    agent.publishQueue = [entry];

    assert.equal(await agent.processPublishQueue(), 0);
    assert.equal(inserts, 0, 'nothing may be uploaded to the wrong channel');
    assert.equal(entry.status, 'scheduled', 'the Short is kept, not failed');
    assert.ok(!entry.uploadAttempted, 'nothing reached YouTube');
    assert.ok(new Date(entry.publishTime) > new Date(), 'the retry is deferred, not hot-looped');
    assert.equal(entry.metadata.authBlocked.reason, 'channel_mismatch');
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].type, 'auth_required');
    assert.equal(alerts[0].title, 'Wrong YouTube channel authorized');
    assert.match(alerts[0].message, /NOT uploaded/);

    // Still wrong an hour later: no second alert inside 12 h.
    entry.publishTime = new Date(Date.now() - 1000).toISOString();
    await agent.processPublishQueue();
    assert.equal(alerts.length, 1);
    assert.equal(inserts, 0);

    // The owner re-authorizes with the right account: the very next run uploads it.
    channel = { id: EXPECTED_CHANNEL, snippet: { title: 'Test Channel' } };
    entry.publishTime = new Date(Date.now() - 1000).toISOString();
    assert.equal(await agent.processPublishQueue(), 1);
    assert.equal(inserts, 1);
    assert.equal(entry.status, 'published');

    // A client without channel listing (older stubs) is not blocked by the guard.
    delete agent.youtube.channels;
    assert.equal(await agent.assertAuthorizedChannel(), null);
  } finally {
    if (prior === undefined) delete process.env.YOUTUBE_UPLOAD_ENABLED; else process.env.YOUTUBE_UPLOAD_ENABLED = prior;
  }
}

async function main() {
  await testSchedulerSelfHealsAndAlertsOnce();
  await testSkipReasonsAreTrue();
  await testStallWatchdog();
  await testNotifierDedupe();
  await testOperatorKeepsTheCause();
  await testChannelGuard();
  await testPublishingChecksTheChannelBeforeUploading();
  console.log('Scheduler fail-fast and alerts: PASS');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
