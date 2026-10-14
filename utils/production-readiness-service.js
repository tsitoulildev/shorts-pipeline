const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { AITextService } = require('./ai-text-service');
const { LocalTts } = require('./local-tts');
const { checkFFmpeg, runFFmpeg } = require('./ffmpeg');
const { validateYouTubeMetadata } = require('./youtube-metadata-validator');
const { Logger } = require('./logger');
const { assertExpectedChannel } = require('./youtube-channel-guard');
const { makeNarrator } = require('./dark-history/narration');
const { renderStill, renderThumbnail, subtitleFilter } = require('./dark-history/documentary-render');
const { defaultHttp } = require('./dark-history/http');

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

class ProductionReadinessService {
  constructor(db, credentialManager, options = {}) {
    this.db = db;
    this.credentialManager = credentialManager;
    this.logger = options.logger || new Logger('ProductionReadiness');
    this.probes = options.probes || {};
    this.now = options.now || (() => new Date());
    this.transientRetryDelayMs = options.transientRetryDelayMs ?? 20000;
    this.activeRun = null;
  }

  async getSummary() {
    const latest = await this.db.getLatestReadinessRun();
    if (!latest) {
      return {
        status: 'unverified',
        stale: false,
        blockingFailures: [],
        checks: [],
        message: 'Run the verified readiness check before relying on autonomous production.'
      };
    }
    const age = this.now().getTime() - new Date(latest.completed_at || latest.created_at).getTime();
    return {
      ...latest,
      stale: age > STALE_AFTER_MS,
      blockingFailures: latest.checks.filter(check => check.blocking && check.status === 'failed').map(check => check.id)
    };
  }

  async assertReady(action) {
    const summary = await this.getSummary();
    const usableStatus = ['passed', 'warning'].includes(summary.status);
    const blocked = !usableStatus || summary.stale === true;
    if (blocked) {
      const reason = summary.status === 'unverified'
        ? 'no verified readiness run exists'
        : summary.stale
          ? 'the latest readiness run is older than 24 hours'
          : summary.blockingFailures.length
            ? `blocking checks failed: ${summary.blockingFailures.join(', ')}`
            : `readiness status is ${summary.status}`;
      const error = new Error(`${action} is blocked by the production readiness gate because ${reason}. Run the verified readiness check again.`);
      error.status = 409;
      error.code = 'READINESS_BLOCKED';
      error.readiness = summary;
      throw error;
    }
    return summary;
  }

  async run(options = {}) {
    if (this.activeRun) {
      const error = new Error('A production readiness check is already running');
      error.status = 409;
      throw error;
    }

    this.activeRun = this.executeRun(options).finally(() => {
      this.activeRun = null;
    });
    return this.activeRun;
  }

