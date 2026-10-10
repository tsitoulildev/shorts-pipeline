// Offline proof for the Dark History switch (DARK_HISTORY_LIVE), on a real SQLite file and real FFmpeg renders with stand-in photos
// and a generated tone (no network, no TTS, no LLM, no YouTube):
//  - flag OFF: the scheduler path is the old one; the pool, the documentary code and the new gates are never touched
//  - flag ON: a pool story becomes a scheduled Short through the existing quality checks + the documentary gate; every failure
//    returns the story, alerts with the cause, never falls back to the old pipeline and never publishes weaker content
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

delete process.env.MISTRAL_API_KEY; // the vision judge must be the Gemini stub below, never a real provider from .env
process.env.APPROVAL_REQUIRED = 'false';
process.env.AUTONOMOUS_MODE = 'true';
process.env.YOUTUBE_UPLOAD_ENABLED = 'true';
process.env.LOCAL_TTS_COMMAND = '/opt/piper/bin/python3 -m piper -m en_US-ryan-high --data-dir /opt/voices --input-file {text} -f {wav}';
delete process.env.DARK_HISTORY_LIVE;
delete process.env.DARK_HISTORY_VOICE;
// the VM's .env sets the pool horizon (10 days) and dotenv never overrides a set variable: the pool arithmetic below is written for the default 14 days
process.env.DARK_HISTORY_POOL_HORIZON_DAYS = '14';

const { Database } = require('../database/db');
const { YouTubeAutomationAgent } = require('../index');
const { OperatorService } = require('../utils/operator-service');
const { ProvenanceService } = require('../utils/provenance-service');
const { DailyAutomation } = require('../schedules/daily-automation');
const { ProductionReadinessService } = require('../utils/production-readiness-service');
const { runFFmpeg, checkFFmpeg } = require('../utils/ffmpeg');
const { softPhoto, rescaledCopy } = require('./lib/stand-in-photos');
const { StoryPool } = require('../utils/dark-history/story-pool');
const { isLive, isDocumentary, buildProductionData } = require('../utils/dark-history/live');
// index.js calls dotenv, which puts the keys of a local .env (the VM's) back into the environment: remove the vision key again AFTER the requires,
// otherwise the footage check sends the stand-in pictures to the real Mistral model (found on the first deploy after the key was configured).
delete process.env.MISTRAL_API_KEY;
delete process.env.DARK_HISTORY_LIVE;
const { attributionText } = require('../utils/dark-history/attribution');
const { produceDocumentaryShort } = require('../utils/dark-history/produce');

const silent = { info() {}, warn() {}, error() {}, success() {}, startTimer: () => ({ end() {} }) };
const SENTENCES = [
  'The ship was found drifting in the Atlantic Ocean in December.',
  'The lifeboat was missing from the deck of the vessel.',
  'The cargo of alcohol was still intact in the hold below.',
  'Nobody who had been on board was ever seen again.'
];
const wikiUrl = title => `https://en.wikipedia.org/wiki/${title.replace(/ /g, '_')}`;

// extraBeat: a 5th beat whose picture repeats the first one (the same scene at another size)
async function makeStory(dir, title = 'Mary Celeste', { duplicates = 0, base = 4 } = {}) {
  const folder = path.join(dir, `images-${title.replace(/\W+/g, '_')}`);
  fs.mkdirSync(folder, { recursive: true });
  const dims = [[1600, 1067], [1500, 600], [900, 1600], [1280, 960]].slice(0, base).concat(Array(duplicates).fill([1200, 800]));
  const beats = [];
  for (let i = 0; i < dims.length; i += 1) {
    const raw = path.join(folder, `raw${i}.png`);
    if (i < base) await softPhoto(raw, dims[i][0], dims[i][1], i * 13 + 1);
    else await rescaledCopy(path.join(folder, 'first.png'), raw, dims[i][0], dims[i][1]); // the first picture again at another size
    if (i === 0) fs.copyFileSync(raw, path.join(folder, 'first.png'));
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(raw)).digest('hex');
    const file = `${sha256.slice(0, 16)}.png`;
    fs.renameSync(raw, path.join(folder, file));
    beats.push({
      heading: `Beat ${i + 1}`, text: SENTENCES[i] || SENTENCES[0],
      images: [{ title: `${title} photo ${i + 1}.png`, file, sha256, width: dims[i][0], height: dims[i][1], mime: 'image/png', license: i === 1 ? 'CC BY 4.0' : 'Public domain', author: i === 1 ? 'A. Photographer' : null,
        descriptionUrl: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(title)}_photo_${i + 1}.png`, fileUrl: `https://upload.wikimedia.org/wikipedia/commons/${i}/photo${i + 1}.png`, licenseUrl: null }]
    });
  }
  return { title, folder, beats, extract: SENTENCES.join(' '), attribution: attributionText({ title, url: wikiUrl(title) }, beats) };
}

