const fs = require('fs').promises;
const axios = require('axios');
const { Logger } = require('./logger');
const { getMediaDuration, probeMediaStreams } = require('./ffmpeg');
const { sendTelegram } = require('./telegram-notifier');
const { maxBeatSeconds } = require('./beat-balance');
const { checkDocumentaryProduction } = require('./dark-history/documentary-gate');

class OperatorService {
  constructor(db) {
    this.db = db;
    this.logger = new Logger('OperatorService');
  }

  async runQualityChecks(production, profile = {}, options = {}) {
    const title = String(production.seo?.title || production.script?.title || '').trim();
    const description = String(production.seo?.description || '').trim();
    const tags = Array.isArray(production.seo?.tags) ? production.seo.tags : [];
    const script = String(production.script?.fullScript || '').trim();
    const finalVideo = production.assets?.finalVideo;
    const thumbnail = production.assets?.thumbnail;
    const bannedTopics = Array.isArray(profile.bannedTopics) ? profile.bannedTopics : [];
    const combinedText = `${title}\n${description}\n${script}`.toLowerCase();
    const spokenWordCount = Number(production.script?.metadata?.spokenWordCount) ||
      [
        production.script?.hook?.text || production.script?.hook,
        ...(production.script?.mainContent?.sections || []).flatMap(section =>
          Array.isArray(section.content) ? section.content : [section.content]
        ),
        production.script?.callToAction?.subscribe || production.script?.callToAction?.text
      ].filter(Boolean).join(' ').split(/\s+/).filter(Boolean).length;
    const lengthKey = String(
      production.strategy?.requestedLengthKey ||
      production.strategy?.length ||
      ''
    ).toLowerCase();
    const wordWindows = {
      short: [90, 140],
      medium: [1050, 1850],
      long: [1800, 2800]
    };
    const wordWindow = wordWindows[lengthKey] || null;

    const checks = [
      this.check('title', title.length > 0 && title.length <= 100,
        title ? `Title is ${title.length}/100 characters` : 'A title is required'),
      this.check('description', description.length >= 50,
        description.length >= 50 ? 'Description is detailed enough' : 'Description should be at least 50 characters'),
      this.check('metadata_tags', tags.length <= 12,
        tags.length <= 12 ? `${tags.length} focused metadata tag${tags.length === 1 ? '' : 's'} provided` : 'Too many tags; keep metadata focused and non-repetitive', false),
      this.check('script', script.length >= 200,
        script.length >= 200 ? 'Script content is present' : 'Script is missing or unusually short'),
      this.check(
        'script_runtime_contract',
        !wordWindow || (spokenWordCount >= wordWindow[0] && spokenWordCount <= wordWindow[1]),
        !wordWindow
          ? `Script has ${spokenWordCount} spoken words`
          : spokenWordCount >= wordWindow[0] && spokenWordCount <= wordWindow[1]
            ? `Script has ${spokenWordCount} spoken words within the ${lengthKey} production range`
            : `Script has ${spokenWordCount} spoken words; ${lengthKey} production requires ${wordWindow[0]}-${wordWindow[1]}`
      ),
      this.check(
        'thumbnail',
        Boolean(
          thumbnail?.path &&
          thumbnail?.productionReady !== false &&
          !['local-draft-fallback', 'placeholder', 'simulation'].includes(String(thumbnail?.generatedWith || '').toLowerCase())
        ),
        !thumbnail?.path
          ? 'Thumbnail asset is missing'
          : thumbnail?.productionReady === false
            ? `Thumbnail is not production-ready${thumbnail?.thumbnailError ? `: ${thumbnail.thumbnailError}` : ''}`
            : ['local-draft-fallback', 'placeholder', 'simulation'].includes(String(thumbnail?.generatedWith || '').toLowerCase())
              ? 'Thumbnail is only a draft/placeholder and must be replaced with real production media'
              : 'Production thumbnail metadata is ready'
      ),
      this.check('video', Boolean(finalVideo?.path && !finalVideo?.simulated),
        finalVideo?.simulated
          ? 'Only a simulated video was produced'
          : finalVideo?.path ? 'Final MP4 is ready' : 'Final MP4 is missing')
    ];

    const topic = String(production.strategy?.topic || '').trim();
    if (topic) {
      // Originality is measured against successfully completed channel output,
      // not abandoned/failed generation attempts. A failed retry must never poison
      // the premise forever, while a completed Short must still block near-duplicates.
      // A production already in the database (approval, pre-upload re-verification) has its own
      // completed job in this list. That job must never be mistaken for a duplicate of itself, so
      // the production's own id is excluded by default; a caller can still pass another id.
      // (Approval used to skip this and failed every Short with "100% similar" to itself.)
      const excludeProductionId = options.excludeProductionId || production.id || null;
      const recent = await this.db.getAllRows(
        `SELECT topic FROM generation_jobs
         WHERE status = 'completed'
           AND created_at >= datetime('now', '-90 days')
           AND topic IS NOT NULL
           AND (? IS NULL OR production_id IS NULL OR production_id != ?)
         ORDER BY created_at DESC LIMIT 120`,
        [excludeProductionId, excludeProductionId]
      );
      let nearest = null;
      for (const row of recent) {
        const candidate = String(row.topic || '').trim();
        if (!candidate) continue;
        const similarity = this.topicSimilarity(topic, candidate);
        if (!nearest || similarity > nearest.similarity) nearest = { topic: candidate, similarity };
      }
      const unique = !nearest || nearest.similarity < 0.62;
      checks.push(this.check(
        'duplicate_premise',
        unique,
        unique
          ? `No semantic duplicate detected in the last 90 days${nearest ? ` (nearest ${Math.round(nearest.similarity * 100)}%)` : ''}`
          : `Premise is too similar to recent story: "${nearest.topic}" (${Math.round(nearest.similarity * 100)}%)`
      ));
    }

    if (thumbnail?.path) {
      checks.push(this.check(
        'thumbnail_file',
        await this.fileExists(thumbnail.path),
        'Production thumbnail file exists on disk'
      ));
    }

    if (finalVideo?.path && !finalVideo?.simulated) {
      const videoExists = await this.fileExists(finalVideo.path);
      checks.push(this.check('video_file', videoExists,
        videoExists ? 'Final video file exists on disk' : 'Final video file is missing'));

      let videoDuration = null;
      let audioDuration = null;
      if (videoExists) {
        try { videoDuration = await getMediaDuration(finalVideo.path); } catch (_error) { videoDuration = null; }
      }
      const audioPath = production.assets?.audio?.path;
      if (audioPath && await this.fileExists(audioPath)) {
        try { audioDuration = await getMediaDuration(audioPath); } catch (_error) { audioDuration = null; }
      }

      checks.push(this.check(
        'media_decode',
        Number.isFinite(videoDuration) && videoDuration > 0,
        Number.isFinite(videoDuration) && videoDuration > 0
          ? `Final MP4 decodes with duration ${videoDuration.toFixed(1)}s`
          : 'Final MP4 duration could not be decoded'
      ));

      if (Number.isFinite(videoDuration) && Number.isFinite(audioDuration)) {
        const delta = Math.abs(videoDuration - audioDuration);
        const tolerance = Math.max(3, audioDuration * 0.05);
        checks.push(this.check(
          'av_sync',
          delta <= tolerance,
          delta <= tolerance
            ? `Audio/video duration delta is ${delta.toFixed(1)}s`
            : `Audio/video duration mismatch is ${delta.toFixed(1)}s (allowed ${tolerance.toFixed(1)}s)`
        ));
      } else {
        checks.push(this.check('av_sync', false, 'Audio/video duration could not be verified'));
      }

      const durationWindows = {
        short: [20, 45],
        medium: [390, 780],
        long: [650, 1200]
      };
      const durationWindow = durationWindows[lengthKey];
      if (durationWindow && Number.isFinite(videoDuration)) {
        const inRange = videoDuration >= durationWindow[0] && videoDuration <= durationWindow[1];
        checks.push(this.check(
          'runtime_target',
          inRange,
          inRange
            ? `Runtime ${videoDuration.toFixed(1)}s matches the ${lengthKey} format target`
            : `Runtime ${videoDuration.toFixed(1)}s is outside the ${lengthKey} production window (${durationWindow[0]}-${durationWindow[1]}s)`
        ));
      }
    }

    const captionsPath = production.assets?.captions?.path;
    const captionsPresent = Boolean(captionsPath && await this.fileExists(captionsPath));
    checks.push(this.check(
      'captions',
      captionsPresent,
      captionsPresent ? 'Caption file is present' : 'Caption file is missing'
    ));

    const audio = production.assets?.audio || {};
    const intentionalSilence = audio.intentionalSilence === true &&
      String(audio.silenceReason || '').trim().length >= 10 &&
      Boolean(audio.silenceConfirmedAt);
    const productionAudioReady = !audio.simulated && await this.fileExists(audio.path);
    const scenes = production.scenes || [];
    let sceneAudioReady = false;
    if (scenes.length) {
      const readiness = [];
      for (const scene of scenes) {
        readiness.push(scene.narrationStatus === 'intentional_silence' || (
          scene.narrationStatus === 'current' && await this.fileExists(scene.audioPath)
        ));
      }
      sceneAudioReady = readiness.every(Boolean);
    }
    const narrationReady = intentionalSilence || productionAudioReady || sceneAudioReady;
    checks.push(this.check('narration', narrationReady,
      intentionalSilence
        ? `Intentional silence confirmed: ${audio.silenceReason}`
        : narrationReady
          ? `Narration is ready${audio.provider ? ` via ${audio.provider}` : ''}`
          : audio.intentionalSilence
            ? 'Intentional silence requires an operator confirmation and reason of at least 10 characters'
            : 'Narration is missing or unusable; regenerate it before approval'));

    // A file that merely exists is not narration. Horror Shorts are voice-led, so
    // prove the voice track is audible and that its length fits the script: silent,
    // clipped, or runaway TTS output must never reach the publish queue.
    const visualPlan = production.assets?.video?.scenePlan || [];
    if (visualPlan.length) {
      const maxBeat = maxBeatSeconds();
      const oversized = visualPlan.filter(scene => Number(scene.duration || 0) > maxBeat + 1);
      checks.push(this.check(
        'visual_cadence',
        oversized.length === 0,
        oversized.length === 0
          ? `${visualPlan.length} visual beats stay within the ${maxBeat}s pacing target`
          : `${oversized.length} visual beat${oversized.length === 1 ? '' : 's'} exceed the ${maxBeat}s pacing target`
      ));

      const provenance = Array.isArray(production.assets?.video?.provenance)
        ? production.assets.video.provenance
        : [];
      const freeMediaOnly = !/^(0|false|no)$/i.test(String(process.env.FREE_MEDIA_ONLY || 'true'));
      if (freeMediaOnly) {
        const sourceByScene = new Map(provenance.map(item => [Number(item.sceneIndex), item]));
        const missingSourceEvidence = visualPlan.filter(scene => {
          const source = sourceByScene.get(Number(scene.index));
          return !source || !source.provider || !source.sourcePage || !source.license;
        });
        checks.push(this.check(
          'media_provenance',
          missingSourceEvidence.length === 0,
          missingSourceEvidence.length === 0
            ? 'Every documentary visual has provider, source page, and license evidence'
            : `${missingSourceEvidence.length} visual beat${missingSourceEvidence.length === 1 ? '' : 's'} lack complete media provenance`
        ));

        const sourceKeys = provenance
          .map(item => item.sourceId ? `${item.provider}:${item.sourceId}` : item.sourcePage)
          .filter(Boolean);
        const uniqueSources = new Set(sourceKeys);
        checks.push(this.check(
          'visual_diversity',
          sourceKeys.length === uniqueSources.size,
          sourceKeys.length === uniqueSources.size
            ? `${uniqueSources.size} distinct media sources cover ${visualPlan.length} visual beats`
            : 'One or more documentary visuals are reused across beats'
        ));
        const requiredAttributions = provenance.filter(item => item.attributionRequired === true);
        const descriptionLower = description.toLowerCase();
        const missingAttribution = requiredAttributions.filter(item => {
          const sourcePage = String(item.sourcePage || '').trim().toLowerCase();
          const creator = String(item.creator || '').trim().toLowerCase();
          return (sourcePage && !descriptionLower.includes(sourcePage)) ||
            (creator && creator.length >= 3 && !descriptionLower.includes(creator));
        });
        checks.push(this.check(
          'media_attribution',
          missingAttribution.length === 0,
          missingAttribution.length === 0
            ? requiredAttributions.length
              ? `All ${requiredAttributions.length} required media attribution${requiredAttributions.length === 1 ? ' is' : 's are'} included in the description`
              : 'No selected media requires public attribution'
            : `${missingAttribution.length} required media credit${missingAttribution.length === 1 ? ' is' : 's are'} missing from the publish description`
        ));
      }
    }

    const matchedBannedTopics = bannedTopics.filter(topic =>
      topic && combinedText.includes(String(topic).toLowerCase())
    );
    checks.push(this.check('brand_policy', matchedBannedTopics.length === 0,
      matchedBannedTopics.length
        ? `Content matches blocked terms: ${matchedBannedTopics.join(', ')}`
        : 'No blocked brand topics detected'));

    const provenance = production.provenance || {};
    const provenancePassed = ['verified', 'not_required'].includes(provenance.status || 'not_required');
    const unresolved = Number(provenance.summary?.unresolvedClaims || 0);
    checks.push(this.check('provenance', provenancePassed,
      provenance.status === 'verified'
        ? `${provenance.summary?.resolvedClaims || 0} factual claims resolved against reviewed evidence`
        : provenance.status === 'not_required'
          ? 'No externally verifiable factual claims were declared'
          : `${unresolved} factual claim${unresolved === 1 ? '' : 's'} still require evidence review`));

    // A Dark History production also passes its own gate (footage, licences, hashes, fact-check re-run, attribution, voice),
    // re-evaluated here from the files on disk, so it holds again right before every upload.
    if (production.strategy?.pipeline === 'dark-history') {
      for (const check of await this.documentaryChecks(production)) checks.push(this.check(`dh_${check.id}`, check.passed, check.message));
    }

    const discoverability = production.discoverability;
    if (discoverability) {
      const actionable = (discoverability.findings || []).filter(finding =>
        ['CRITICAL', 'HIGH'].includes(finding.severity) && finding.reviewStatus !== 'dismissed'
      );
      const available = discoverability.status !== 'unavailable';
      checks.push(this.check(
        'discoverability',
        available && actionable.length === 0,
        !available
          ? `DarkzSEO advisory audit is unavailable${discoverability.error ? `: ${discoverability.error}` : ''}`
          : actionable.length
            ? `${actionable.length} high-priority discoverability finding${actionable.length === 1 ? '' : 's'} await remediation or dismissal`
            : `${discoverability.findings?.length || 0} discoverability finding${discoverability.findings?.length === 1 ? '' : 's'} recorded; no unresolved high-priority findings`,
        false
      ));
    }

    if (scenes.length) {
      const invalidScenes = scenes.filter(scene =>
        !scene.assetPath || ['missing_asset', 'failed', 'generating', 'needs_rebuild', 'visual_stale'].includes(scene.status) ||
        !['current', 'intentional_silence'].includes(scene.narrationStatus)
      );
      const unlicensedUploads = scenes.filter(scene => scene.assetOrigin === 'uploaded' && !scene.rightsConfirmed);
      checks.push(this.check('scene_integrity', invalidScenes.length === 0,
        invalidScenes.length === 0
          ? `${scenes.length} scene${scenes.length === 1 ? '' : 's'} are rebuilt and current`
          : `${invalidScenes.length} scene${invalidScenes.length === 1 ? '' : 's'} still require repair or rebuild`));
      checks.push(this.check('scene_rights', unlicensedUploads.length === 0,
        unlicensedUploads.length === 0
          ? 'Replacement scene assets have rights confirmation'
          : `${unlicensedUploads.length} uploaded scene asset${unlicensedUploads.length === 1 ? '' : 's'} lack rights confirmation`));
    }

    const blockingFailures = checks.filter(check => check.blocking && !check.passed);
    return {
      passed: blockingFailures.length === 0,
      score: Math.round((checks.filter(check => check.passed).length / checks.length) * 100),
      blockingFailures: blockingFailures.map(check => check.id),
      checks
    };
  }

