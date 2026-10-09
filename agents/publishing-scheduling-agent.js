const { google } = require('googleapis');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { Logger } = require('../utils/logger');
const { assertValidYouTubeMetadata } = require('../utils/youtube-metadata-validator');
const channelIdentity = require('../utils/channel-identity');
const { assertExpectedChannel, isChannelMismatch } = require('../utils/youtube-channel-guard');

function assertUploadEnabled() {
  if (String(process.env.YOUTUBE_UPLOAD_ENABLED || '').toLowerCase() === 'true') return;
  const error = new Error('YouTube upload is disabled until the operator explicitly enables it after final approval.');
  error.status = 409;
  error.code = 'UPLOAD_DISABLED';
  throw error;
}

class PublishingSchedulingAgent {
  constructor(db, credentials) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('PublishingScheduling');
    this.youtube = null;
    this.publishQueue = [];
    // Injected by the orchestrator: re-runs the full QA suite on the real files
    // right before upload. Without it uploads are refused (fail closed).
    this.preUploadVerifier = null;
    // Injected by the orchestrator (alerts). Never required, never allowed to break publishing.
    this.notify = null;
    this.maxPublishRetries = Math.max(0, Number(process.env.PUBLISH_MAX_RETRIES || 3));
  }

  async alert(notification) {
    if (typeof this.notify !== 'function') return;
    try { await this.notify(notification); } catch (error) { this.logger.warn(`Alert failed: ${error.message}`); }
  }

  async initialize() {
    this.logger.info('Initializing Publishing & Scheduling Agent...');
    await this.setupYouTubeAPI();
    await this.loadPublishQueue();
    return true;
  }

  async setupYouTubeAPI() {
    try {
      const auth = this.credentials.getYouTubeAuth();
      this.youtube = google.youtube({ version: 'v3', auth });
      this.logger.info('YouTube API initialized');
    } catch (error) {
      this.logger.error('Failed to initialize YouTube API:', error);
      throw error;
    }
  }

  async loadPublishQueue() {
    try {
      const queue = await this.db.getPublishQueue();
      this.publishQueue = queue || [];
      this.logger.info(`Loaded ${this.publishQueue.length} items in publish queue`);
    } catch (error) {
      this.logger.warn('No existing publish queue found');
    }
  }

  async scheduleContent(productionData) {
    try {
      const finalVideo = productionData.assets?.finalVideo;
      if (!finalVideo || finalVideo.simulated || path.extname(finalVideo.path || '').toLowerCase() !== '.mp4') {
        this.logger.warn(`Not scheduling ${productionData.id}: no real video file was produced (placeholder/simulated output). Fix your AI provider keys and FFmpeg, then regenerate.`);
        return null;
      }
      if (!await this.isNarrationReady(productionData.assets?.audio)) {
        this.logger.warn(`Not scheduling ${productionData.id}: narration is missing. Regenerate narration or explicitly confirm an intentional silent video.`);
        return null;
      }

      const contentType = productionData.contentType || 'long_form';
      let publishTime = this.normalizePublishTime(productionData.scheduledPublishTime);
      if (!publishTime && String(process.env.AUTONOMOUS_MODE || '').toLowerCase() === 'true') {
        publishTime = await this.nextAutonomousPublishTime(contentType);
      }
      if (!publishTime) {
        this.logger.info(`Not scheduling ${productionData.id}: no explicit valid publish time has been selected.`);
        return null;
      }

      this.logger.info(`Scheduling content: ${productionData.id}`);
      const existing = await this.db.getLatestScheduleEntry?.(productionData.id);
      if (existing) {
        if (['scheduled', 'paused'].includes(existing.status) && !this.publishQueue.some(entry => entry.id === existing.id)) {
          this.publishQueue.push(existing);
          this.sortPublishQueue();
        }
        this.logger.info(`Reusing existing ${existing.status} schedule entry for: ${productionData.id}`);
        return existing;
      }

      await this.assertPublishingCadence(publishTime, contentType);

      const scheduleEntry = {
        productionId: productionData.id,
        title: productionData.script.title,
        publishTime,
        status: 'scheduled',
        priority: productionData.priority,
        metadata: {
          seo: productionData.seo,
          thumbnail: productionData.assets.thumbnail,
          video: productionData.assets.finalVideo,
          audio: productionData.assets.audio,
          captions: productionData.assets.captions,
          privacyStatus: productionData.privacyStatus || process.env.DEFAULT_PRIVACY_STATUS || 'private',
          containsSyntheticMedia: productionData.containsSyntheticMedia === true,
          contentType,
          sourceProductionId: productionData.sourceProductionId || productionData.id
        },
        createdAt: new Date().toISOString()
      };
      
      const saved = await this.db.saveScheduleEntry(scheduleEntry) || scheduleEntry;
      this.publishQueue.push(saved);
      this.sortPublishQueue();
      
      this.logger.info(`Content scheduled for: ${saved.publishTime}`);
      return saved;
    } catch (error) {
      this.logger.error('Failed to schedule content:', error);
      throw error;
    }
  }

  normalizePublishTime(value) {
    if (!value) return null;
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    return date.toISOString();
  }

  scheduleContentType(entry = {}) {
    return entry.metadata?.contentType || entry.contentType || 'short';
  }

  roundPublishTime(value, minutes = 30) {
    const date = new Date(value);
    const step = Math.max(5, Number(minutes || 30)) * 60000;
    return new Date(Math.ceil(date.getTime() / step) * step).toISOString();
  }

  async nextAutonomousPublishTime(contentType = 'short') {
    const now = Date.now();
    const strategy = this.db.getChannelStrategy ? await this.db.getChannelStrategy() : null;
    const target = Math.max(1, Math.min(35, Number(
      strategy?.cadence_per_week ||
      ((channelIdentity.publishingCadence?.shortsPerDay?.target || 3) * 7)
    )));
    const spacingMs = (7 * 24 * 60 * 60 * 1000) / target;
    let candidate = now + Math.max(45 * 60 * 1000, spacingMs * 0.35);

    if (this.db.getScheduleEntriesInRange) {
      const entries = await this.db.getScheduleEntriesInRange(
        new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString(),
        new Date(now + 14 * 24 * 60 * 60 * 1000).toISOString()
      );
      const sameTypeTimes = entries
        .filter(entry => this.scheduleContentType(entry) === contentType)
        .map(entry => new Date(entry.publishTime).getTime())
        .filter(Number.isFinite);
      if (sameTypeTimes.length) candidate = Math.max(candidate, Math.max(...sameTypeTimes) + spacingMs);
    }

    return this.roundPublishTime(candidate, 15);
  }

  async assertPublishingCadence(publishTime, contentType = 'short', excludeScheduleId = null) {
    if (!this.db.getScheduleEntriesInRange) return true;

    const strategy = this.db.getChannelStrategy ? await this.db.getChannelStrategy() : null;
    const target = Math.max(1, Math.min(35, Number(
      strategy?.cadence_per_week ||
      ((channelIdentity.publishingCadence?.shortsPerDay?.target || 3) * 7)
    )));
    const spacingMs = (7 * 24 * 60 * 60 * 1000) / target;
    const center = new Date(publishTime).getTime();
    const start = new Date(center - spacingMs + 1000).toISOString();
    const end = new Date(center + spacingMs - 1000).toISOString();
    const nearby = await this.db.getScheduleEntriesInRange(start, end, excludeScheduleId);
    const conflicts = nearby.filter(entry => {
      if (this.scheduleContentType(entry) !== contentType) return false;
      const entryTime = new Date(entry.publishTime).getTime();
      return Number.isFinite(entryTime) && Math.abs(entryTime - center) < spacingMs;
    });
    if (conflicts.length) {
      const nearest = conflicts.slice().sort((a,b) =>
        Math.abs(new Date(a.publishTime)-center)-Math.abs(new Date(b.publishTime)-center)
      )[0];
      const error = new Error(
        `Shorts cadence allows about ${target} publication(s) per week; choose a slot at least ${Math.round(spacingMs/60000)} minutes away from ${nearest.publishTime}`
      );
      error.status = 409;
      error.code = 'CADENCE_CONFLICT';
      throw error;
    }
    return true;
  }

  sortPublishQueue() {
    this.publishQueue.sort((a, b) => {
      const aTime = new Date(a.publishTime).getTime();
      const bTime = new Date(b.publishTime).getTime();
      if (!Number.isFinite(aTime) && !Number.isFinite(bTime)) return 0;
      if (!Number.isFinite(aTime)) return 1;
      if (!Number.isFinite(bTime)) return -1;
      return aTime - bTime;
    });
  }

  /**
   * One upload per production at a time. The status check and the 'uploading' write in the body are separated by
   * awaits (narration check, QA), so the 15-minute cron and a manual "publish now" could both pass the check and both
   * call videos.insert for the same Short.
   */
  async publishContent(contentId, options = {}) {
    const inFlight = this.uploadsInFlight || (this.uploadsInFlight = new Set());
    const key = String(contentId);
    if (inFlight.has(key)) {
      const error = new Error(`An upload for ${key} is already in progress`);
      error.status = 409;
      error.code = 'UPLOAD_IN_PROGRESS';
      throw error;
    }
    inFlight.add(key);
    try {
      return await this.publishContentUnlocked(contentId, options);
    } finally {
      inFlight.delete(key);
    }
  }

  async publishContentUnlocked(contentId, options = {}) {
    try {
      let productionBundle = null;

      // Content integrity gates come first so each production is independently
      // rejected for its own unresolved state before environment readiness.
      if (this.db.getProductionBundle) {
        productionBundle = await this.db.getProductionBundle(contentId);
        if (!productionBundle) {
          const error = new Error('Publishing is blocked because the production bundle is missing');
          error.status = 409;
          error.code = 'PRODUCTION_BUNDLE_MISSING';
          throw error;
        }
        if (!['verified', 'not_required'].includes(productionBundle.provenance?.status || 'not_required')) {
          const error = new Error('Publishing is blocked until every factual claim is supported by verified evidence');
          error.status = 409;
          error.code = 'PROVENANCE_BLOCKED';
          throw error;
        }
        if (productionBundle.reviewStatus !== 'approved' && productionBundle.review_status !== 'approved') {
          const error = new Error('Publishing is blocked until the source production passes the automated approval gate');
          error.status = 409;
          error.code = 'APPROVAL_REQUIRED';
          throw error;
        }
      }

      assertUploadEnabled();

      if (this.db.getLatestReadinessRun) {
        const readiness = await this.db.getLatestReadinessRun();
        const ageMs = readiness
          ? Date.now() - new Date(readiness.completed_at || readiness.created_at).getTime()
          : Infinity;
        const stale = !Number.isFinite(ageMs) || ageMs > 24 * 60 * 60 * 1000;
        const usableStatus = readiness && ['passed', 'warning'].includes(readiness.status);
        if (!usableStatus || stale) {
          const failures = readiness?.checks
            ?.filter(check => check.blocking && check.status === 'failed')
            .map(check => check.id) || [];
          const reason = !readiness
            ? 'no verified readiness run exists'
            : stale
              ? 'the latest readiness run is older than 24 hours'
              : failures.length
                ? `blocking checks failed: ${failures.join(', ')}`
                : `readiness status is ${readiness.status}`;
          const error = new Error(`Publishing is blocked by the production readiness gate because ${reason}.`);
          error.status = 409;
          error.code = 'READINESS_BLOCKED';
          throw error;
        }
      }
      this.logger.info(`Publishing content: ${contentId}`);
      
      let scheduleEntry = this.publishQueue.find(entry =>
        entry.productionId === contentId || entry.id === contentId
      );
      if (!scheduleEntry && this.db.getLatestScheduleEntry) {
        scheduleEntry = await this.db.getLatestScheduleEntry(contentId);
      }
      
      if (!scheduleEntry) {
        throw new Error(`Content not found in queue: ${contentId}`);
      }
      if (scheduleEntry.status === 'published') return scheduleEntry;
      if (!await this.isNarrationReady(scheduleEntry.metadata?.audio || productionBundle?.assets?.audio)) {
        const error = new Error('Publishing is blocked because narration is missing or the intentional-silence override is incomplete');
        error.status = 409;
        error.code = 'NARRATION_REQUIRED';
        throw error;
      }
      if (scheduleEntry.youtubeId) {
        return this.reconcileUploadedVideo(scheduleEntry);
      }
      if (['uploading', 'reconciliation_required'].includes(scheduleEntry.status)) {
        const error = new Error('A previous upload may have reached YouTube without returning a video ID. Reconcile the channel before attempting another upload.');
        error.status = 409;
        error.code = 'UPLOAD_OUTCOME_UNKNOWN';
        throw error;
      }

      await this.assertPreUploadQuality(scheduleEntry, productionBundle);

      scheduleEntry.status = 'uploading';
      scheduleEntry.error = null;
      await this.db.updateScheduleEntry(scheduleEntry);
      
      let uploadResult;
      try {
        uploadResult = await this.uploadToYouTube(scheduleEntry, options);
      } catch (error) {
        if (this.isAuthError(error) || isChannelMismatch(error)) {
          // Revoked/expired refresh token, or a login for the wrong channel: nothing reached YouTube. Keep the
          // Short scheduled, tell the owner exactly what to do, and retry by itself once the login is right.
          await this.deferForAuth(scheduleEntry, error);
          error.code = 'AUTH_REQUIRED';
          error.status = 401;
          error.retryScheduled = true;
        } else if (scheduleEntry.uploadAttempted && this.isUploadOutcomeUnknown(error)) {
          scheduleEntry.status = 'reconciliation_required';
          scheduleEntry.error = 'Upload outcome is unknown; automatic reconciliation is required before retrying';
          scheduleEntry.metadata = {
            ...scheduleEntry.metadata,
            reconciliation: {
              ...(scheduleEntry.metadata?.reconciliation || {}),
              firstSeenAt: scheduleEntry.metadata?.reconciliation?.firstSeenAt || new Date().toISOString(),
              checks: Number(scheduleEntry.metadata?.reconciliation?.checks || 0)
            }
          };
          await this.db.updateScheduleEntry(scheduleEntry);
          error.code = 'UPLOAD_OUTCOME_UNKNOWN';
          error.status = 409;
        } else if (this.isTransientPublishError(error) &&
          Number(scheduleEntry.metadata?.publishRetries || 0) < this.maxPublishRetries) {
          // Reaching this branch with uploadAttempted=true means YouTube ANSWERED with a definite HTTP error below
          // 500 (for example 403 quotaExceeded on videos.insert): nothing was uploaded, so it is safe to retry.
          // Unknown outcomes (no status or 5xx) were handled above and go to reconciliation instead.
          scheduleEntry.uploadAttempted = false;
          const retries = Number(scheduleEntry.metadata?.publishRetries || 0) + 1;
          const quota = this.isQuotaError(error);
          const delayMs = quota ? 6 * 60 * 60 * 1000 : 15 * 60 * 1000 * (2 ** (retries - 1));
          scheduleEntry.status = 'scheduled';
          scheduleEntry.publishTime = new Date(Date.now() + delayMs).toISOString();
          scheduleEntry.error = `Transient publish failure (retry ${retries}/${this.maxPublishRetries}): ${error.message}`;
          scheduleEntry.metadata = { ...scheduleEntry.metadata, publishRetries: retries };
          await this.db.updateScheduleEntry(scheduleEntry);
          error.code = error.code || 'PUBLISH_RETRY_SCHEDULED';
          error.retryScheduled = true;
        } else {
          scheduleEntry.status = 'failed';
          scheduleEntry.error = error.message;
          await this.db.updateScheduleEntry(scheduleEntry);
          await this.alert({
            type: 'upload_failed', level: 'error', title: 'Upload failed',
            message: `${scheduleEntry.title || scheduleEntry.productionId}: ${error.message}`,
            data: { productionId: scheduleEntry.productionId }
          });
        }
        throw error;
      }
      
      // UPLOAD -> VERIFY VIDEO ID -> RECORD RESULT. The upload response alone is
      // not proof: confirm the video exists on the channel and was not rejected.
      scheduleEntry.youtubeId = uploadResult.id;
      scheduleEntry.youtubeUrl = `https://www.youtube.com/watch?v=${uploadResult.id}`;
      const verified = await this.reconcileUploadedVideo(scheduleEntry);
      this.logger.success(`Content published and verified: ${verified.youtubeUrl}`);
      await this.alert({
        type: 'upload_published', level: 'success', title: 'Short published',
        message: `${verified.title || scheduleEntry.title || scheduleEntry.productionId} is live (video ${verified.youtubeId || uploadResult.id}).`,
        data: { productionId: scheduleEntry.productionId, youtubeId: verified.youtubeId || uploadResult.id, youtubeUrl: verified.youtubeUrl }
      });
      return verified;
    } catch (error) {
      this.logger.error('Failed to publish content:', error);
      throw error;
    }
  }

  async uploadToYouTube(scheduleEntry, options = {}) {
    assertUploadEnabled();
    const { metadata } = scheduleEntry;
    const validation = assertValidYouTubeMetadata(metadata.seo);
    if (validation.warnings.length) {
      this.logger.warn(`YouTube metadata warnings: ${validation.warnings.join(' ')}`);
    }
    const safeMetadata = validation.value;
    let uploadDescription = safeMetadata.description;
    if (metadata.contentType === 'short' && metadata.sourceProductionId && this.db.getLatestScheduleEntry) {
      const parentSchedule = await this.db.getLatestScheduleEntry(metadata.sourceProductionId);
      const parentVideoId = parentSchedule?.youtubeId || parentSchedule?.youtube_id || null;
      if (parentVideoId) {
        const parentUrl = `https://www.youtube.com/watch?v=${parentVideoId}`;
        if (!uploadDescription.includes(parentUrl)) {
          uploadDescription = `${uploadDescription}\n\nWatch the full story: ${parentUrl}`.trim();
        }
      }
    }
    
    // Prepare video metadata
    const requestedPrivacy = metadata.privacyStatus || process.env.DEFAULT_PRIVACY_STATUS || 'private';
    const scheduledFor = new Date(scheduleEntry.publishTime);
    const futureSchedule = !options.publishNow && Number.isFinite(scheduledFor.getTime()) && scheduledFor.getTime() > Date.now() + 60000;
    const videoMetadata = {
      snippet: {
        title: safeMetadata.title,
        description: uploadDescription,
        tags: safeMetadata.tags,
        categoryId: safeMetadata.categoryId,
        defaultLanguage: safeMetadata.defaultLanguage,
        defaultAudioLanguage: safeMetadata.defaultAudioLanguage
      },
      status: {
        privacyStatus: futureSchedule ? 'private' : requestedPrivacy,
        selfDeclaredMadeForKids: false,
        containsSyntheticMedia: metadata.containsSyntheticMedia === true
      }
    };
    if (futureSchedule) videoMetadata.status.publishAt = scheduleEntry.publishTime;
    
    // The token follows the Google account, not the project: confirm the authorized channel is the expected
    // one right before every upload (1 quota unit; the stored readiness result can be 12 h old).
    await this.assertAuthorizedChannel();

    // Resolve the file before marking the network upload as attempted.
    const videoStream = await this.getVideoStream(metadata.video.path);
    scheduleEntry.uploadAttempted = true;
    const videoUpload = await this.youtube.videos.insert({
      part: 'snippet,status',
      requestBody: videoMetadata,
      media: {
        body: videoStream
      }
    });
    
    const videoId = videoUpload.data.id;
    this.logger.info(`Video uploaded with ID: ${videoId}`);
    scheduleEntry.status = 'uploaded';
    scheduleEntry.youtubeId = videoId;
    scheduleEntry.youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
    scheduleEntry.error = null;
    await this.db.updateScheduleEntry(scheduleEntry);
    
    // Upload thumbnail
    if (metadata.thumbnail && metadata.thumbnail.path) {
      await this.uploadThumbnail(videoId, metadata.thumbnail.path);
    }
    
    // Upload captions
    if (metadata.captions && metadata.captions.path) {
      await this.uploadCaptions(videoId, metadata.captions.path);
    }
    
    return videoUpload.data;
  }

  /**
   * Mandatory gates are re-evaluated against the real files immediately before
   * every upload. A schedule is never allowed to override a failing gate.
   */
  async assertPreUploadQuality(scheduleEntry, productionBundle) {
    const block = async (message) => {
      scheduleEntry.status = 'blocked';
      scheduleEntry.error = message;
      await this.db.updateScheduleEntry(scheduleEntry);
      await this.alert({
        type: 'upload_blocked', level: 'warning', title: 'Upload blocked',
        message: `${scheduleEntry.title || scheduleEntry.productionId}: ${message}`,
        data: { productionId: scheduleEntry.productionId }
      });
      const error = new Error(message);
      error.status = 409;
      error.code = 'PRE_UPLOAD_QA_FAILED';
      throw error;
    };
    if (typeof this.preUploadVerifier !== 'function') {
      return block('Upload blocked: no pre-upload QA verifier is configured');
    }
    if (!productionBundle) {
      return block('Upload blocked: production bundle is unavailable for pre-upload QA');
    }
    let quality;
    try {
      quality = await this.preUploadVerifier(productionBundle);
    } catch (error) {
      return block(`Upload blocked: pre-upload QA could not run (${error.message})`);
    }
    scheduleEntry.metadata = {
      ...scheduleEntry.metadata,
      preUploadQa: {
        checkedAt: new Date().toISOString(),
        passed: Boolean(quality?.passed),
        score: quality?.score ?? null,
        blockingFailures: quality?.blockingFailures || []
      }
    };
    if (!quality?.passed) {
      return block(`Upload blocked by pre-upload QA: ${(quality?.blockingFailures || ['unknown']).join(', ')}`);
    }
    return quality;
  }

  /** Throws CHANNEL_MISMATCH when the authorized channel is not the expected one, CHANNEL_NOT_CONFIGURED when no expected channel is set. */
  async assertAuthorizedChannel() {
    if (typeof this.youtube?.channels?.list !== 'function') return null;
    const response = await this.youtube.channels.list({ part: 'id,snippet', mine: true, maxResults: 1 });
    return assertExpectedChannel(response.data?.items?.[0] || null);
  }

  isAuthError(error) {
    const data = error?.response?.data;
    const text = `${error?.message || ''} ${data?.error || ''} ${data?.error_description || ''}`;
    return /invalid_grant|invalid_client|unauthorized_client|Token has been expired or revoked/i.test(text);
  }

  /** Keeps an auth-blocked Short scheduled and alerts the owner (first time, then every 12 h). */
  async deferForAuth(scheduleEntry, error) {
    const now = Date.now();
    const previous = scheduleEntry.metadata?.authBlocked || {};
    const lastAlertAt = previous.alertedAt ? new Date(previous.alertedAt).getTime() : 0;
    const shouldAlert = !lastAlertAt || now - lastAlertAt >= 12 * 60 * 60 * 1000;
    scheduleEntry.status = 'scheduled';
    scheduleEntry.uploadAttempted = false;
    scheduleEntry.publishTime = new Date(now + 60 * 60 * 1000).toISOString();
    const wrongChannel = isChannelMismatch(error);
    const notConfigured = error?.code === 'CHANNEL_NOT_CONFIGURED';
    scheduleEntry.error = wrongChannel
      ? `${notConfigured ? 'No expected YouTube channel configured' : 'Wrong YouTube channel authorized'}; nothing was uploaded. ${error.message}`
      : 'YouTube authorization expired (invalid_grant). Re-authorize the channel; this Short will upload automatically afterwards.';
    scheduleEntry.metadata = {
      ...scheduleEntry.metadata,
      authBlocked: {
        reason: notConfigured ? 'channel_not_configured' : wrongChannel ? 'channel_mismatch' : 'invalid_grant',
        since: previous.since || new Date(now).toISOString(),
        alertedAt: shouldAlert ? new Date(now).toISOString() : previous.alertedAt,
        checks: Number(previous.checks || 0) + 1
      }
    };
    await this.db.updateScheduleEntry(scheduleEntry);
    this.logger.warn(wrongChannel
      ? `The authorized YouTube channel is not the expected one; ${scheduleEntry.title || scheduleEntry.productionId} stays scheduled until the right channel is authorized.`
      : `YouTube authorization is revoked or expired; ${scheduleEntry.title || scheduleEntry.productionId} stays scheduled until the channel is re-authorized.`);
    if (shouldAlert) {
      await this.alert(wrongChannel
        ? {
          type: 'auth_required', level: 'error', title: notConfigured ? 'Expected YouTube channel is not configured' : 'Wrong YouTube channel authorized',
          message: `${scheduleEntry.title || scheduleEntry.productionId} was NOT uploaded. ${error.message} Nothing was lost; the Short stays scheduled and uploads by itself after the right login.`,
          data: { productionId: scheduleEntry.productionId }
        }
        : {
          type: 'auth_required', level: 'error', title: 'YouTube needs re-authorization',
          message: `${scheduleEntry.title || scheduleEntry.productionId} could not upload: Google revoked or expired the YouTube login (invalid_grant). Nothing was lost; the Short stays scheduled and uploads by itself after you re-authorize (deploy/oracle-vm/README.md, "Re-authorize YouTube"). Make sure the Google OAuth consent screen is "In production", otherwise this repeats every 7 days.`,
          data: { productionId: scheduleEntry.productionId }
        });
    }
  }

  /** Shorts that an older build marked failed only because of invalid_grant get one fresh chance. */
  async reviveAuthFailures() {
    let revived = 0;
    // The in-memory queue only holds scheduled/paused/uploading rows, never `failed` ones, so load the
    // auth-failed rows from the database and add them to the queue before looking at them.
    if (typeof this.db.getAuthFailedScheduleEntries === 'function') {
      for (const row of await this.db.getAuthFailedScheduleEntries()) {
        if (!this.publishQueue.some(item => item.id === row.id)) this.publishQueue.push(row);
      }
    }
    for (const entry of this.publishQueue) {
      if (entry.status !== 'failed' || entry.youtubeId || entry.uploadAttempted === false) continue;
      if (!/invalid_grant/i.test(String(entry.error || ''))) continue;
      entry.status = 'scheduled';
      entry.uploadAttempted = false;
      entry.publishTime = new Date().toISOString();
      entry.error = null;
      entry.metadata = { ...entry.metadata, authRevivedAt: new Date().toISOString() };
      await this.db.updateScheduleEntry(entry);
      revived += 1;
    }
    return revived;
  }

  isQuotaError(error) {
    const reasons = (error?.errors || error?.response?.data?.error?.errors || []).map(item => String(item.reason || ''));
    return reasons.some(reason => /quotaExceeded|uploadLimitExceeded|rateLimitExceeded|dailyLimitExceeded/i.test(reason)) ||
      /quota/i.test(String(error?.message || ''));
  }

  isTransientPublishError(error) {
    if (this.isQuotaError(error)) return true;
    const status = Number(error?.status || error?.code || error?.response?.status || 0);
    if ([408, 425, 429].includes(status) || status >= 500) return true;
    return ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENETUNREACH', 'EAI_AGAIN', 'ENOTFOUND']
      .includes(String(error?.code || '').toUpperCase());
  }

  async isNarrationReady(audio = {}) {
    if (audio.intentionalSilence === true) {
      return String(audio.silenceReason || '').trim().length >= 10 && Boolean(audio.silenceConfirmedAt);
    }
    if (!audio.path || audio.simulated || String(audio.path).endsWith('.info')) return false;
    try {
      const stats = await fs.stat(audio.path);
      return stats.isFile() && stats.size > 0;
    } catch (_error) {
      return false;
    }
  }

  isUploadOutcomeUnknown(error) {
    const status = Number(error.status || error.response?.status || 0);
    return !status || status >= 500;
  }

  normalizeComparableTitle(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  async reconcileUnknownUpload(scheduleEntry) {
    if (scheduleEntry.youtubeId) return this.reconcileUploadedVideo(scheduleEntry);
    if (!this.youtube) throw new Error('YouTube API is unavailable for reconciliation');

    const channel = await this.youtube.channels.list({
      part: 'contentDetails',
      mine: true
    });
    const uploadsPlaylist = channel.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsPlaylist) throw new Error('Authenticated channel uploads playlist is unavailable');

    const recent = await this.youtube.playlistItems.list({
      part: 'snippet,contentDetails',
      playlistId: uploadsPlaylist,
      maxResults: 25
    });
    const expectedTitle = this.normalizeComparableTitle(scheduleEntry.metadata?.seo?.title || scheduleEntry.title);
    const matches = (recent.data.items || []).filter(item =>
      this.normalizeComparableTitle(item.snippet?.title) === expectedTitle
    );

    const state = scheduleEntry.metadata?.reconciliation || {};
    const firstSeenAt = state.firstSeenAt || new Date().toISOString();
    const checks = Number(state.checks || 0) + 1;
    scheduleEntry.metadata = {
      ...scheduleEntry.metadata,
      reconciliation: {
        ...state,
        firstSeenAt,
        checks,
        lastCheckedAt: new Date().toISOString()
      }
    };

    if (matches.length === 1) {
      const videoId = matches[0].contentDetails?.videoId || matches[0].snippet?.resourceId?.videoId;
      if (!videoId) throw new Error('Matched upload did not expose a video ID');
      scheduleEntry.youtubeId = videoId;
      scheduleEntry.youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
      scheduleEntry.error = null;
      await this.db.updateScheduleEntry(scheduleEntry);
      return this.reconcileUploadedVideo(scheduleEntry);
    }

    if (matches.length > 1) {
      scheduleEntry.error = 'Multiple recent uploads share the exact title; retry remains blocked to prevent duplicates';
      await this.db.updateScheduleEntry(scheduleEntry);
      throw new Error(scheduleEntry.error);
    }

    const ageMs = Date.now() - new Date(firstSeenAt).getTime();
    if (Number.isFinite(ageMs) && ageMs >= 60 * 60 * 1000 && checks >= 4) {
      scheduleEntry.status = 'scheduled';
      scheduleEntry.uploadAttempted = false;
      scheduleEntry.error = null;
      scheduleEntry.metadata.reconciliation.retryApprovedAt = new Date().toISOString();
      await this.db.updateScheduleEntry(scheduleEntry);
      this.logger.warn(`No matching YouTube upload was found after ${checks} checks; ${scheduleEntry.title} is eligible for one safe retry.`);
      return scheduleEntry;
    }

    scheduleEntry.status = 'reconciliation_required';
    scheduleEntry.error = 'No exact-title upload found yet; waiting for another automatic reconciliation check';
    await this.db.updateScheduleEntry(scheduleEntry);
    throw new Error(scheduleEntry.error);
  }

  async reconcileUploadedVideo(scheduleEntry) {
    const response = await this.youtube.videos.list({ part: 'id,status', id: scheduleEntry.youtubeId });
    const video = response.data.items?.find(item => item.id === scheduleEntry.youtubeId) || null;
    const uploadStatus = String(video?.status?.uploadStatus || '').toLowerCase();
    if (video && ['rejected', 'failed', 'deleted'].includes(uploadStatus)) {
      const reason = video.status?.rejectionReason || video.status?.failureReason || uploadStatus;
      scheduleEntry.status = 'failed';
      scheduleEntry.error = `YouTube ${uploadStatus} the upload: ${reason}`;
      await this.db.updateScheduleEntry(scheduleEntry);
      const error = new Error(scheduleEntry.error);
      error.status = 409;
      error.code = 'UPLOAD_REJECTED';
      throw error;
    }
    if (!video) {
      scheduleEntry.status = 'reconciliation_required';
      scheduleEntry.error = 'The recorded YouTube video ID could not be verified';
      await this.db.updateScheduleEntry(scheduleEntry);
      await this.alert({
        type: 'upload_outcome_unknown', level: 'error', title: 'Upload needs reconciliation',
        message: `${scheduleEntry.title || scheduleEntry.productionId}: the YouTube video ID could not be verified.`,
        data: { productionId: scheduleEntry.productionId }
      });
      const error = new Error('The recorded upload could not be verified on YouTube. Resolve it before attempting another upload.');
      error.status = 409;
      error.code = 'UPLOAD_OUTCOME_UNKNOWN';
      throw error;
    }
    scheduleEntry.status = 'published';
    scheduleEntry.publishedAt = scheduleEntry.publishedAt || new Date().toISOString();
    scheduleEntry.youtubeUrl = scheduleEntry.youtubeUrl || `https://www.youtube.com/watch?v=${scheduleEntry.youtubeId}`;
    scheduleEntry.error = null;
    await this.db.updateScheduleEntry(scheduleEntry);
    this.publishQueue = this.publishQueue.filter(entry => entry.productionId !== scheduleEntry.productionId);
    this.logger.success(`Reconciled existing YouTube upload: ${scheduleEntry.youtubeUrl}`);
    return scheduleEntry;
  }

  async getVideoStream(videoPath) {
    try {
      const stats = await fs.stat(videoPath);
      if (!stats.isFile() || path.extname(videoPath).toLowerCase() !== '.mp4') {
        throw new Error('placeholder asset');
      }

      return fsSync.createReadStream(videoPath);
    } catch (error) {
      throw new Error('video file not found — refusing to upload placeholder');
    }
  }
  // YouTube can answer "not properly authorized" for a thumbnail set right after the upload (seen on the VM: 2 of 7 uploads, the same call
  // worked 20 s later), so it is retried a few times before it is given up (the upload itself never fails because of it).
  async uploadThumbnail(videoId, thumbnailPath) {
    const attempts = Math.max(1, Number(this.thumbnailAttempts || 4));
    const delayMs = this.thumbnailRetryDelayMs ?? 20000;
    let thumbnailBuffer;
    try {
      thumbnailBuffer = await fs.readFile(thumbnailPath);
    } catch (error) {
      this.logger.error(`Failed to upload thumbnail: ${error.message}`);
      return;
    }
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.youtube.thumbnails.set({ videoId: videoId, media: { body: thumbnailBuffer } });
        this.logger.info(`Thumbnail uploaded for video: ${videoId}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
        return;
      } catch (error) {
        if (attempt === attempts) {
          this.logger.error(`Failed to upload thumbnail: ${error.message}`);
        } else {
          this.logger.warn(`Thumbnail attempt ${attempt} failed (${error.message}); retrying in ${Math.round(delayMs / 1000)}s`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    }
  }

  async applyVideoPackaging(videoId, packaging = {}, previousPackaging = null) {
    const title = String(packaging.title || '').trim();
    if (!videoId || !title || title.length > 100 || !packaging.thumbnailPath) {
      const error = new Error('A valid video ID, title, and thumbnail are required for a packaging change');
      error.status = 400;
      error.code = 'PACKAGING_INVALID';
      throw error;
    }
    const thumbnail = await fs.readFile(packaging.thumbnailPath);
    const current = await this.youtube.videos.list({ part: 'snippet', id: videoId });
    const snippet = current.data.items?.[0]?.snippet;
    if (!snippet) {
      const error = new Error(`YouTube video not found: ${videoId}`);
      error.status = 404;
      error.code = 'PACKAGING_VIDEO_NOT_FOUND';
      throw error;
    }

    const updateTitle = async nextTitle => this.youtube.videos.update({
      part: 'snippet',
      requestBody: {
        id: videoId,
        snippet: {
          title: nextTitle,
          description: snippet.description || '',
          tags: snippet.tags || [],
          categoryId: snippet.categoryId || '22',
          defaultLanguage: snippet.defaultLanguage,
          defaultAudioLanguage: snippet.defaultAudioLanguage
        }
      }
    });

    await updateTitle(title);
    try {
      await this.youtube.thumbnails.set({
        videoId,
        media: { body: thumbnail }
      });
    } catch (error) {
      try {
        await updateTitle(String(previousPackaging?.title || snippet.title || '').trim());
      } catch (rollbackError) {
        error.message = `${error.message}; title rollback also failed: ${rollbackError.message}`;
      }
      throw error;
    }
    this.logger.info(`Applied approved growth-experiment packaging to video: ${videoId}`);
    return { videoId, title, thumbnailPath: packaging.thumbnailPath };
  }

  async uploadCaptions(videoId, captionsPath) {
    try {
      const captionsContent = await fs.readFile(captionsPath, 'utf8');
      
      await this.youtube.captions.insert({
        part: 'snippet',
        requestBody: {
          snippet: {
            videoId: videoId,
            language: 'en',
            name: 'English Captions',
            isDraft: false
          }
        },
        media: {
          body: captionsContent
        }
      });
      
      this.logger.info(`Captions uploaded for video: ${videoId}`);
    } catch (error) {
      this.logger.error(`Failed to upload captions: ${error.message}`);
    }
  }

  async processPublishQueue() {
    const now = new Date();

    // 'uploaded' is the moment between videos.insert and the final 'published' write; if the process died there the
    // entry has a YouTube id and only needs verifying. Skip entries whose upload is still running in this process.
    const inFlight = this.uploadsInFlight || new Set();
    const uncertain = this.publishQueue.filter(entry =>
      ['uploading', 'reconciliation_required'].includes(entry.status) ||
      (entry.status === 'uploaded' && entry.youtubeId && !inFlight.has(String(entry.productionId)) && !inFlight.has(String(entry.id)))
    );
    for (const entry of uncertain) {
      try {
        await this.reconcileUnknownUpload(entry);
      } catch (error) {
        this.logger.warn(`Automatic upload reconciliation is still pending for ${entry.title}: ${error.message}`);
      }
    }

    try {
      const revived = await this.reviveAuthFailures();
      if (revived) this.logger.info(`Re-queued ${revived} Short(s) that failed only because of an expired YouTube login`);
    } catch (error) {
      this.logger.warn(`Could not re-queue auth-failed Shorts: ${error.message}`);
    }

    const scheduled = this.publishQueue
      .filter(entry => entry.status === 'scheduled' && this.normalizePublishTime(entry.publishTime))
      .sort((a, b) => new Date(a.publishTime) - new Date(b.publishTime));
    const readyToPublish = scheduled.filter(entry => new Date(entry.publishTime) <= now);

    if (readyToPublish.length === 0) {
      if (scheduled.length > 0) {
        this.logger.info(`Publish queue: ${scheduled.length} item(s) waiting, next publish at ${scheduled[0].publishTime}`);
      } else {
        this.logger.info('Publish queue is empty — nothing scheduled yet.');
      }
      return 0;
    }

    this.logger.info(`Processing publish queue: ${readyToPublish.length} item(s) ready to publish...`);

    let publishedCount = 0;
    for (const entry of readyToPublish) {
      try {
        await this.publishContent(entry.productionId);
        publishedCount++;
        this.logger.info(`Auto-published: ${entry.title}`);
      } catch (error) {
        if (['READINESS_BLOCKED', 'APPROVAL_REQUIRED', 'PROVENANCE_BLOCKED', 'NARRATION_REQUIRED', 'UPLOAD_DISABLED', 'PRE_UPLOAD_QA_FAILED', 'UPLOAD_REJECTED', 'AUTH_REQUIRED'].includes(error.code) || error.retryScheduled) {
          this.logger.warn(error.message);
          continue;
        }
        this.logger.error(`Failed to auto-publish ${entry.title}:`, error);
        // Mark as failed but don't stop processing other items
        if (error.code !== 'UPLOAD_OUTCOME_UNKNOWN') {
          entry.status = 'failed';
          entry.error = error.message;
          await this.db.updateScheduleEntry(entry);
        }
      }
    }
    
    return publishedCount;
  }

  async getUpcomingSchedule(days = 7) {
    const now = new Date();
    const endDate = new Date(now.getTime() + (days * 24 * 60 * 60 * 1000));
    
    return this.publishQueue
      .filter(entry => {
        const normalized = this.normalizePublishTime(entry.publishTime);
        if (!normalized) return false;
        const publishTime = new Date(normalized);
        return publishTime >= now && publishTime <= endDate;
      })
      .sort((a, b) => new Date(a.publishTime) - new Date(b.publishTime));
  }

  async optimizePublishTimes() {
    const audienceTiming = await this.getAudienceTimingEvidence();
    const scheduled = this.publishQueue.filter(entry => entry.status === 'scheduled');

    if (!audienceTiming.available) {
      this.logger.info('Publish-time optimization skipped: no real audience timing evidence is available.');
      return {
        changed: 0,
        evaluated: scheduled.length,
        status: 'insufficient_evidence',
        reason: audienceTiming.reason
      };
    }

    this.logger.info('Audience timing evidence is available. Existing schedules remain unchanged until an explicit reschedule decision is approved.');
    return {
      changed: 0,
      evaluated: scheduled.length,
      status: 'advisory_only',
      audienceTiming
    };
  }

  async getAudienceTimingEvidence() {
    if (this.db.getSetting) {
      const stored = await this.db.getSetting('youtube_audience_timing');
      if (stored) {
        try {
          const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
          if (Array.isArray(parsed?.windows) && parsed.windows.length > 0) {
            return {
              available: true,
              source: parsed.source || 'operator_supplied_youtube_analytics',
              measuredAt: parsed.measuredAt || null,
              windows: parsed.windows
            };
          }
        } catch (_error) {
          this.logger.warn('Stored audience timing evidence is invalid and will be ignored');
        }
      }
    }

    return {
      available: false,
      source: null,
      measuredAt: null,
      windows: [],
      reason: 'YouTube does not provide a universal best publish time; use real channel Audience analytics before changing schedules.'
    };
  }

  async emergencyPublish(contentId, delayMinutes = 0) {
    // For urgent publishing needs
    this.logger.info(`Emergency publish requested: ${contentId}`);

    if (delayMinutes > 0) {
      const entry = this.publishQueue.find(e => e.productionId === contentId || e.id === contentId) ||
        await this.db.getLatestScheduleEntry?.(contentId);
      if (!entry) throw new Error(`Content not found: ${contentId}`);
      const newPublishTime = new Date(Date.now() + (delayMinutes * 60 * 1000));
      entry.publishTime = newPublishTime.toISOString();
      await this.db.updateScheduleEntry(entry);
      this.logger.info(`Emergency scheduled for: ${entry.publishTime}`);
      return entry;
    }
    return this.publishContent(contentId, { publishNow: true });
  }

  async rescheduleContent(contentId, newPublishTime) {
    const publishTime = new Date(newPublishTime);
    if (!Number.isFinite(publishTime.getTime()) || publishTime.getTime() <= Date.now()) {
      const error = new Error('Choose a future publish time');
      error.status = 400;
      throw error;
    }
    const entry = this.publishQueue.find(item => item.productionId === contentId || item.id === contentId) ||
      await this.db.getLatestScheduleEntry?.(contentId);
    if (!entry) {
      const error = new Error(`Scheduled content not found: ${contentId}`);
      error.status = 404;
      throw error;
    }
    if (['uploading', 'uploaded', 'published', 'reconciliation_required'].includes(entry.status)) {
      const error = new Error(`Content cannot be rescheduled while it is ${entry.status}`);
      error.status = 409;
      throw error;
    }
    await this.assertPublishingCadence(
      publishTime.toISOString(),
      this.scheduleContentType(entry),
      entry.id
    );
    entry.publishTime = publishTime.toISOString();
    entry.status = 'scheduled';
    entry.error = null;
    await this.db.updateScheduleEntry(entry);
    if (!this.publishQueue.some(item => item.id === entry.id)) this.publishQueue.push(entry);
    this.sortPublishQueue();
    return entry;
  }

  async deleteScheduledContent(contentId) {
    const entry = this.publishQueue.find(item => item.productionId === contentId || item.id === contentId) ||
      await this.db.getLatestScheduleEntry?.(contentId);
    if (!entry) {
      const error = new Error(`Scheduled content not found: ${contentId}`);
      error.status = 404;
      throw error;
    }
    if (['uploading', 'uploaded', 'published', 'reconciliation_required'].includes(entry.status)) {
      const error = new Error(`The schedule cannot be deleted while content is ${entry.status}`);
      error.status = 409;
      throw error;
    }
    await this.db.deleteScheduleEntry(entry.id);
    this.publishQueue = this.publishQueue.filter(item => item.id !== entry.id);
    return entry;
  }
}

module.exports = { PublishingSchedulingAgent };
