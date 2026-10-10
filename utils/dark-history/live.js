// Dark History live path: pool story -> grounded script -> documentary Short -> a production record that the existing
// quality checks, review, schedule and publisher already understand. Everything here is behind DARK_HISTORY_LIVE
// (default false); with the flag off nothing in this file is called and the old path runs exactly as before.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeGroundedScript } = require('./grounded-writer');
const { produceDocumentaryShort } = require('./produce');
const { makeNarrator, narrationCommand } = require('./narration');
const { allowedCadencePerWeek } = require('./story-pool');
const { pruneNearDuplicates } = require('./dhash');
const { ensureFootageFit } = require('./footage-fit');
const { makeVisionJudge } = require('./image-fit');
const { attributionText } = require('./attribution');

const OUTPUT_DIR = path.join(__dirname, '..', '..', 'data', 'dark-history-output');
const OUTPUT_KEEP_DAYS = 14;
const PIPELINE = 'dark-history';

/** The switch. Only the exact word "true" turns the Dark History path on; anything else (unset, "1", "yes") leaves it off. */
const isLive = (env = process.env) => String(env.DARK_HISTORY_LIVE || '').trim().toLowerCase() === 'true';

/** A job or production made by this path (also read by the guards that keep it away from the old resume code). */
const isDocumentary = record => record?.pipeline === PIPELINE || record?.details?.pipeline === PIPELINE || record?.strategy?.pipeline === PIPELINE;

function failure(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  return Object.assign(error, extra);
}

const requiresAttribution = license => /^cc[- ]by/i.test(String(license || ''));

/**
 * The production record (the shape ProductionManagementAgent.processContent returns) for a finished documentary.
 * The old checks (provenance, media_provenance, visual_diversity, media_attribution, duplicate_premise, narration, captions...)
 * then run on it unchanged, and the documentary gate runs on strategy.documentary.
 */
function buildProductionData({ id = `prod_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`, story, script, result, narrationPath, voice, now = new Date() }) {
  const created = now.toISOString();
  const article = { url: story.article_url, title: story.plan.title };
  const scenes = result.render.segments.map((segment, i) => {
    const image = story.plan.beats[segment.beat - 1].images.find(item => item.file === segment.file);
    return {
      scene: {
        index: i + 1, beat: segment.beat, duration: Number(segment.seconds.toFixed(3)), motion: segment.motion, simulated: false,
        assetPath: path.join(story.plan.folder, segment.file), assetOrigin: 'documentary_real_image', rightsConfirmed: true
      },
      source: {
        sceneIndex: i + 1, provider: 'wikimedia-commons', sourcePage: image.descriptionUrl, sourceId: image.title, fileUrl: image.fileUrl,
        license: image.license, creator: image.author || null, attributionRequired: requiresAttribution(image.license), sha256: image.sha256
      }
    };
  });
  const audio = {
    path: narrationPath, duration: result.render.speechWindow.duration, measuredDuration: result.render.speechWindow.duration, format: 'mp3',
    generatedWith: 'local-tts', provider: 'local-tts', model: `piper:${voice}`, status: 'ready', quality: 'high', simulated: false, intentionalSilence: false,
    generatedAt: created, cost: { provider: 'local-tts', amount: 0, currency: null, invoiceRequired: false }, error: null
  };
  return {
    id,
    strategy: {
      pipeline: PIPELINE, topic: story.plan.title, contentType: 'Story', fictional: false, provenanceMode: 'documentary', angle: script.hook,
      researchSources: [{ url: article.url, title: `${article.title} (Wikipedia)`, publisher: 'Wikipedia', sourceType: 'article', status: 'verified', retrievalStatus: 'fetched', accessedAt: created }],
      documentary: { storyId: story.id || null, story }
    },
    script: {
      title: script.title, hook: script.hook, fullScript: script.fullScript, beats: script.beats, metadata: script.metadata, sourceTitle: script.sourceTitle,
      mainContent: { sections: [] }, duration: Math.round(result.video.duration),
      // every narrated beat is a factual claim that has verbatim evidence in the source article (the fact-check proved it)
      claims: script.beats.map(beat => ({ text: beat.narration, riskLevel: 'high', sourceUrls: [article.url], status: 'supported', notes: `Evidence: ${beat.evidence.join(' / ').slice(0, 600)}` }))
    },
    thumbnail: { path: result.thumbnailPath, generatedWith: 'documentary-real-image', productionReady: true, concept: { source: 'first beat image' } },
    seo: result.seo,
    assets: {
      script: { sections: script.beats.length },
      thumbnail: { path: result.thumbnailPath, generatedWith: 'documentary-real-image', productionReady: true, dimensions: { width: 1280, height: 720 } },
      audio,
      captions: { path: result.render.srtPath, format: 'srt' },
      video: { visualStyle: 'documentary stills with slow motion', scenePlan: scenes.map(item => item.scene), provenance: scenes.map(item => item.source) },
      finalVideo: { path: result.videoPath, duration: result.video.duration, width: result.video.width, height: result.video.height, simulated: false, captionsBurnedIn: true }
    },
    status: 'ready',
    timeline: { created, scriptReady: created, thumbnailReady: created, audioGenerated: created, videoGenerated: created, captionsGenerated: created, readyForUpload: created },
    scheduledPublishTime: null,
    priority: 5,
    contentType: 'short',
    estimatedDuration: Math.round(result.video.duration),
    containsSyntheticMedia: false,
    createdAt: created
  };
}

/**
 * Gives a claimed story back after a failed production and tags the error for the alert (storyTitle, storyId, attempts,
 * storyRejected). A cancelled job, or a vision model that was not available, is not the story's fault; any other failure counts as an
 * attempt (3 attempts reject the story).
 */