  /** The documentary gate's checks for a stored production; a gate that cannot run is a failed gate. */
  async documentaryChecks(production) {
    try {
      const finalVideo = production.assets?.finalVideo;
      let video = null;
      try {
        const streams = await probeMediaStreams(finalVideo.path);
        video = { width: streams.width, height: streams.height, duration: await getMediaDuration(finalVideo.path), hasAudio: streams.hasAudio };
      } catch (_error) { video = null; }
      return checkDocumentaryProduction({
        story: production.strategy.documentary?.story, script: production.script, description: production.seo?.description, video, audio: production.assets?.audio,
        segments: production.assets?.video?.scenePlan || []
      }).checks;
    } catch (error) {
      return [{ id: 'gate_error', passed: false, message: `the documentary gate could not run: ${String(error.message).slice(0, 160)}` }];
    }
  }

  normalizedTopicTokens(value) {
    const stop = new Set(['the','a','an','and','or','of','to','in','on','for','with','at','from','his','her','their','this','that']);
    return new Set(String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter(token => token.length >= 3 && !stop.has(token)));
  }

  topicSimilarity(left, right) {
    const a = this.normalizedTopicTokens(left);
    const b = this.normalizedTopicTokens(right);
    if (!a.size || !b.size) return 0;
    const shared = [...a].filter(token => b.has(token)).length;
    return shared / Math.min(a.size, b.size);
  }

