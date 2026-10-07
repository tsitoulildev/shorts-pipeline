/**
 * Offline end-to-end dry run for the Horror Stickman Shorts pipeline.
 *
 * Drives the REAL agents (strategy -> script -> thumbnail -> SEO -> production ->
 * quality gate -> publish queue) with every external credential removed, so the
 * deterministic fallbacks and the built-in Dark Stickman renderer must carry the
 * whole Short. Only text-to-speech is replaced by an audible local tone, because
 * no free offline voice is bundled; the report labels it as a fixture.
 *
 * It also proves crash recovery: the first attempt is interrupted after the
 * script stage, and the rerun of the same job must reuse the strategy and script
 * checkpoints instead of regenerating them.
 *
 * Publishing is proven without touching YouTube: first the kill switch must block
 * the upload, then the real publish path (pre-upload QA -> upload -> verify video
 * ID -> record) runs against an in-process fake YouTube client. No network call
 * to YouTube is possible: the agent never initializes the real API client.
 */
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SECRET_ENV = /(_API_KEY|_TOKEN|_SECRET|_PASSWORD|CLIENT_ID|REFRESH|CREDENTIALS)$/i;
for (const key of Object.keys(process.env)) {
  if (SECRET_ENV.test(key)) delete process.env[key];
}
process.env.AUTONOMOUS_MODE = 'true';
process.env.YOUTUBE_UPLOAD_ENABLED = 'false';
process.env.FREE_MEDIA_ONLY = 'true';
process.env.LOCAL_STICKMAN_RENDERER = 'true';
process.env.GENERATION_RETRY_BASE_MS = '0';
delete process.env.DEFAULT_PRIVACY_STATUS;

const { Database } = require('../database/db');
const { YouTubeAutomationAgent } = require('../index');
const { OperatorService } = require('../utils/operator-service');
const { ProvenanceService } = require('../utils/provenance-service');
const { ContentStrategyAgent } = require('../agents/content-strategy-agent');
const { ScriptWriterAgent } = require('../agents/script-writer-agent');
const { ThumbnailDesignerAgent } = require('../agents/thumbnail-designer-agent');
const { SEOOptimizerAgent } = require('../agents/seo-optimizer-agent');
const { ProductionManagementAgent } = require('../agents/production-management-agent');
const { PublishingSchedulingAgent } = require('../agents/publishing-scheduling-agent');
const { runFFmpeg, getMediaDuration } = require('../utils/ffmpeg');
const { measureLoudness } = require('../utils/audio-mix');

const DATA_ROOT = path.join(__dirname, '..', 'data');
// ANIMATED_SCENES=true runs the same Short with moving beats; it gets its own report file.
const ANIMATED = /^(1|true|yes)$/i.test(String(process.env.ANIMATED_SCENES || '').trim());
const REPORT_PATH = path.join(__dirname, '..', 'artifacts', `horror-short-dry-run-report${ANIMATED ? '-animated' : ''}.json`);

async function listFiles(root) {
  const found = new Set();
  async function walk(dir) {
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (_error) { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else found.add(full);
    }
  }
  await walk(root);
  return found;
}