const addToPool = async (pool, built) => pool.add({
  title: built.title, status: 'ready', articleUrl: wikiUrl(built.title), revisionId: 4242,
  plan: { title: built.title, extract: built.extract, folder: built.folder, beats: built.beats }, attribution: built.attribution
});

/** The text model: a faithful draft that restates the source, and a verifier that finds nothing to flag (or garbage, for the failure runs). */
function makeLlm(mode = { writer: 'ok' }) {
  const llm = {
    calls: 0,
    model: 'gemini-test',
    // the vision model: looks at the real stand-in pictures (sent as inline data) and finds every one fitting, unless the mode says otherwise
    gemini: mode.vision === 'none' ? null : { models: { generateContent: async request => {
      // the footage check (passages) finds every picture fitting; the narration check (narrations) is the one a mode can fail
      const asksAboutPassages = /PASSAGE 1:/.test(request.contents[0].parts[request.contents[0].parts.length - 1].text);
      if (!asksAboutPassages) { llm.visionCalls = (llm.visionCalls || 0) + 1; llm.lastVision = request; }
      llm.footageChecks = (llm.footageChecks || 0) + (asksAboutPassages ? 1 : 0);
      const wrong = (!asksAboutPassages && mode.vision === 'mismatch') || (asksAboutPassages && mode.vision === 'footage');
      return { text: JSON.stringify({ mismatch: wrong ? [{ beat: 2, reason: 'wrong picture' }] : [] }) };
    } } },
    async generateText(prompt) {
      llm.calls += 1;
      if (/strict fact-checker/.test(prompt)) return JSON.stringify({ unsupported: [] });
      if (mode.writer === 'garbage') return 'I cannot help with that.';
      return JSON.stringify({ title: 'The Ship Found Empty', beats: SENTENCES.map(s => ({ narration: s, evidence: [s] })) });
    }
  };
  return llm;
}