  async fileFingerprint(filePath) {
    try {
      const crypto = require('crypto');
      return crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
    } catch (_error) {
      return null;
    }
  }

  check(id, passed, message, blocking = true) {
    return { id, passed: Boolean(passed), blocking, message };
  }

  async fileExists(filePath) {
    try {
      const stats = await fs.stat(filePath);
      return stats.isFile() && stats.size > 0;
    } catch (_error) {
      return false;
    }
  }

  async notify(notification) {
    const enabled = await this.db.getSetting('notification_enabled');
    if (enabled === 'false') return null;

    // A failure that repeats on every scheduler tick must alert the owner once, not on every tick.
    // `dedupeKey` + `dedupeMinutes` (default 6 h) suppress a repeat; the timestamp survives restarts.
    if (notification.dedupeKey) {
      const settingKey = `notify_last:${String(notification.dedupeKey).slice(0, 120)}`;
      const windowMs = Math.max(1, Number(notification.dedupeMinutes || 360)) * 60 * 1000;
      const last = await this.db.getSetting(settingKey);
      if (last && Date.now() - new Date(last).getTime() < windowMs) return null;
      await this.db.setSetting(settingKey, new Date().toISOString());
    }

    const id = await this.db.createNotification(notification);
    const webhookUrl = process.env.NOTIFICATION_WEBHOOK_URL;
    if (webhookUrl) {
      try {
        await axios.post(webhookUrl, {
          text: `${notification.title}: ${notification.message}`,
          content: `${notification.title}: ${notification.message}`,
          ...notification
        }, { timeout: 5000 });
      } catch (error) {
        this.logger.warn(`Notification webhook failed: ${error.message}`);
      }
    }
    const telegram = await sendTelegram(notification);
    if (telegram.reason && telegram.reason !== 'skipped') this.logger.warn(`Telegram alert not sent (${telegram.reason})`);
    return id;
  }
}

module.exports = { OperatorService };