async function probeStreams(filePath) {
  let stderr = '';
  try {
    await runFFmpeg(['-hide_banner', '-i', filePath], { timeoutMs: 60000 });
  } catch (error) {
    stderr = String(error.stderr || '');
  }
  const video = stderr.match(/Stream #\S+.*Video: ([^,\s]+).*?(\d{2,5})x(\d{2,5})/);
  return {
    videoCodec: video ? video[1] : null,
    width: video ? Number(video[2]) : null,
    height: video ? Number(video[3]) : null,
    hasAudio: /Stream #\S+.*Audio:/.test(stderr)
  };
}

async function fileHash(filePath) {
  return crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

async function main() {
  const startedAt = new Date().toISOString();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'horror-short-dry-run-'));
  const preexisting = await listFiles(DATA_ROOT);
  const db = new Database();
  db.dbPath = path.join(tempRoot, 'dry-run.db');

  const checks = [];
  const diagnostics = {};
  const check = (id, passed, detail) => checks.push({ id, passed: Boolean(passed), detail });
  const calls = { strategy: 0, script: 0, uploads: 0, schedule: 0 };
  let report = null;

  try {
    await db.initialize();
    await db.setSetting('approval_required', 'false');

    const strategy = new ContentStrategyAgent(db, {});
    strategy.historicalPerformance = [];
    strategy.trendingTopics = [];
    strategy.competitorData = [];

    const scriptWriter = new ScriptWriterAgent(db, {});
    await scriptWriter.initialize();

    const thumbnail = new ThumbnailDesignerAgent(db, {});
    await thumbnail.initialize();

    const seo = new SEOOptimizerAgent(db, {});
    await seo.initialize();

    const production = new ProductionManagementAgent(db, {});
    diagnostics.production = production;
    await production.initialize();
    production.sceneRepair.dataRoot = tempRoot;

    // The only fixture: an audible tone sized like real narration for the script.
    production.aiVideoGenerator.generateTTSAudio = async (text, outputPath) => {
      const words = String(text || '').split(/\s+/).filter(Boolean).length;
      const seconds = Math.max(20, Math.min(43, words / 2.7));
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await runFFmpeg([
        '-y', '-f', 'lavfi', '-i', 'sine=frequency=170:sample_rate=24000',
        '-t', seconds.toFixed(2), '-acodec', 'libmp3lame', '-q:a', '4', outputPath
      ], { timeoutMs: 120000 });
      production.aiVideoGenerator.lastNarrationResult = {
        provider: 'dry-run-tone-fixture',
        model: 'local-sine',
        generatedAt: new Date().toISOString(),
        cost: { billed: false }
      };
      return outputPath;
    };

    const publishing = new PublishingSchedulingAgent(db, {});
    const scheduleContent = publishing.scheduleContent.bind(publishing);
    publishing.scheduleContent = async productionData => {
      calls.schedule += 1;
      return scheduleContent(productionData);
    };
    const fakeVideos = new Map();
    publishing.youtube = {
      videos: {
        insert: async () => {
          calls.uploads += 1;
          const id = `dryrun-video-${calls.uploads}`;
          fakeVideos.set(id, { id, status: { uploadStatus: 'uploaded', privacyStatus: 'private' } });
          return { data: { id } };
        },
        list: async ({ id }) => {
          calls.verifications = (calls.verifications || 0) + 1;
          return { data: { items: fakeVideos.has(id) ? [fakeVideos.get(id)] : [] } };
        }
      },
      thumbnails: { set: async () => ({ data: {} }) },
      captions: { insert: async () => ({ data: {} }) }
    };

    const generateStrategy = strategy.generateContentStrategy.bind(strategy);
    const generateScript = scriptWriter.generateScript.bind(scriptWriter);
    const generateThumbnail = thumbnail.generateThumbnail.bind(thumbnail);
    let crashInjected = false;

    const agent = new YouTubeAutomationAgent();
    publishing.preUploadVerifier = bundle => agent.verifyBeforeUpload(bundle);
    agent.db = db;
    agent.operator = new OperatorService(db);
    agent.provenance = new ProvenanceService(db);
    agent.discoverability = null;
    agent.setupRequired = false;
    agent.agents = {
      strategy: { generateContentStrategy: async topic => { calls.strategy += 1; return generateStrategy(topic); } },
      scriptWriter: { generateScript: async plan => { calls.script += 1; return generateScript(plan); } },
      thumbnailDesigner: {
        generateThumbnail: async script => {
          if (!crashInjected) {
            crashInjected = true;
            const crash = new Error('Injected process crash after the script checkpoint');
            crash.code = 'DRY_RUN_INJECTED_CRASH';
            throw crash;
          }
          return generateThumbnail(script);
        }
      },
      seoOptimizer: seo,
      production,
      publishing
    };

    // Attempt 1: autonomous topic selection, interrupted after the script stage.
    const job = await db.createGenerationJob({ topic: null, style: 'story', length: 'short', source: 'dry-run' });
    let firstError = null;
    try {
      await agent.generateContent(null, 'story', 'short', { jobId: job.id });
    } catch (error) {
      firstError = error;
    }
    const checkpointStatus = async stage => (await db.getGenerationCheckpoint(job.id, stage))?.status || 'missing';
    check('crash_interrupted_run', firstError?.code === 'DRY_RUN_INJECTED_CRASH',
      firstError ? firstError.message : 'first attempt did not stop at the injected crash');
    check('checkpoints_before_crash',
      await checkpointStatus('strategy') === 'completed' && await checkpointStatus('script') === 'completed',
      `strategy=${await checkpointStatus('strategy')} script=${await checkpointStatus('script')} thumbnail=${await checkpointStatus('thumbnail')}`);

    // Attempt 2: same job resumes and must not regenerate completed stages.
    const before = { strategy: calls.strategy, script: calls.script };
    const result = await agent.generateContent(null, 'story', 'short', { jobId: job.id });
    const resumedJob = await db.getGenerationJob(job.id);
    const reused = resumedJob?.details?.reusedStages || [];
    check('resume_reused_checkpoints',
      calls.strategy === before.strategy && calls.script === before.script &&
        reused.includes('strategy') && reused.includes('script'),
      `regenerated strategy ${calls.strategy - before.strategy}x, script ${calls.script - before.script}x; reused=[${reused.join(', ')}]`);

    check('review_approved', result.reviewStatus === 'approved',
      `reviewStatus=${result.reviewStatus} qualityScore=${result.qualityScore}`);

    const bundle = await db.getProductionBundle(result.contentId);
    if (!bundle) throw new Error('Production bundle was not persisted');
    const strategyArtifact = bundle.strategy || {};
    const script = bundle.script || {};
    check('horror_strategy', strategyArtifact.fictional === true && Boolean(strategyArtifact.topic),
      `topic="${strategyArtifact.topic}" source=${strategyArtifact.generationSource || 'unknown'}`);
    const spoken = Number(script.metadata?.spokenWordCount || 0);
    check('script_word_contract', spoken >= 90 && spoken <= 140, `${spoken} spoken words`);

    const finalPath = bundle.assets?.finalVideo?.path;
    const streams = finalPath ? await probeStreams(finalPath) : {};
    const finalDuration = finalPath ? await getMediaDuration(finalPath).catch(() => null) : null;
    check('final_video_vertical', streams.width === 1080 && streams.height === 1920,
      `${streams.width}x${streams.height} ${streams.videoCodec || 'no video stream'}`);
    check('final_video_has_audio', streams.hasAudio === true, streams.hasAudio ? 'audio stream present' : 'no audio stream');
    check('final_video_runtime', finalDuration >= 20 && finalDuration <= 45,
      `${Number(finalDuration || 0).toFixed(2)}s`);
    const mix = bundle.assets?.audio?.mix || {};
    const finalLoudness = finalPath ? await measureLoudness(finalPath).catch(() => null) : null;
    check('audio_mixed',
      mix.status === 'ready' && mix.ambient?.present === true && (mix.stingers || []).length === 2 && Boolean(finalLoudness) &&
        finalLoudness.integrated >= -19 && finalLoudness.integrated <= -12 && finalLoudness.truePeak <= -0.5,
      finalLoudness
        ? `${mix.palette || 'no mix'} bed, ${(mix.stingers || []).map(item => `${item.kind}@${item.at}s`).join(' + ')}; final ${finalLoudness.integrated.toFixed(1)} LUFS / ${finalLoudness.truePeak.toFixed(1)} dBTP`
        : 'final loudness could not be measured');
    check('captions_burned', bundle.assets?.finalVideo?.captionsBurnedIn === true, 'captionsBurnedIn flag');

    const scenePlan = bundle.assets?.video?.scenePlan || [];
    const scenePaths = scenePlan.map(scene => scene.assetPath).filter(Boolean);
    const sceneHashes = new Set();
    for (const scenePath of scenePaths) sceneHashes.add(await fileHash(scenePath));
    check('scene_visuals_distinct',
      scenePlan.length >= 4 && scenePlan.length <= 7 && sceneHashes.size === scenePlan.length,
      `${scenePlan.length} beats, ${sceneHashes.size} visually distinct images`);
    const timeline = production.aiVideoGenerator.lastVideoResult?.timeline || [];
    const plannedTotal = scenePlan.reduce((sum, scene) => sum + Number(scene.duration || 0), 0);
    const timelineTotal = timeline.reduce((sum, item) => sum + Number(item.duration || 0), 0);
    const proportional = timeline.length === scenePlan.length && plannedTotal > 0 && timeline.every((item, index) =>
      Math.abs(item.duration / timelineTotal - Number(scenePlan[index].duration) / plannedTotal) < 0.02);
    const motionError = production.aiVideoGenerator.lastVideoResult?.motionError || null;
    check('visual_timeline_synced',
      proportional && timeline.every(item => item.motion) && timeline[0]?.motion === 'push-in-fast',
      `${timeline.length} beats: ${timeline.map(item => `${item.motion} ${Number(item.duration).toFixed(1)}s`).join(', ')}` +
        (motionError ? ` | motion error: ${motionError}` : ''));
    if (ANIMATED) {
      const animation = production.aiVideoGenerator.lastVideoResult?.animation || null;
      const { CHARACTER_HASH } = require('../utils/stickman-scene');
      const sameCharacter = (animation?.beats || []).every(beat => beat.animated && beat.characterHash === CHARACTER_HASH);
      check('animated_beats',
        Boolean(animation) && animation.totalBeats === scenePlan.length && animation.animatedBeats === scenePlan.length && sameCharacter,
        animation
          ? `${animation.animatedBeats}/${animation.totalBeats} beats animated in ${(animation.renderMs / 1000).toFixed(1)}s; ` +
            (animation.beats || []).map(beat => beat.animated ? `${beat.frames}f${beat.cutaway ? '+cut' : ''} ${beat.renderMs}ms` : `still (${beat.reason})`).join(', ')
          : 'no animation result recorded');
    }
    check('first_frame_hook', scenePlan[0]?.role === 'hook' &&
      bundle.assets?.thumbnail?.generatedWith === 'horror-first-frame',
      `scene0 role=${scenePlan[0]?.role} thumbnail=${bundle.assets?.thumbnail?.generatedWith}`);

    // Mirror runGenerationJob's completion bookkeeping so originality checks see this Short.
    await db.updateGenerationJob(job.id, { status: 'completed', productionId: result.contentId, completedAt: new Date().toISOString() });
    await db.executeQuery('UPDATE generation_jobs SET topic = COALESCE(topic, ?) WHERE id = ?', [result.topic || strategyArtifact.topic, job.id]);
    const jobRow = await db.getGenerationJob(job.id);
    check('job_topic_recorded', Boolean(jobRow?.topic), `job topic="${jobRow?.topic || ''}"`);

    // The exact verifier the publisher runs before every upload (own job excluded).
    const quality = await agent.verifyBeforeUpload(bundle);
    const failedGates = quality.checks.filter(item => !item.passed).map(item => `${item.id}: ${item.message}`);
    check('quality_gate', quality.passed, failedGates.length ? failedGates.join(' | ') : `score ${quality.score}`);
    const requiredGates = ['narration', 'narration_audible', 'narration_pacing', 'horror_scene_coverage',
      'horror_visual_diversity', 'horror_brand_style', 'runtime_target', 'av_sync', 'captions',
      'video_format', 'no_black_segments', 'duplicate_premise', 'audio_mix', 'caption_sync', 'hook_opening',
      'horror_character_consistency', 'horror_scene_variety', 'horror_visual_distance', 'creative_review'];
    const measuredIds = ['audio_mix', 'caption_sync', 'hook_opening', 'horror_character_consistency', 'horror_scene_variety', 'horror_visual_distance', 'creative_review'];
    const measured = measuredIds.map(id => quality.checks.find(item => item.id === id));
    check('media_measurements', measured.every(item => item && item.passed),
      measured.map((item, index) => `${measuredIds[index]}: ${item ? item.message : 'missing'}`).join(' | '));
    const missingGates = requiredGates.filter(id => !quality.checks.some(item => item.id === id));
    check('quality_gate_coverage', missingGates.length === 0,
      missingGates.length ? `missing gates: ${missingGates.join(', ')}` : `${requiredGates.length} horror gates evaluated`);

    const schedule = await db.getLatestScheduleEntry(bundle.id || result.contentId);
    check('queued_for_publish', calls.schedule >= 1 && schedule?.status === 'scheduled' && Boolean(result.scheduledFor),
      `schedule=${schedule?.status || 'none'} publishTime=${result.scheduledFor}`);
    check('queued_private_by_default', schedule?.metadata?.privacyStatus === 'private',
      `privacyStatus=${schedule?.metadata?.privacyStatus}`);
    // Approval path (dashboard): the Short's own completed job is not an earlier Short, so it must not
    // be reported as a duplicate of itself. (Regression: approval failed with "100% similar" to itself.)
    const approvalRun = await agent.operator.runQualityChecks(bundle, {});
    const approvalDup = approvalRun.checks.find(item => item.id === 'duplicate_premise');
    check('approval_not_self_duplicate', approvalDup && approvalDup.passed === true, approvalDup ? approvalDup.message : 'duplicate_premise gate missing');
    // Originality gate: an earlier COMPLETED Short (another production) with the same premise must block.
    const earlierJob = await db.createGenerationJob({ topic: null, style: 'story', length: 'short', source: 'dry-run' });
    await db.updateGenerationJob(earlierJob.id, { status: 'completed', productionId: 'prod_dry_run_earlier_short', completedAt: new Date().toISOString() });
    await db.executeQuery('UPDATE generation_jobs SET topic = ? WHERE id = ?', [jobRow.topic, earlierJob.id]);
    const selfCheck = await agent.operator.runQualityChecks(bundle, {});
    const dup = selfCheck.checks.find(item => item.id === 'duplicate_premise');
    check('duplicate_premise_detected', dup && dup.passed === false, dup ? dup.message : 'duplicate_premise gate missing');
    // The stand-in earlier Short must not influence the pre-upload checks that follow.
    await db.executeQuery("UPDATE generation_jobs SET status = 'failed' WHERE id = ?", [earlierJob.id]);

    // Kill switch: uploads disabled must block before any network call.
    let killError = null;
    try { await publishing.publishContent(result.contentId); } catch (error) { killError = error; }
    const afterKill = await db.getLatestScheduleEntry(result.contentId);
    check('kill_switch_blocks_upload', killError?.code === 'UPLOAD_DISABLED' && calls.uploads === 0 && afterKill?.status === 'scheduled',
      `code=${killError?.code} uploads=${calls.uploads} schedule=${afterKill?.status}`);

    // Authorized autonomous publish against the fake client: QA -> upload -> verify -> record.
    process.env.YOUTUBE_UPLOAD_ENABLED = 'true';
    db.getLatestReadinessRun = async () => ({ status: 'passed', completed_at: new Date().toISOString(), checks: [] });
    let publishError = null;
    try { await publishing.publishContent(result.contentId); } catch (error) { publishError = error; }
    process.env.YOUTUBE_UPLOAD_ENABLED = 'false';
    const finalEntry = await db.getLatestScheduleEntry(result.contentId);
    check('authorized_publish_verified',
      !publishError && finalEntry?.status === 'published' && calls.uploads === 1 && (calls.verifications || 0) >= 1 &&
        finalEntry?.metadata?.preUploadQa?.passed === true,
      publishError ? `${publishError.code || ''} ${publishError.message}`
        : `status=${finalEntry?.status} youtubeId=${finalEntry?.youtubeId || finalEntry?.youtube_id} uploads=${calls.uploads} verifications=${calls.verifications || 0} preUploadQa=${finalEntry?.metadata?.preUploadQa?.passed}`);

    const failed = checks.filter(item => !item.passed);
    report = {
      status: failed.length ? 'failure' : 'success',
      startedAt,
      completedAt: new Date().toISOString(),
      mode: ANIMATED ? 'offline-autonomous-no-upload-animated' : 'offline-autonomous-no-upload',
      narrationFixture: 'local sine tone (no offline TTS voice is bundled)',
      topic: strategyArtifact.topic || null,
      title: bundle.seo?.title || script.title || null,
      contentId: result.contentId,
      publicationState: result.publicationState || null,
      qualityScore: quality.score,
      failedChecks: failed.map(item => item.id),
      error: failed.length ? failed.map(item => `${item.id}: ${item.detail}`).join(' || ') : null,
      checks
    };
  } catch (error) {
    const video = diagnostics.production?.aiVideoGenerator?.lastVideoResult || {};
    const detail = [video.fallbackReason, video.motionError].filter(Boolean).join(' | ');
    report = {
      status: 'failure',
      startedAt,
      completedAt: new Date().toISOString(),
      mode: ANIMATED ? 'offline-autonomous-no-upload-animated' : 'offline-autonomous-no-upload',
      error: detail ? `${error.message} [video: ${detail}]` : error.message,
      checks
    };
  } finally {
    await db.close().catch(() => {});
    const after = await listFiles(DATA_ROOT);
    for (const filePath of after) {
      if (!preexisting.has(filePath)) await fs.unlink(filePath).catch(() => {});
    }
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }

  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (report.status !== 'success') process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