(async () => {
  assert.ok(await checkFFmpeg(), 'FFmpeg must be available');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-live-'));
  const db = new Database();
  db.dbPath = path.join(dir, 'live.db');
  await db.initialize();
  const pool = new StoryPool(db);

  // ---- the switch ----
  assert.strictEqual(isLive({}), false, 'default is off');
  for (const value of ['', 'false', '1', 'yes', 'on', 'TRUE ']) assert.strictEqual(isLive({ DARK_HISTORY_LIVE: value }), value.trim().toLowerCase() === 'true');
  assert.strictEqual(isLive({ DARK_HISTORY_LIVE: 'true' }), true);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8').split('\n').filter(line => /^DARK_HISTORY_LIVE=/.test(line)).map(line => JSON.stringify(line.split('=')[1]))[0]), 'false', '.env.example ships with the switch off');

  // ---- pool: a failed story goes back, three failures reject it (with the reason), a cancel is not its fault ----
  const sample = await addToPool(pool, await makeStory(dir, 'Pool Sample'));
  const claimed = await pool.claimNext();
  assert.strictEqual(claimed.id, sample);
  assert.strictEqual(await pool.claimNext(), null, 'a claimed story is not handed out twice');
  assert.deepStrictEqual(await pool.release(sample, { reason: 'ffmpeg crashed' }), { status: 'ready', attempts: 1 });
  assert.strictEqual((await pool.claimNext()).id, sample);
  assert.deepStrictEqual(await pool.release(sample, { reason: 'cancelled', countAttempt: false }), { status: 'ready', attempts: 1 });
  await pool.claimNext();
  await pool.release(sample, { reason: 'x' });
  await pool.claimNext();
  const last = await pool.release(sample, { reason: 'the last failure' });
  assert.deepStrictEqual(last, { status: 'rejected', attempts: 3 });
  assert.match((await db.getRow('SELECT reason FROM story_pool WHERE id = ?', [sample])).reason, /failed 3 times, last: the last failure/);
  assert.strictEqual(await pool.claimNext(), null, 'a rejected story is never handed out again');
  await db.executeQuery('DROP TABLE story_pool');
  const reopened = new StoryPool(db);
  await db.executeQuery("CREATE TABLE story_pool (id TEXT PRIMARY KEY, title TEXT NOT NULL UNIQUE, status TEXT NOT NULL, article_url TEXT, revision_id INTEGER, plan TEXT, attribution TEXT, share_alike INTEGER DEFAULT 0, reason TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, used_at TEXT)");
  assert.strictEqual(await reopened.readyCount(), 0, 'a pool table created before the attempts column still works');
  assert.ok((await db.getAllRows('PRAGMA table_info(story_pool)')).some(column => column.name === 'attempts'));

  // ---- the production record passes the existing checks AND the documentary gate, and each kind of damage fails them ----
  const built = await makeStory(dir, 'Gate Story');
  const story = {
    id: 'story_gate', article_url: wikiUrl('Gate Story'), revision_id: 4242, attribution: built.attribution,
    plan: { title: built.title, extract: built.extract, folder: built.folder, beats: built.beats }
  };
  const script = {
    title: 'The Ship Found Empty', hook: SENTENCES[0],
    beats: built.beats.map((b, i) => ({ heading: b.heading, narration: SENTENCES[i], evidence: [SENTENCES[i]], images: b.images })),
    metadata: { creativeReview: { passed: true, overall: 8.5, facts: { passed: true }, imageFit: { passed: true, checkedBeats: 4 } } }
  };
  script.fullScript = SENTENCES.join(' ');
  const tone = async (_text, out) => runFFmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=12', '-ar', '24000', '-ac', '1', out]);
  const made = await produceDocumentaryShort({ story, script, narrate: tone, workDir: path.join(dir, 'out-gate') });
  assert.strictEqual(made.gate.passed, true, JSON.stringify(made.gate.checks.filter(c => !c.passed)));
  const productionData = buildProductionData({ story: made.story, script, result: made, narrationPath: path.join(dir, 'out-gate', 'narration.mp3'), voice: 'en_US-ljspeech-high' });
  assert.ok(isDocumentary(productionData) && isDocumentary({ details: { pipeline: 'dark-history' } }) && !isDocumentary({ details: {} }));
  assert.strictEqual(productionData.strategy.fictional, false);
  assert.strictEqual(productionData.assets.audio.model, 'piper:en_US-ljspeech-high');
  const operator = new OperatorService(db);
  const provenance = new ProvenanceService(db);
  await db.saveProductionData(productionData);
  await db.saveProductionSnapshot(productionData);
  productionData.provenance = await provenance.initialize(productionData.id, productionData);
  assert.strictEqual(productionData.provenance.status, 'verified', 'every narrated beat is a supported claim with a verified source');
  const quality = await operator.runQualityChecks(productionData, {});
  assert.deepStrictEqual(quality.checks.filter(c => c.blocking && !c.passed), [], JSON.stringify(quality.checks.filter(c => !c.passed)));
  assert.strictEqual(quality.passed, true);
  const ids = quality.checks.map(c => c.id);
  for (const id of ['dh_footage_per_beat', 'dh_no_near_duplicate_images', 'dh_image_hold_limit', 'dh_images_fit_narration', 'dh_image_files_intact', 'dh_license_free_per_image', 'dh_claims_map_to_source', 'dh_attribution_in_description', 'dh_description_survives_upload', 'dh_voice_public_domain', 'dh_video_format', 'media_provenance', 'visual_diversity', 'media_attribution', 'provenance', 'narration', 'captions', 'thumbnail', 'video_file', 'av_sync']) {
    assert.ok(ids.includes(id), `check ${id} ran`);
  }
  assert.ok(!ids.some(id => /^horror_/.test(id)), 'no stickman check applies to a documentary');

  const clone = value => JSON.parse(JSON.stringify(value));
  const failsWith = async (mutate, id) => {
    const copy = clone(productionData);
    mutate(copy);
    const verdict = await operator.runQualityChecks(copy, {});
    assert.strictEqual(verdict.passed, false, `must fail: ${id}`);
    assert.ok(verdict.blockingFailures.includes(id), `${id} must block, got ${verdict.blockingFailures}`);
  };
  await failsWith(c => { c.strategy.documentary.story.plan.beats[0].images[0].sha256 = 'f'.repeat(64); }, 'dh_image_files_intact');
  await failsWith(c => { c.strategy.documentary.story.plan.beats[1].images[0].license = 'CC BY-NC 4.0'; }, 'dh_license_free_per_image');
  await failsWith(c => { c.seo.description = c.seo.description.replace(c.strategy.documentary.story.attribution, 'Images: various'); }, 'dh_attribution_in_description');
  await failsWith(c => { c.seo.description += '\u0007'; }, 'dh_description_survives_upload');
  await failsWith(c => { c.assets.audio.model = 'piper:en_US-ryan-high'; }, 'dh_voice_public_domain');
  await failsWith(c => { c.script.beats[1].narration += ' Forty-two sailors vanished.'; }, 'dh_claims_map_to_source');
  await failsWith(c => { delete c.strategy.documentary; }, 'dh_footage_per_beat');
  await failsWith(c => { c.assets.finalVideo.path = path.join(dir, 'missing.mp4'); }, 'dh_video_format');
  await failsWith(c => { c.assets.video.provenance[0].license = ''; }, 'media_provenance');
  await failsWith(c => { c.assets.video.scenePlan[0].duration = 20; }, 'dh_image_hold_limit');
  await failsWith(c => { c.strategy.documentary.story.plan.beats[1].images[0].dhash = c.strategy.documentary.story.plan.beats[0].images[0].dhash; }, 'dh_no_near_duplicate_images');
  await failsWith(c => { c.seo.description = 'Credits removed. '.repeat(5); }, 'media_attribution');

  // ---- the orchestrator ----
  const notices = [];
  const fiction = [];
  const forbidden = name => async () => { fiction.push(name); throw new Error(`the old pipeline must not run: ${name}`); };
  const generator = { commands: [], async generateLocalCommandTTS(text, out, command) { this.commands.push(command); await tone(text, out); return out; } };
  const makeAgent = ({ llm, schedule = async p => ({ publishTime: '2026-10-08T10:00:00.000Z', productionId: p.id }), readiness = { assertReady: async () => ({}) } }) => {
    const agent = Object.create(YouTubeAutomationAgent.prototype);
    Object.assign(agent, {
      logger: silent, db, activeJobs: new Map(), jobAbortControllers: new Map(), setupRequired: false, readiness,
      operator: Object.assign(new OperatorService(db), { notify: async n => { notices.push(n); return 'n'; } }),
      provenance: new ProvenanceService(db), discoverability: null, storyPool: new StoryPool(db),
      autonomous: { start: forbidden('autonomous.start') },
      agents: {
        strategy: { aiTextService: llm, generateContentStrategy: forbidden('strategy.generateContentStrategy'), researchAndPlanChannel: forbidden('strategy.researchAndPlanChannel') },
        scriptWriter: { generateScript: forbidden('scriptWriter.generateScript') },
        thumbnailDesigner: { generateThumbnail: forbidden('thumbnailDesigner.generateThumbnail') },
        seoOptimizer: { optimize: forbidden('seoOptimizer.optimize') },
        production: { aiVideoGenerator: generator, processContent: forbidden('production.processContent') },
        publishing: { scheduleContent: async p => { agent.scheduled.push(p); return schedule(p); } }
      },
      scheduled: []
    });
    return agent;
  };

  // flag OFF: the old path is what runs; the pool and the documentary code are not touched
  {
    process.env.DARK_HISTORY_LIVE = 'false';
    await addToPool(pool, await makeStory(dir, 'Untouched Story'));
    const calls = [];
    const agent = makeAgent({ llm: makeLlm() });
    agent.startGenerationJob = async input => { calls.push(['startGenerationJob', input.source]); return { id: 'old-job' }; };
    const job = await agent.queueScheduledContent({ source: 'scheduler' });
    assert.strictEqual(job.id, 'old-job');
    assert.deepStrictEqual(calls, [['startGenerationJob', 'scheduler']], 'flag off: the old generation job starts');
    assert.strictEqual(await pool.readyCount(), 1, 'flag off: the pool is untouched');
    assert.strictEqual((await db.getAllRows("SELECT id FROM generation_jobs WHERE style = 'documentary'")).length, 0);
    assert.deepStrictEqual(fiction, []);
    // the old pipeline entry point does not know the documentary one
    const refusing = Object.create(YouTubeAutomationAgent.prototype);
    refusing.db = db;
    assert.ok(typeof refusing.generateDocumentaryContent === 'function' && typeof refusing.startDocumentaryJob === 'function');
    await db.executeQuery("UPDATE story_pool SET status = 'rejected' WHERE title = 'Untouched Story'");
  }

  // flag ON: success
  {
    process.env.DARK_HISTORY_LIVE = 'true';
    await addToPool(pool, await makeStory(dir, 'Live Story'));
    const llm = makeLlm();
    const agent = makeAgent({ llm });
    const job = await agent.queueScheduledContent({ source: 'scheduler' });
    assert.strictEqual(isDocumentary(await db.getGenerationJob(job.id)), true, 'the job is marked as a Dark History job before it works');
    const done = await agent.waitForGenerationJob(job.id);
    assert.strictEqual(done.status, 'completed', done.error);
    assert.strictEqual(done.details.reviewStatus, 'approved');
    assert.strictEqual(done.topic, 'Live Story', 'the story title is the job topic (the duplicate check reads it)');
    assert.ok(await db.getSetting('last_content_generation'), 'a finished Short moves the pacing clock');
    assert.deepStrictEqual(fiction, [], 'nothing of the old pipeline ran');
    assert.strictEqual(agent.scheduled.length, 1);
    assert.strictEqual(agent.scheduled[0].strategy.pipeline, 'dark-history');
    assert.match(generator.commands[generator.commands.length - 1], /-m en_US-ljspeech-high /, 'the public-domain voice narrated, not the configured ryan voice');
    assert.ok(agent.scheduled[0].seo.description.includes(agent.scheduled[0].strategy.documentary.story.attribution), 'attribution is in the description unchanged');
    const bundle = await db.getProductionBundle(done.production_id);
    assert.strictEqual(bundle.review_status, 'approved');
    assert.strictEqual(bundle.provenance.status, 'verified');
    assert.ok(bundle.qualityChecks.every(check => check.passed || !check.blocking));
    assert.strictEqual((await db.getRow("SELECT status FROM story_pool WHERE title = 'Live Story'")).status, 'used');
    assert.ok(!notices.some(n => n.type === 'documentary_failure'));
    // the stored production passes the same checks again right before an upload (publisher verifies the bundle from the database)
    const again = await new OperatorService(db).runQualityChecks(bundle, {}, { excludeProductionId: bundle.id });
    assert.strictEqual(again.passed, true, JSON.stringify(again.checks.filter(c => !c.passed)));
    // manual / API generation follows the switch (no way to make an old-style Short while live)
    await addToPool(pool, await makeStory(dir, 'Manual Story'));
    const manual = await agent.startGenerationJob({ source: 'manual' });
    assert.strictEqual((await agent.waitForGenerationJob(manual.id)).status, 'completed');
    assert.deepStrictEqual(fiction, []);
  }

  // flag ON: every failure keeps the gate, returns the story, alerts with the cause, never falls back
  {
    process.env.DARK_HISTORY_LIVE = 'true';
    notices.length = 0;
    const before = await db.getSetting('last_content_generation');
    await addToPool(pool, await makeStory(dir, 'Failing Story'));
    const agent = makeAgent({ llm: makeLlm({ writer: 'garbage' }) });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const job = await agent.queueScheduledContent({ source: 'scheduler' });
      const done = await agent.waitForGenerationJob(job.id);
      assert.strictEqual(done.status, 'failed');
      assert.match(done.error, /no title\/beats|JSON/i, 'the job keeps the real cause');
      const row = await db.getRow("SELECT status, attempts FROM story_pool WHERE title = 'Failing Story'");
      assert.deepStrictEqual([row.status, row.attempts], [attempt < 3 ? 'ready' : 'rejected', attempt]);
      assert.strictEqual(await db.getSetting('last_content_generation'), before, 'a failure does not move the pacing clock');
    }
    assert.deepStrictEqual(fiction, [], 'a failed Dark History production never falls back to the old pipeline');
    assert.strictEqual(agent.scheduled.length, 0, 'nothing weaker was scheduled');
    const alerts = notices.filter(n => n.type === 'documentary_failure');
    assert.ok(alerts.length >= 3 && alerts.every(n => n.level === 'error' && /Failing Story/.test(n.message) && /no other kind of Short/.test(n.message) && n.dedupeKey));
    assert.ok(alerts[alerts.length - 1].title.includes('rejected after repeated failures'));
    assert.ok(!notices.some(n => n.type === 'generation_failure'), 'one alert per failure, not two');

    // a Short that passes the gates but gets no publish slot is a failure too: story back, owner told, nothing published
    notices.length = 0;
    await addToPool(pool, await makeStory(dir, 'Unscheduled Story'));
    const unscheduled = makeAgent({ llm: makeLlm(), schedule: async () => null });
    const job = await unscheduled.queueScheduledContent({ source: 'scheduler' });
    const done = await unscheduled.waitForGenerationJob(job.id);
    assert.strictEqual(done.status, 'failed');
    assert.match(done.error, /no publish slot/);
    assert.strictEqual((await db.getRow("SELECT status, attempts FROM story_pool WHERE title = 'Unscheduled Story'")).status, 'ready');
    assert.ok(notices.some(n => n.type === 'documentary_failure' && /no publish slot/.test(n.message)));
    await db.executeQuery("UPDATE story_pool SET status = 'rejected' WHERE title = 'Unscheduled Story'");

    // a gate that fails (a picture that no longer matches its recorded hash) rejects the Short, nothing is scheduled
    notices.length = 0;
    const tampered = await makeStory(dir, 'Tampered Story');
    const tamperedId = await addToPool(pool, tampered);
    const row = await db.getRow('SELECT plan FROM story_pool WHERE id = ?', [tamperedId]);
    const plan = JSON.parse(row.plan);
    plan.beats[0].images[0].sha256 = 'f'.repeat(64); // the picture no longer matches the hash recorded when it was licensed
    await db.executeQuery('UPDATE story_pool SET plan = ? WHERE id = ?', [JSON.stringify(plan), tamperedId]);
    const gated = makeAgent({ llm: makeLlm() });
    const gatedJob = await gated.queueScheduledContent({ source: 'scheduler' });
    const gatedDone = await gated.waitForGenerationJob(gatedJob.id);
    assert.strictEqual(gatedDone.status, 'failed');
    assert.match(gatedDone.error, /image_files_intact|documentary gate failed/);
    assert.strictEqual(gated.scheduled.length, 0);
    assert.strictEqual((await db.getRow('SELECT status FROM story_pool WHERE id = ?', [tamperedId])).status, 'ready');
    await db.executeQuery("UPDATE story_pool SET status = 'rejected' WHERE id = ?", [tamperedId]);

    // a beat whose picture repeats an earlier one falls (never shown twice); the Short is made from the rest
    notices.length = 0;
    await addToPool(pool, await makeStory(dir, 'Repeat Story', { duplicates: 1 }));
    const repeatAgent = makeAgent({ llm: makeLlm() });
    const repeatJob = await repeatAgent.queueScheduledContent({ source: 'scheduler' });
    const repeatDone = await repeatAgent.waitForGenerationJob(repeatJob.id);
    assert.strictEqual(repeatDone.status, 'completed', repeatDone.error);
    assert.strictEqual(repeatAgent.scheduled[0].strategy.documentary.story.plan.beats.length, 4, 'the beat with the repeated picture is gone');
    assert.ok(!JSON.stringify(repeatAgent.scheduled[0].seo.description).includes('photo 5'), 'its picture is not credited either');
    // too few distinct pictures: the story is rejected at once (no retries), the owner is told why
    notices.length = 0;
    await addToPool(pool, await makeStory(dir, 'Twin Story', { duplicates: 1, base: 3 }));
    await db.executeQuery("UPDATE story_pool SET status = 'rejected' WHERE status = 'ready' AND title != 'Twin Story'");
    const twinAgent = makeAgent({ llm: makeLlm() });
    const twinJob = await twinAgent.queueScheduledContent({ source: 'scheduler' });
    const twinDone = await twinAgent.waitForGenerationJob(twinJob.id);
    assert.strictEqual(twinDone.status, 'failed');
    assert.match(twinDone.error, /only 3 distinct pictures remain/);
    assert.strictEqual((await db.getRow("SELECT status FROM story_pool WHERE title = 'Twin Story'")).status, 'rejected', 'a story that can never be made is rejected at once');
    assert.ok(notices.some(n => n.type === 'documentary_failure' && n.title.includes('rejected')));

    // footage fit at production: a story made before the check existed is checked when it is claimed (one vision request); a picture that does not
    // show what its passage describes drops its beat, and fewer than 4 beats left rejects the story at once
    notices.length = 0;
    await addToPool(pool, await makeStory(dir, 'Passage Story'));
    const footageLlm = makeLlm({ vision: 'footage' });
    const footageAgent = makeAgent({ llm: footageLlm });
    const footageJob = await footageAgent.queueScheduledContent({ source: 'scheduler' });
    const footageDone = await footageAgent.waitForGenerationJob(footageJob.id);
    assert.strictEqual(footageDone.status, 'failed');
    assert.match(footageDone.error, /only 3 beats have a picture that shows what its passage describes/);
    assert.strictEqual(footageLlm.footageChecks, 1, 'checked once, when claimed');
    assert.strictEqual((await db.getRow("SELECT status FROM story_pool WHERE title = 'Passage Story'")).status, 'rejected', 'a story that cannot be made is rejected at once');
    assert.strictEqual(footageAgent.scheduled.length, 0);
    assert.ok(notices.some(n => n.type === 'documentary_failure' && /3 beats have a picture/.test(n.message)));
    // a story that already carries its verdict (checked at the pool entrance) is not checked again, and its beats are produced as stored
    notices.length = 0;
    const carried = await makeStory(dir, 'Carried Story');
    const carriedId = await addToPool(pool, carried);
    const carriedPlan = JSON.parse((await db.getRow('SELECT plan FROM story_pool WHERE id = ?', [carriedId])).plan);
    carriedPlan.fit = { checkedAt: new Date().toISOString(), pictures: 4, dropped: [] };
    await db.executeQuery('UPDATE story_pool SET plan = ? WHERE id = ?', [JSON.stringify(carriedPlan), carriedId]);
    const carriedLlm = makeLlm();
    const carriedAgent = makeAgent({ llm: carriedLlm });
    const carriedJob = await carriedAgent.queueScheduledContent({ source: 'scheduler' });
    assert.strictEqual((await carriedAgent.waitForGenerationJob(carriedJob.id)).status, 'completed');
    assert.ok(!carriedLlm.footageChecks, 'a story with a verdict costs no footage request');

    // pictures that do not fit their narration: no Short (the writer cannot fix it here), the owner is told; the pictures were really sent
    notices.length = 0;
    await addToPool(pool, await makeStory(dir, 'Fit Story'));
    const mismatchLlm = makeLlm({ vision: 'mismatch' });
    const fitting = makeAgent({ llm: mismatchLlm });
    const fitJob = await fitting.queueScheduledContent({ source: 'scheduler' });
    const fitDone = await fitting.waitForGenerationJob(fitJob.id);
    assert.strictEqual(fitDone.status, 'failed');
    assert.match(fitDone.error, /picture does not fit/);
    const sentParts = mismatchLlm.lastVision.contents[0].parts;
    assert.strictEqual(sentParts.filter(part => part.inlineData && part.inlineData.mimeType === 'image/jpeg' && part.inlineData.data.length > 100).length, 4, 'the four real pictures were sent to the vision model');
    assert.strictEqual((await db.getRow("SELECT attempts FROM story_pool WHERE title = 'Fit Story'")).attempts, 1);
    assert.ok(notices.some(n => n.type === 'documentary_failure' && /picture does not fit/.test(n.message)));
    // no vision model: the pictures cannot be checked, nothing is made, and the story is not burned
    notices.length = 0;
    const blind = makeAgent({ llm: makeLlm({ vision: 'none' }) });
    const blindJob = await blind.queueScheduledContent({ source: 'scheduler' });
    const blindDone = await blind.waitForGenerationJob(blindJob.id);
    assert.strictEqual(blindDone.status, 'failed');
    assert.match(blindDone.error, /no vision model is available/);
    assert.strictEqual((await db.getRow("SELECT attempts FROM story_pool WHERE title = 'Fit Story'")).attempts, 1, 'a missing vision model is not the story\'s fault');
    assert.strictEqual(blind.scheduled.length, 0);
    await db.executeQuery("UPDATE story_pool SET status = 'rejected' WHERE title = 'Fit Story'");

    // empty pool: no story, no fiction, an alert with the cause
    notices.length = 0;
    const empty = makeAgent({ llm: makeLlm() });
    const emptyJob = await empty.queueScheduledContent({ source: 'scheduler' });
    const emptyDone = await empty.waitForGenerationJob(emptyJob.id);
    assert.strictEqual(emptyDone.status, 'failed');
    assert.match(emptyDone.error, /story pool is empty/);
    assert.ok(notices.some(n => n.type === 'documentary_failure' && /story pool is empty/.test(n.message)));
    assert.deepStrictEqual(fiction, []);

    // a voice that is not public domain stops the job BEFORE a story is claimed (a configuration problem must not burn stories)
    notices.length = 0;
    await addToPool(pool, await makeStory(dir, 'Voice Story'));
    process.env.DARK_HISTORY_VOICE = 'en_US-ryan-high';
    const voiced = makeAgent({ llm: makeLlm() });
    const voicedJob = await voiced.queueScheduledContent({ source: 'scheduler' });
    const voicedDone = await voiced.waitForGenerationJob(voicedJob.id);
    assert.strictEqual(voicedDone.status, 'failed');
    assert.match(voicedDone.error, /not an approved public-domain voice/);
    assert.strictEqual((await db.getRow("SELECT status, attempts FROM story_pool WHERE title = 'Voice Story'")).status, 'ready');
    assert.strictEqual((await db.getRow("SELECT attempts FROM story_pool WHERE title = 'Voice Story'")).attempts, 0);
    delete process.env.DARK_HISTORY_VOICE;
    await db.executeQuery("UPDATE story_pool SET status = 'rejected' WHERE title = 'Voice Story'");
  }

  // flag ON: a restart or a resume never hands a documentary job to the old pipeline
  {
    process.env.DARK_HISTORY_LIVE = 'true';
    await addToPool(pool, await makeStory(dir, 'Restart Story'));
    const claimedRestart = await pool.claimNext();
    const stuck = await db.createGenerationJob({ topic: null, style: 'documentary', length: 'short', source: 'scheduler' });
    await db.updateGenerationJob(stuck.id, { details: { pipeline: 'dark-history', storyId: claimedRestart.id } });
    await db.markInterruptedJobs();
    assert.strictEqual((await db.getGenerationJob(stuck.id)).status, 'interrupted');
    const agent = makeAgent({ llm: makeLlm() });
    await agent.releaseInterruptedDocumentaryJobs();
    const closed = await db.getGenerationJob(stuck.id);
    assert.strictEqual(closed.status, 'failed');
    assert.match(closed.error, /story went back to the pool/);
    assert.strictEqual((await db.getRow('SELECT status, attempts FROM story_pool WHERE id = ?', [claimedRestart.id])).attempts, 0, 'a restart is not the story\'s fault');
    assert.strictEqual((await db.getRow('SELECT status FROM story_pool WHERE id = ?', [claimedRestart.id])).status, 'ready');
    await assert.rejects(() => agent.resumeGenerationJob(stuck.id), error => error.status === 409 && /Dark History job is not resumed/.test(error.message));
    assert.deepStrictEqual(fiction, []);
    assert.strictEqual(await agent.resumeInterruptedAutonomousWork('startup'), null, 'while live nothing of the old planner is resumed');
    await db.executeQuery("UPDATE story_pool SET status = 'rejected' WHERE status = 'ready'");
  }

  // ---- cadence: the pool limits what the scheduler asks for (and flag off ignores the pool) ----
  {
    await db.executeQuery("UPDATE story_pool SET status = 'rejected'");
    const alreadyDone = (await db.getRow("SELECT COUNT(*) AS n FROM generation_jobs WHERE status = 'completed'")).n; // the two Shorts made above count too
    for (let i = 0; i < 7 - alreadyDone; i += 1) {
      const job = await db.createGenerationJob({ topic: `done ${i}`, style: 'documentary', length: 'short', source: 'scheduler' });
      await db.updateGenerationJob(job.id, { status: 'completed', details: { reviewStatus: 'approved' } });
    }
    const stored = {};
    const dbFor = () => Object.assign(Object.create(db), {
      getChannelStrategy: async () => ({ status: 'active', cadence_per_week: 21 }),
      getSetting: async key => (key in stored ? stored[key] : null)
    });
    const scheduler = new DailyAutomation({}, dbFor(), {});
    scheduler.logger = silent;
    scheduler.storyPool = pool;
    stored.last_content_generation = new Date(Date.now() - 30 * 3600000).toISOString();

    process.env.DARK_HISTORY_LIVE = 'false';
    assert.strictEqual(await scheduler.shouldGenerateContentToday(), true, 'flag off: 7 of 21 Shorts done, the pool does not matter');

    process.env.DARK_HISTORY_LIVE = 'true';
    assert.strictEqual(await scheduler.shouldGenerateContentToday(), false);
    assert.match(scheduler.lastSkipReason, /story pool is empty/);
    for (let i = 0; i < 14; i += 1) await pool.add({ title: `Stock ${i}`, status: 'ready', plan: { beats: [] }, attribution: 'x' });
    assert.strictEqual(await scheduler.shouldGenerateContentToday(), false, '14 stories last 14 days at 7 a week: the 7 already made use the weekly allowance');
    assert.match(scheduler.lastSkipReason, /weekly target reached \(7\/7/);
    for (let i = 14; i < 42; i += 1) await pool.add({ title: `Stock ${i}`, status: 'ready', plan: { beats: [] }, attribution: 'x' });
    assert.strictEqual(await scheduler.shouldGenerateContentToday(), true, '42 stories: the full 21 a week is allowed');
  }

  // ---- the stall watchdog expects the pool-limited pace while live, and leaves an empty pool to its own alert ----
  {
    await db.executeQuery("UPDATE story_pool SET status = 'rejected'");
    const alerts = [];
    const longAgo = new Date(Date.now() - 40 * 3600000).toISOString();
    const dbStall = Object.assign(Object.create(db), {
      getChannelStrategy: async () => ({ status: 'active', cadence_per_week: 21 }),
      getSetting: async key => (key === 'last_content_generation' ? longAgo : null),
      getAllRows: async sql => (/generation_jobs WHERE status IN/.test(sql) ? [] : db.getAllRows(sql))
    });
    const stall = new DailyAutomation({}, dbStall, { notify: async n => alerts.push(n) });
    stall.logger = silent;
    stall.storyPool = pool;
    process.env.DARK_HISTORY_LIVE = 'false';
    assert.ok(await stall.checkProductionStall(), 'flag off: 40 h without a Short at 21 a week is a stall');
    process.env.DARK_HISTORY_LIVE = 'true';
    alerts.length = 0;
    assert.strictEqual(await stall.checkProductionStall(), null, 'live with an empty pool: the pool alert speaks, not the stall alert');
    assert.strictEqual(alerts.length, 0);
    for (let i = 0; i < 3; i += 1) await pool.add({ title: `Slow ${i}`, status: 'ready', plan: { beats: [] }, attribution: 'x' });
    const slow = await stall.checkProductionStall();
    assert.ok(slow === null || slow.limitHours >= 100, '3 stories last 14 days at 1.5 a week: a 40 h gap is no stall (limit ' + (slow && slow.limitHours) + ' h)');
    await db.executeQuery("UPDATE story_pool SET status = 'rejected'");
  }

  // ---- readiness: with the switch on the checks prove the documentary path, not the old image generator and cloud voice ----
  {
    const seen = [];
    const probes = {
      text: async () => ({ message: 'ok' }), image: async () => { seen.push('image'); return { message: 'ok' }; }, documentary: async () => { seen.push('documentary'); return { message: 'ok' }; },
      videoProvider: async () => ({ message: 'ok' }), narration: async () => { seen.push('narration'); return { message: 'ok' }; },
      videoAssembly: async () => ({ message: 'ok' }), youtube: async () => ({ message: 'ok' }), metadata: async () => ({ message: 'ok' })
    };
    const readiness = new ProductionReadinessService(db, { credentials: {} }, { probes, transientRetryDelayMs: 0 });
    process.env.DARK_HISTORY_LIVE = 'false';
    const off = await readiness.run();
    assert.ok(seen.includes('image') && !seen.includes('documentary'));
    assert.strictEqual(off.checks.find(c => c.id === 'image_provider').label, 'Dark Stickman image provider');
    seen.length = 0;
    process.env.DARK_HISTORY_LIVE = 'true';
    const on = await readiness.run();
    assert.ok(seen.includes('documentary') && !seen.includes('image'));
    assert.match(on.checks.find(c => c.id === 'image_provider').label, /Documentary render/);
    assert.ok(on.checks.find(c => c.id === 'image_provider').blocking && on.checks.find(c => c.id === 'voice_narration').blocking);
    assert.strictEqual(on.status, 'passed');
  }

  delete process.env.DARK_HISTORY_LIVE;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_error) { /* the SQLite file is still open (Windows); the OS temp folder is cleaned later */ }
  console.log('dark-history live tests passed');
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