async function releaseAfterFailure(pool, storyId, title, error, { cancelled = false } = {}) {
  // a story that can never be made (too few distinct pictures) is rejected at once, not retried
  const outcome = await pool.release(storyId, { reason: `${error.code || 'error'}: ${error.message}`, countAttempt: !(cancelled || ['JOB_CANCELLED', 'VISION_UNAVAILABLE'].includes(error.code)), maxAttempts: error.permanent ? 1 : undefined });
  error.storyTitle = title;
  error.storyId = storyId;
  error.attempts = outcome?.attempts ?? null;
  error.storyRejected = outcome?.status === 'rejected';
  return error;
}

/**
 * Claims the next pool story and makes one Short. Returns { productionData, story } or throws; on any failure the story goes
 * back to the pool (or is rejected after 3 failed attempts) and the error carries storyTitle/attempts for the alert.
 * Checks that depend on no story (the voice) run BEFORE a story is claimed, so a configuration problem never burns stories.
 */
async function produceOne({ pool, llm, generator, imageFit = null, workRoot = OUTPUT_DIR, env = process.env, signal = null, onStage = async () => {}, logger = console }) {
  const voice = (narrationCommand(env).match(/-m (\S+)/g) || []).pop().slice(3);
  let story = await pool.claimNext();
  if (!story) throw failure('STORY_POOL_EMPTY', 'the Dark History story pool is empty');
  const outDir = path.join(workRoot, `${story.plan.title.replace(/[^a-z0-9]+/gi, '_')}_${Date.now()}`);
  try {
    await onStage('strategy', 10, { storyId: story.id, topic: story.plan.title });
    // A beat whose picture repeats an earlier one falls (never a repeat on screen); too few distinct pictures make the story ineligible.
    const distinct = await pruneNearDuplicates(story.plan.beats, story.plan.folder);
    if (distinct.dropped.length) {
      if (distinct.beats.length < 4) {
        throw failure('STORY_NOT_ELIGIBLE', `only ${distinct.beats.length} distinct pictures remain after dropping near-duplicates (${distinct.dropped.map(item => `${item.heading} repeats ${item.duplicateOf}`).join('; ')})`, { permanent: true });
      }
      story.plan.beats = distinct.beats;
      story.attribution = attributionText({ title: story.plan.title, url: story.article_url }, distinct.beats);
      logger.info?.(`Dark History: dropped ${distinct.dropped.length} beat(s) with a repeated picture (${distinct.dropped.map(item => item.heading).join(', ')})`);
    } else {
      story.plan.beats = distinct.beats;
    }
    // A story made before the footage check existed carries no verdict: it is checked now (one vision request), and a story that carries one is not.
    story = await ensureFootageFit(story, imageFit || { judge: makeVisionJudge(llm) });
    await onStage('script', 25);
    const script = await writeGroundedScript({ story, llm, logger, imageFit });
    await onStage('production', 55);
    const result = await produceDocumentaryShort({ story, script, workDir: outDir, signal, narrate: makeNarrator({ generator, env }) });
    if (!result.gate.passed) {
      throw failure('DOCUMENTARY_GATE_FAILED', `documentary gate failed: ${result.gate.checks.filter(check => !check.passed).map(check => `${check.id} (${check.message})`).join('; ')}`);
    }
    for (const entry of fs.readdirSync(outDir)) if (/^clip_\d+\.mp4$|^clips\.txt$/.test(entry)) fs.rmSync(path.join(outDir, entry), { force: true });
    return { story: result.story, storyId: story.id, productionData: buildProductionData({ story: result.story, script, result, narrationPath: path.join(outDir, 'narration.mp3'), voice }) };
  } catch (error) {
    await releaseAfterFailure(pool, story.id, story.plan.title, error, { cancelled: Boolean(signal?.aborted) });
    fs.rmSync(outDir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * produceOne for up to 3 stories in a row while the claimed story turns out to be permanently ineligible (too few distinct or fitting pictures:
 * it is rejected at once and costs a few calls): the check does not wait two hours for the next story. Any other failure stops the check as before.
 */
async function produceFromPool(args) {
  let last = null;
  for (let i = 0; i < 3; i += 1) {
    try {
      return await produceOne(args);
    } catch (error) {
      if (!error.permanent || error.code === 'STORY_POOL_EMPTY') throw error;
      last = error;
      args.logger?.info?.(`Dark History: "${error.storyTitle}" is not eligible (${String(error.message).slice(0, 90)}); trying the next story`);
    }
  }
  throw last;
}

/** Output folders older than OUTPUT_KEEP_DAYS (a Short is uploaded within hours of being made). */
function pruneOutput(root = OUTPUT_DIR, days = OUTPUT_KEEP_DAYS, now = Date.now()) {
  if (!fs.existsSync(root)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(root)) {
    const dir = path.join(root, entry);
    if (fs.statSync(dir).isDirectory() && now - fs.statSync(dir).mtimeMs > days * 86400000) { fs.rmSync(dir, { recursive: true, force: true }); removed += 1; }
  }
  return removed;
}

/** The cadence the pool can sustain (the strategy's weekly target limited by the ready stories); 0 means nothing can be made. */
async function sustainableCadence(pool, perWeek) {
  const status = await pool.status(perWeek);
  return { ...status, perWeek: Math.min(perWeek, allowedCadencePerWeek(status.ready, perWeek)) };
}

module.exports = { isLive, isDocumentary, buildProductionData, produceFromPool, releaseAfterFailure, pruneOutput, sustainableCadence, PIPELINE, OUTPUT_DIR, OUTPUT_KEEP_DAYS };