  async executeRun(_options) {
    const startedAt = this.now().toISOString();
    const id = this.db.generateId ? this.db.generateId('readiness') : `readiness_${Date.now()}`;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-readiness-'));
    const checks = [];

    try {
      checks.push(await this.executeCheck('text_provider', 'AI text provider', true, () => this.probeText()));
      // The media and voice checks prove what the documentary path really uses (Wikimedia pictures, FFmpeg, a local public-domain voice).
      checks.push(await this.executeCheck('image_provider', 'Documentary render (Wikimedia, real-image video, captions, thumbnail)', true, () => this.probeDocumentary(tempDir)));
      checks.push(await this.executeCheck('voice_narration', 'Voice narration (public-domain local voice)', true, () => this.probeDocumentaryNarration(tempDir)));
      checks.push(await this.executeCheck('video_assembly', 'Audio/video assembly', true, () => this.probeVideoAssembly(tempDir)));
      checks.push(await this.executeCheck('youtube_access', 'YouTube channel access', true, () => this.probeYouTube()));
      checks.push(await this.executeCheck('upload_metadata', 'Upload metadata', true, () => this.probeMetadata()));

      const blockingFailures = checks.filter(check => check.blocking && check.status === 'failed');
      const warnings = checks.filter(check =>
        ['warning', 'skipped'].includes(check.status) || (!check.blocking && check.status === 'failed')
      );
      const status = blockingFailures.length ? 'failed' : warnings.length ? 'warning' : 'passed';
      const completedAt = this.now().toISOString();
      const result = {
        id,
        status,
        checks,
        summary: {
          passed: checks.filter(check => check.status === 'passed').length,
          warnings: warnings.length,
          failed: checks.filter(check => check.status === 'failed').length,
          blockingFailures: blockingFailures.map(check => check.id)
        },
        startedAt,
        completedAt
      };
      await this.db.saveReadinessRun(result);
      return { ...result, stale: false, blockingFailures: result.summary.blockingFailures };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async executeCheck(id, label, blocking, probe) {
    const started = Date.now();
    try {
      let result;
      try {
        result = await probe();
      } catch (firstError) {
        // One delayed retry for transient provider errors only (429/503/timeout).
        // A second failure is still a failure: the gate is not loosened.
        if (!/\b(429|503|502|504)\b|rate.?limit|quota|timeout|timed out|ETIMEDOUT|ECONNRESET|overloaded/i.test(String(firstError && firstError.message))) throw firstError;
        this.logger.warn(`${label} readiness probe hit a transient error, retrying once: ${this.safeError(firstError)}`);
        await new Promise(resolve => setTimeout(resolve, this.transientRetryDelayMs ?? 20000));
        result = await probe();
      }
      return {
        id,
        label,
        blocking,
        status: result.status || 'passed',
        message: result.message,
        remediation: result.remediation || null,
        details: result.details || {},
        durationMs: Date.now() - started
      };
    } catch (error) {
      const safeMessage = this.safeError(error);
      this.logger.warn(`${label} readiness probe failed: ${safeMessage}`);
      return {
        id,
        label,
        blocking,
        status: 'failed',
        message: safeMessage,
        remediation: this.remediationFor(id),
        details: {},
        durationMs: Date.now() - started
      };
    }
  }

  async probeText() {
    if (this.probes.text) return this.probes.text();
    const service = new AITextService(this.credentialManager.credentials || {});
    if (!service.isAvailable()) throw new Error('No AI text provider is configured');
    const response = await service.generateText('Reply with exactly READY.', {
      task: 'probe',
      maxTokens: 128,
      temperature: 0,
      thinkingLevel: 'low'
    });
    return { message: `${service.providerName} returned a live response.`, details: { provider: service.providerName, responseReceived: Boolean(response) } };
  }

  async probeDocumentary(tempDir) {
    if (this.probes.documentary) return this.probes.documentary({ tempDir });
    await defaultHttp.getJson('https://en.wikipedia.org/w/api.php', { action: 'query', meta: 'siteinfo', format: 'json' });
    const image = path.join(tempDir, 'probe.png');
    await runFFmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc2=s=1200x800:d=1,format=rgb24', '-frames:v', '1', '-update', '1', image]);
    const clip = await renderStill(image, 1, 'zoom-in', path.join(tempDir, 'probe.mp4'), { size: { width: 1200, height: 800 } });
    await renderThumbnail({ imagePath: image, title: 'Readiness check', outPath: path.join(tempDir, 'probe-thumb.jpg') });
    const srt = path.join(tempDir, 'probe.srt');
    await fs.writeFile(srt, '1\n00:00:00,000 --> 00:00:01,000\nREADY\n');
    await runFFmpeg(['-y', '-i', clip, '-vf', subtitleFilter(srt), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(tempDir, 'probe-captions.mp4')]);
    return { message: 'Wikimedia answered and FFmpeg made a real-image clip, burned captions and a thumbnail.' };
  }

  async probeDocumentaryNarration(tempDir) {
    if (this.probes.narration) return this.probes.narration({ tempDir });
    const narrate = makeNarrator({ generator: new LocalTts() });
    const outputPath = path.join(tempDir, 'readiness-narration.mp3');
    await narrate('Production readiness audio check.', outputPath);
    const stats = await fs.stat(outputPath);
    if (stats.size < 100) throw new Error('The local public-domain voice returned an empty audio file');
    return { message: 'The local public-domain voice produced a narration sample.', details: { bytes: stats.size } };
  }

  async probeVideoAssembly(tempDir) {
    if (this.probes.videoAssembly) return this.probes.videoAssembly({ tempDir });
    if (!await checkFFmpeg()) throw new Error('FFmpeg is not available');
    const outputPath = path.join(tempDir, 'readiness-av.mp4');
    await runFFmpeg([
      '-y', '-f', 'lavfi', '-i', 'color=c=0x111827:s=320x180:d=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', outputPath
    ]);
    const buffer = await fs.readFile(outputPath);
    if (buffer.length < 1000 || buffer.subarray(4, 12).toString('ascii').indexOf('ftyp') === -1) {
      throw new Error('FFmpeg did not produce a valid MP4 container');
    }
    await runFFmpeg(['-v', 'error', '-i', outputPath, '-f', 'null', '-']);
    return { message: 'FFmpeg created and decoded a local MP4 containing audio and video.', details: { bytes: buffer.length } };
  }

  async probeYouTube() {
    if (this.probes.youtube) return this.probes.youtube();
    const youtube = this.credentialManager.getYouTubeClient();
    const response = await youtube.channels.list({ part: 'snippet,status', mine: true, maxResults: 1 });
    const channel = response.data?.items?.[0];
    if (!channel) throw new Error('The authorized Google account does not expose a YouTube channel');
    // A valid login is not proof that uploads go to the right channel (the token follows the Google account).
    assertExpectedChannel(channel);
    return {
      message: `Authorized channel access verified for ${channel.snippet?.title || 'the connected channel'}.`,
      details: { channelId: channel.id, channelTitle: channel.snippet?.title || null }
    };
  }

  async probeMetadata() {
    if (this.probes.metadata) return this.probes.metadata();
    const queue = await this.db.getPublishQueue();
    const candidates = queue.length ? queue : [{ title: 'Production readiness test', metadata: { seo: { title: 'Production readiness test', description: 'A safe local metadata validation sample for YouTube upload readiness.', tags: ['readiness', 'youtube', 'automation'], metadata: { category: 22, language: 'en' } } } }];
    const invalid = [];
    let warnings = 0;
    for (const item of candidates) {
      const result = validateYouTubeMetadata(item.metadata?.seo || item.metadata || { title: item.title });
      warnings += result.warnings.length;
      if (!result.valid) invalid.push({ productionId: item.productionId || null, title: item.title, errors: result.errors });
    }
    if (invalid.length) {
      const error = new Error(`${invalid.length} queued upload(s) have invalid YouTube metadata`);
      error.invalid = invalid;
      throw error;
    }
    return {
      status: warnings ? 'warning' : 'passed',
      message: queue.length ? `${queue.length} queued upload(s) passed metadata validation.` : 'Metadata rules passed with a safe local sample.',
      remediation: warnings ? 'Review queued descriptions and tags before publishing.' : null,
      details: { validated: candidates.length, queued: queue.length, warnings }
    };
  }

  safeError(error) {
    return String(error?.message || 'Probe failed')
      .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
      .replace(/AIza[A-Za-z0-9_-]+/g, '[redacted]')
      .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
      .replace(/(access_token|refresh_token|api[_-]?key|token)=([^\s&]+)/gi, '$1=[redacted]')
      .slice(0, 500);
  }

  remediationFor(id) {
    const messages = {
      text_provider: 'Run npm run walkthrough, verify the selected model, and confirm provider credits or quota.',
      image_provider: 'Check that Wikimedia answers and that FFmpeg (the system build with drawtext) can render a clip, captions and a thumbnail, then rerun.',
      voice_narration: 'Check LOCAL_TTS_COMMAND (the Piper command and its public-domain voice), then rerun.',
      video_assembly: 'Run npm install to restore ffmpeg-static, or configure FFMPEG_PATH to a working binary.',
      youtube_access: 'Reconnect YouTube in npm run walkthrough and ensure the Google account owns a channel.',
      upload_metadata: 'Edit the queued title, description, category, language, and tags before publishing.'
    };
    return messages[id] || 'Correct the configuration and rerun the readiness check.';
  }
}

module.exports = { ProductionReadinessService, STALE_AFTER_MS };
