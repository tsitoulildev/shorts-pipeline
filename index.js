require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const { Logger } = require('./utils/logger');
const { installProcessGuards } = require('./utils/process-guards');
const { Database } = require('./database/db');
const { CredentialManager } = require('./utils/credential-manager');
const { ContentStrategyAgent } = require('./agents/content-strategy-agent');
const { ScriptWriterAgent } = require('./agents/script-writer-agent');
const { ThumbnailDesignerAgent } = require('./agents/thumbnail-designer-agent');
const { SEOOptimizerAgent } = require('./agents/seo-optimizer-agent');
const { ProductionManagementAgent } = require('./agents/production-management-agent');
const { PublishingSchedulingAgent } = require('./agents/publishing-scheduling-agent');
const { AnalyticsOptimizationAgent } = require('./agents/analytics-optimization-agent');
const { DailyAutomation } = require('./schedules/daily-automation');
const { OperatorService } = require('./utils/operator-service');
const { reviewScript, reviewedScriptLoop } = require('./utils/creative-review');
const { AutonomousChannelOperator } = require('./utils/autonomous-channel-operator');
const { ProductionReadinessService } = require('./utils/production-readiness-service');
const { GenerationRecoveryService, GENERATION_STAGES } = require('./utils/generation-recovery-service');
const { ProvenanceService } = require('./utils/provenance-service');
const { SceneRepairService } = require('./utils/scene-repair-service');
const { AudienceEngagementService } = require('./utils/audience-engagement-service');
const { GrowthExperimentService } = require('./utils/growth-experiment-service');
const { AITextService } = require('./utils/ai-text-service');
const { AgentContractService } = require('./utils/agent-contract-service');
const { DiscoverabilityService } = require('./utils/discoverability-service');
const { resolveControlState, publicationState, recordUploadAuthorization } = require('./utils/publishing-policy');
const { isLive, isDocumentary, produceFromPool, releaseAfterFailure, PIPELINE: DOCUMENTARY_PIPELINE } = require('./utils/dark-history/live');
const { StoryPool } = require('./utils/dark-history/story-pool');
const { version } = require('./package.json');
const channelIdentity = require('./utils/channel-identity');
const chalk = require('chalk');

class YouTubeAutomationAgent {
  constructor() {
    this.logger = new Logger('MainAgent');
    this.db = null;
    this.credentials = null;
    this.agents = {};
    this.app = express();
    this.isInitialized = false;
    this.activeJobs = new Map();
    this.jobAbortControllers = new Map();
    this.operator = null;
    this.autonomous = null;
    this.readiness = null;
    this.recovery = null;
    this.provenance = null;
    this.scenes = null;
    this.engagement = null;
    this.experiments = null;
    this.discoverability = null;
    this.agentContracts = new AgentContractService({ logger: this.logger });
    this.setupRequired = false;
  }

  async initialize() {
    try {
      console.log(chalk.cyan.bold(`\n🎬 YouTube Automation Agent v${version}`));
      console.log(chalk.gray('─'.repeat(50)));
      
      // Initialize database
      this.logger.info('Initializing database...');
      this.db = new Database();
      await this.db.initialize();
      await this.db.markInterruptedJobs();
      await this.releaseInterruptedDocumentaryJobs();
      // Shorts produced before the evidence-based QA gates existed carry no such evidence.
      // Mark the upgrade moment once; the gates are strict for everything created after it.
      if (!await this.db.getSetting('qa_evidence_gates_since')) {
        await this.db.setSetting(
          'qa_evidence_gates_since',
          new Date().toISOString(),
          'Productions created before this time predate the audio_mix, character, variety and creative_review evidence gates'
        );
      }
      this.recovery = new GenerationRecoveryService(this.db, {
        logger: this.logger,
        updateJobStage: (...args) => this.updateJobStage(...args)
      });
      this.operator = new OperatorService(this.db);
      this.provenance = new ProvenanceService(this.db);
      this.discoverability = new DiscoverabilityService(this.db, { logger: this.logger });
      this.autonomous = new AutonomousChannelOperator(this.db, {
        researchAndPlan: strategy => {
          if (!this.agents.strategy) throw new Error('The strategy agent is not configured');
          return this.agents.strategy.researchAndPlanChannel(strategy);
        },
        startGenerationJob: input => this.startGenerationJob(input),
        resumeGenerationJob: (jobId, options) => this.resumeGenerationJob(jobId, options),
        waitForGenerationJob: jobId => this.waitForGenerationJob(jobId),
        cancelGenerationJob: (jobId, reason) => this.cancelGenerationJob(jobId, reason),
        notify: notification => this.operator.notify(notification),
        isAutomationPaused: async () => (await resolveControlState(this.db)).automationPaused,
        requiresHumanApproval: async () => (await resolveControlState(this.db)).approvalRequired
      });
      
      // Load credentials
      this.logger.info('Loading credentials...');
      this.credentials = new CredentialManager();
      const credentialsValid = await this.credentials.validateAll();
      this.readiness = new ProductionReadinessService(this.db, this.credentials);
      
      if (!credentialsValid) {
        console.log(chalk.yellow('\n⚠️  Some credentials are missing or invalid.'));
        console.log(chalk.yellow('Run: npm run credentials:setup'));
        this.setupRequired = true;
        this.setupAPI();
        this.isInitialized = true;
        this.logger.warn('Dashboard started in setup mode; generation and publishing are disabled');
        return true;
      }
      
      // Initialize agents
      this.logger.info('Initializing agents...');
      await this.initializeAgents();
      this.scenes = this.agents.production?.sceneRepair || new SceneRepairService(
        this.db,
        this.agents.production?.aiVideoGenerator,
        { logger: this.logger }
      );
      this.engagement = new AudienceEngagementService(
        this.db,
        this.credentials,
        new AITextService(this.credentials?.credentials || {}),
        { logger: this.logger }
      );
      this.experiments = new GrowthExperimentService(
        this.db,
        this.agents.analytics,
        this.agents.publishing,
        { logger: this.logger }
      );

      // Show which pipeline stages will run for real vs. be simulated
      await this.logCapabilitySummary();
      
      // Setup API endpoints
      this.setupAPI();
      
      // Initialize scheduler
      this.logger.info('Setting up automation scheduler...');
      this.scheduler = new DailyAutomation(this.agents, this.db, {
        generateContent: input => this.queueScheduledContent(input),
        engagement: this.engagement,
        experiments: this.experiments,
        readiness: this.readiness,
        notify: notification => this.operator.notify(notification)
      });
      await this.scheduler.initialize();

      const control = await resolveControlState(this.db);
      if (control.automationPaused) {
        await this.scheduler.pauseAutomation();
      }
      await this.recordUploadAuthorizationState(control);
      this.logger.info(
        `Control state: ${control.mode} | autonomous=${control.autonomousMode} uploads=${control.uploadState} ` +
        `approvalRequired=${control.approvalRequired} (${control.sources.approvalRequired}) ` +
        `paused=${control.automationPaused} (${control.sources.automationPaused})`
      );
      if (!control.automationPaused) {
        await this.resumeInterruptedAutonomousWork('startup');
      }
      
      this.isInitialized = true;
      this.logger.success('YouTube Automation Agent initialized successfully!');
      
      return true;
    } catch (error) {
      this.logger.error('Failed to initialize:', error);
      return false;
    }
  }

  async initializeAgents() {
    this.agents = {
      strategy: new ContentStrategyAgent(this.db, this.credentials),
      scriptWriter: new ScriptWriterAgent(this.db, this.credentials),
      thumbnailDesigner: new ThumbnailDesignerAgent(this.db, this.credentials),
      seoOptimizer: new SEOOptimizerAgent(this.db, this.credentials),
      production: new ProductionManagementAgent(this.db, this.credentials),
      publishing: new PublishingSchedulingAgent(this.db, this.credentials),
      analytics: new AnalyticsOptimizationAgent(this.db, this.credentials)
    };

    // Initialize each agent
    for (const [name, agent] of Object.entries(this.agents)) {
      await agent.initialize();
      this.logger.info(`✓ ${name} agent initialized`);
    }

    // Every upload re-runs the full QA suite on the real files first.
    this.agents.publishing.preUploadVerifier = bundle => this.verifyBeforeUpload(bundle);
    this.agents.publishing.notify = notification => this.operator.notify(notification);

    // Fail closed if any required agent or inter-agent method is missing.
    this.agentContracts.validateAgentRegistry(this.agents);
    this.logger.info(`✓ agent communication registry contract v${this.agentContracts.version}`);
  }

  async logCapabilitySummary() {
    const { checkFFmpeg, ffmpegInstallHint } = require('./utils/ffmpeg');
    const creds = this.credentials.credentials || {};

    const hasText = this.credentials.hasAITextProvider();
    const hasGemini = Boolean(creds.gemini?.apiKey || process.env.GEMINI_API_KEY);
    const freeMediaOnly = !/^(0|false|no)$/i.test(String(process.env.FREE_MEDIA_ONLY || 'true'));
    const hasSyntheticImages = hasGemini || (!freeMediaOnly && Boolean(creds.openai?.apiKey || process.env.OPENAI_API_KEY));
    const hasTTS = Boolean(
      creds.openai?.apiKey || process.env.OPENAI_API_KEY ||
      creds.elevenLabs?.apiKey || process.env.ELEVENLABS_API_KEY ||
      hasGemini
    );
    const hasFFmpeg = await checkFFmpeg();
    const hasUpload = Boolean(creds.youtube && this.credentials.tokens?.youtube);

    const capabilities = [
      { name: 'Script & strategy generation', ok: hasText, hint: 'configure an AI text provider (OpenRouter or Gemini supported)' },
      { name: 'Dark Stickman image generation', ok: hasSyntheticImages, hint: 'configure Gemini image generation for free-only synthetic scene production' },
      { name: 'First-frame packaging', ok: hasSyntheticImages && hasFFmpeg, hint: 'requires generated Dark Stickman frames and FFmpeg' },
      { name: 'Voice narration (TTS)', ok: hasTTS, hint: 'configure a live narration provider; silent fallback is not accepted' },
      { name: 'Video assembly (FFmpeg)', ok: hasFFmpeg, hint: ffmpegInstallHint() },
      { name: 'YouTube channel access', ok: hasUpload, hint: 'run: npm run credentials:setup' }
    ];

    console.log(chalk.cyan('\n🔎 Capability check:'));
    for (const cap of capabilities) {
      if (cap.ok) {
        console.log(chalk.green(`  ✓ ${cap.name}`));
      } else {
        console.log(chalk.yellow(`  ✗ ${cap.name} — ${cap.hint}`));
      }
    }

    if (!hasFFmpeg) {
      this.logger.warn('FFmpeg is missing: no .mp4 files can be produced until it is installed.');
    }
    console.log('');
    return { hasText, hasSyntheticImages, hasDocumentaryMedia: hasSyntheticImages, hasTTS, hasFFmpeg, hasUpload, freeMediaOnly };
  }

  requireAPIKey() {
    return (req, res, next) => {
      if (!process.env.API_KEY || process.env.API_KEY === 'change-me-before-start') {
        return res.status(503).json({ success: false, error: 'API_KEY must be configured before using operational API routes' });
      }

      if (req.get('x-api-key') !== process.env.API_KEY) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }

      return next();
    };
  }

  validateGenerateRequestBody(body = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { valid: false, status: 400, error: 'Request body must be a JSON object' };
    }

    const value = {
      topic: null,
      style: null,
      length: typeof body.length === 'string' ? body.length.toLowerCase() : 'short',
      strategyContext: null
    };

    // JSON has no `undefined`, so clients send `null` to mean "no value provided".
    // Both are treated as "not set" here: topic/style are optional and default to
    // auto-selection, which is exactly what `null` already represents internally.
    if (body.topic !== undefined && body.topic !== null) {
      if (typeof body.topic !== 'string') {
        return { valid: false, status: 400, error: 'topic must be a string' };
      }

      const topic = body.topic.trim();
      if (topic.length > 200) {
        return { valid: false, status: 400, error: 'topic must be 200 characters or less' };
      }
      value.topic = topic || null;
    }

    if (body.style !== undefined && body.style !== null) {
      if (typeof body.style !== 'string') {
        return { valid: false, status: 400, error: 'style must be a string' };
      }

      const allowedStyles = new Set([
        'tutorial',
        'explainer',
        'list',
        'review',
        'story',
        'educational',
        'informative',
        'engaging',
        'professional',
        'ethereal'
      ]);
      const style = body.style.trim();

      if (style.length > 50) {
        return { valid: false, status: 400, error: 'style must be 50 characters or less' };
      }

      value.style = allowedStyles.has(style.toLowerCase()) ? style.toLowerCase() : style || null;
    }

    if (!['short', 'medium', 'long'].includes(value.length)) {
      return { valid: false, status: 400, error: 'length must be short, medium, or long' };
    }

    if (body.strategyContext !== undefined && body.strategyContext !== null) {
      if (typeof body.strategyContext !== 'object' || Array.isArray(body.strategyContext)) {
        return { valid: false, status: 400, error: 'strategyContext must be an object' };
      }
      const limits = { angle: 500, rationale: 1000, audience: 500, objective: 1000, valueProposition: 1000, constraints: 2000, pillar: 100 };
      value.strategyContext = {};
      for (const [key, max] of Object.entries(limits)) {
        if (body.strategyContext[key] === undefined || body.strategyContext[key] === null) continue;
        if (typeof body.strategyContext[key] !== 'string' || body.strategyContext[key].length > max) {
          return { valid: false, status: 400, error: `strategyContext.${key} must be a string of ${max} characters or less` };
        }
        value.strategyContext[key] = body.strategyContext[key].trim();
      }

      if (body.strategyContext.researchSources !== undefined) {
        if (!Array.isArray(body.strategyContext.researchSources)) {
          return { valid: false, status: 400, error: 'strategyContext.researchSources must be an array' };
        }
        if (body.strategyContext.researchSources.length > 30) {
          return { valid: false, status: 400, error: 'strategyContext.researchSources supports at most 30 sources' };
        }
        const sources = [];
        for (const [index, source] of body.strategyContext.researchSources.entries()) {
          if (!source || typeof source !== 'object' || Array.isArray(source)) {
            return { valid: false, status: 400, error: `strategyContext.researchSources[${index}] must be an object` };
          }
          let parsed;
          try {
            parsed = new URL(String(source.url || '').trim());
          } catch (_error) {
            return { valid: false, status: 400, error: `strategyContext.researchSources[${index}].url must be a valid URL` };
          }
          if (!['http:', 'https:'].includes(parsed.protocol)) {
            return { valid: false, status: 400, error: `strategyContext.researchSources[${index}].url must use http or https` };
          }
          sources.push({
            url: parsed.toString(),
            title: String(source.title || '').trim().slice(0, 300),
            publisher: String(source.publisher || '').trim().slice(0, 200),
            publishedAt: source.publishedAt || null,
            sourceType: String(source.sourceType || 'other').trim().slice(0, 30)
          });
        }
        value.strategyContext.researchSources = sources;
      }
    }

    return { valid: true, value };
  }

  validateChannelStrategy(body = {}, current = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('Channel strategy must be a JSON object');
    }
    const text = (key, fallback, max) => {
      const value = String(body[key] ?? fallback ?? '').trim();
      if (value.length > max) throw new Error(`${key} must be ${max} characters or less`);
      return value;
    };
    const objective = text('objective', current.objective, 1000);
    const audience = text('audience', current.audience, 500);
    if (!objective) throw new Error('A channel objective is required');
    if (!audience) throw new Error('A target audience is required');

    const rawPillars = body.contentPillars ?? current.contentPillars ?? [];
    if (!Array.isArray(rawPillars)) throw new Error('contentPillars must be an array');
    const contentPillars = rawPillars.map(value => String(value).trim()).filter(Boolean);
    if (!contentPillars.length || contentPillars.length > 8 || contentPillars.some(value => value.length > 100)) {
      throw new Error('Provide 1 to 8 content pillars, each 100 characters or less');
    }

    const integer = (key, fallback, min, max) => {
      const value = Number(body[key] ?? fallback);
      if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${key} must be an integer from ${min} to ${max}`);
      }
      return value;
    };
    const defaultFormat = text('defaultFormat', current.default_format || 'story', 20).toLowerCase();
    const defaultLength = text('defaultLength', current.default_length || 'short', 20).toLowerCase();
    const status = text('status', current.status || 'draft', 20).toLowerCase();
    const primaryKpi = text('primaryKpi', current.primary_kpi || 'views', 30).toLowerCase();
    const outcomeCurrency = text('outcomeCurrency', current.outcome_currency || 'USD', 3).toUpperCase();
    if (!['explainer', 'tutorial', 'list', 'review', 'story'].includes(defaultFormat)) {
      throw new Error('defaultFormat is not supported');
    }
    if (!['short', 'medium', 'long'].includes(defaultLength)) throw new Error('defaultLength is not supported');
    if (!['draft', 'active', 'paused'].includes(status)) throw new Error('status must be draft, active, or paused');
    if (!['views', 'watch_hours', 'subscribers', 'engagement', 'revenue'].includes(primaryKpi)) {
      throw new Error('primaryKpi is not supported');
    }
    if (!/^[A-Z]{3}$/.test(outcomeCurrency)) throw new Error('outcomeCurrency must be a three-letter currency code');
    const optionalNumber = (key, fallback, min, max) => {
      const raw = body[key] ?? fallback;
      if (raw === undefined || raw === null || raw === '') return null;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < min || value > max) {
        throw new Error(`${key} must be a number from ${min} to ${max}`);
      }
      return value;
    };

    return {
      objective,
      audience,
      valueProposition: text('valueProposition', current.value_proposition, 1000),
      contentPillars,
      cadencePerWeek: integer('cadencePerWeek', current.cadence_per_week || ((channelIdentity.publishingCadence?.shortsPerDay?.target || 3) * 7), 1, 35),
      videosPerRun: integer('videosPerRun', current.videos_per_run || 1, 1, 5),
      defaultFormat,
      defaultLength,
      successMetric: text('successMetric', current.success_metric, 300),
      primaryKpi,
      targetValue: optionalNumber('targetValue', current.target_value, 0.01, 1000000000),
      targetWindowDays: integer('targetWindowDays', current.target_window_days || 28, 7, 365),
      monthlyBudget: optionalNumber('monthlyBudget', current.monthly_budget, 0, 10000000),
      outcomeCurrency,
      constraints: text('constraints', current.constraints, 2000),
      status
    };
  }
  setupAPI() {
    this.app.use(express.json({ limit: '1mb' }));
    this.app.use(express.static(path.join(__dirname, 'dashboard')));

    if (!process.env.API_KEY || process.env.API_KEY === 'change-me-before-start') {
      this.logger.warn('API_KEY is not configured; operational API routes will remain locked');
    }
    
    // Main dashboard route
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
    });
    
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: this.setupRequired ? 'setup_required' : 'healthy',
        initialized: this.isInitialized,
        setupRequired: this.setupRequired,
        agents: Object.keys(this.agents),
        agentContractVersion: this.agentContracts?.version || null,
        uptime: process.uptime(),
        llmUsage: AITextService.usageSnapshot(),
        timestamp: new Date().toISOString()
      });
    });

    // Manual content generation
    this.app.post('/generate', this.requireAPIKey(), async (req, res) => {
      try {
        if (this.setupRequired) {
          return res.status(503).json({ success: false, error: 'Finish setup with npm run walkthrough before generating content' });
        }
        const validation = this.validateGenerateRequestBody(req.body);
        if (!validation.valid) {
          return res.status(validation.status).json({ success: false, error: validation.error });
        }

        const { topic, style, length } = validation.value;
        const result = await this.startGenerationJob({ topic, style, length, source: 'manual' });
        res.status(202).json({ success: true, result });
      } catch (error) {
        res.status(error.status || 500).json({ success: false, error: error.message });
      }
    });

    // Get analytics
    this.app.get('/analytics', async (req, res) => {
      try {
        if (!this.agents.analytics) return res.json({ totalVideos: 0, averagePerformanceScore: 0, topPerformers: [], insights: [], learning: null });
        const analytics = await this.agents.analytics.getRecentAnalytics();
        const learning = await this.agents.analytics.getLearningSummary();
        res.json({ ...analytics, learning });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/api/outcomes', async (_req, res) => {
      try {
        const learning = this.agents.analytics?.getLearningSummary
          ? await this.agents.analytics.getLearningSummary()
          : { outcome: null };
        return res.json({ success: true, result: learning.outcome || null });
      } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
      }
    });

    // Get upcoming schedule
    this.app.get('/schedule', async (req, res) => {
      try {
        const schedule = await this.db.getUpcomingSchedule();
        res.json(schedule);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Manual publish
    this.app.post('/publish/:contentId', this.requireAPIKey(), async (req, res) => {
      try {
        if (!this.agents.publishing) return res.status(503).json({ success: false, error: 'YouTube publishing is not configured' });
        const { contentId } = req.params;
        const bundle = await this.db.getProductionBundle(contentId);
        if (!bundle || bundle.review_status !== 'approved') {
          return res.status(409).json({ success: false, error: 'Content must pass review and be approved before publishing' });
        }
        const result = await this.agents.publishing.publishContent(contentId);
        res.json({ success: true, result });
      } catch (error) {
        res.status(error.status || 500).json({ success: false, error: error.message });
      }
    });

    this.setupOperatorAPI();
  }

  setupOperatorAPI() {
    const protect = this.requireAPIKey();

    this.app.get('/api/dashboard', async (_req, res) => {
      try {
        const [stats, jobs, pipeline, schedule, events, notifications, profile, settings, ideas, analytics, learning, channelStrategy, operatorRuns, readiness, engagement, experiments] = await Promise.all([
          this.db.getStats(),
          this.db.listGenerationJobs(20),
          this.db.getPipelineOverview(50),
          this.db.getUpcomingSchedule(30),
          this.db.getRecentAutomationEvents(20),
          this.db.listNotifications(20),
          this.db.getChannelProfile(),
          this.db.getAllSettings(),
          this.db.listContentIdeas(),
          this.agents.analytics
            ? this.agents.analytics.getRecentAnalytics(30)
            : Promise.resolve({ totalVideos: 0, averagePerformanceScore: 0, topPerformers: [], insights: [] }),
          this.agents.analytics?.getLearningSummary
            ? this.agents.analytics.getLearningSummary()
            : Promise.resolve({ measuredVideos: 0, snapshotCount: 0, baseline: {}, recommendations: [], approvedCount: 0, pendingCount: 0 }),
          this.db.getChannelStrategy(),
          this.db.listOperatorRuns(10),
          this.readiness
            ? this.readiness.getSummary()
            : Promise.resolve({ status: 'unverified', stale: false, blockingFailures: [], checks: [] }),
          this.engagement
            ? this.engagement.getSummary()
            : Promise.resolve({
                videosTracked: 0, pendingDrafts: 0, postedToday: 0, needsAttentionCount: 0,
                pendingAudienceIdeas: 0, postingEnabled: false, postingDisabledReason: 'setup_required',
                insights: [], recentThemes: [],
                evidencePolicy: 'Comments are fetched read-only from YouTube. Replies post only after operator approval, and fallback analysis never proposes drafts or ideas.'
              }),
          this.experiments
            ? this.experiments.getSummary()
            : Promise.resolve({ experiments: [], candidates: [], activeCount: 0, awaitingDecisionCount: 0, evidencePolicy: 'Finish setup to create a controlled growth experiment.' })
        ]);
        res.json({
          stats, jobs, pipeline, schedule, events, notifications, profile, settings, ideas, analytics, learning,
          channelStrategy, operatorRuns, readiness, engagement, experiments,
          system: {
            initialized: this.isInitialized,
            setupRequired: this.setupRequired,
            uptime: process.uptime(),
            activeJobs: this.activeJobs.size,
            automationPaused: this.scheduler ? !this.scheduler.isEnabled : true,
            // Effective controls (environment wins over stored settings), for operators and verifiers.
            control: await resolveControlState(this.db),
            agents: Object.keys(this.agents),
            autonomousRunning: Boolean(await this.db.getActiveOperatorRun()),
            videoProviders: this.agents.production?.aiVideoGenerator?.mediaGeneration?.listProviders() || []
          }
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/api/jobs/:jobId', async (req, res) => {
      const job = await this.db.getGenerationJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: 'Job not found' });
      job.checkpoints = await this.db.listGenerationCheckpoints(job.id);
      job.mediaTasks = await this.db.listMediaGenerationTasks(job.id);
      job.resumeFrom = this.recovery?.resumePoint(job.checkpoints);
      return res.json(job);
    });

    this.app.post('/api/jobs/:jobId/resume', protect, async (req, res) => {
      try {
        const result = await this.resumeGenerationJob(req.params.jobId, { stage: req.body?.stage });
        return res.status(202).json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    });

    this.app.get('/api/readiness', async (_req, res) => {
      if (!this.readiness) return res.status(503).json({ error: 'Readiness service is not initialized' });
      return res.json(await this.readiness.getSummary());
    });

    this.app.post('/api/readiness/run', protect, async (req, res) => {
      try {
        if (!this.readiness) return res.status(503).json({ error: 'Readiness service is not initialized' });
        const result = await this.readiness.run({
          includePaidMedia: req.body?.includePaidMedia === true,
          includePaidVideo: req.body?.includePaidVideo === true
        });
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/jobs/:jobId/cancel', protect, async (req, res) => {
      const job = await this.db.getGenerationJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: 'Job not found' });
      if (!['queued', 'running'].includes(job.status)) {
        return res.status(409).json({ error: 'Only queued or running jobs can be cancelled' });
      }
      const updated = await this.cancelGenerationJob(job.id, req.body?.reason || 'Cancelled by operator');
      return res.json({ success: true, result: updated });
    });

    this.app.get('/api/content/:productionId', async (req, res) => {
      let bundle = await this.db.getProductionBundle(req.params.productionId);
      if (!bundle) return res.status(404).json({ error: 'Content not found' });
      if (this.scenes && !bundle.scenes?.length) {
        await this.scenes.ensureManifest(bundle);
        bundle = await this.db.getProductionBundle(req.params.productionId);
      }
      return res.json(this.decorateContentBundle(bundle));
    });

    this.app.get('/api/content/:productionId/scenes/:sceneId/estimate', async (req, res) => {
      try {
        if (!this.scenes) return res.status(503).json({ error: 'Scene repair requires completed setup' });
        const result = await this.scenes.regenerationEstimate(req.params.productionId, req.params.sceneId, {
          provider: req.query.provider
        });
        return res.json(result);
      } catch (error) {
        return res.status(error.status || 400).json({ error: error.message, code: error.code, details: error.details });
      }
    });

    this.app.patch('/api/content/:productionId/scenes/:sceneId', protect, async (req, res) => {
      try {
        if (!this.scenes) return res.status(503).json({ error: 'Scene repair requires completed setup' });
        const result = await this.scenes.updateScene(req.params.productionId, req.params.sceneId, req.body || {});
        await this.refreshContentReview(req.params.productionId, 'Scene changes require review before scheduling');
        return res.json({ success: true, result: this.scenes.decorateScene(result, req.params.productionId) });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
      }
    });

    this.app.post('/api/content/:productionId/scenes/reorder', protect, async (req, res) => {
      try {
        if (!this.scenes) return res.status(503).json({ error: 'Scene repair requires completed setup' });
        const result = await this.scenes.reorder(req.params.productionId, req.body?.sceneIds);
        await this.refreshContentReview(req.params.productionId, 'Timeline order changed; rebuild and review before scheduling');
        return res.json({ success: true, result: result.map(scene => this.scenes.decorateScene(scene, req.params.productionId)) });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
      }
    });

    this.app.post('/api/content/:productionId/scenes/:sceneId/regenerate', protect, async (req, res) => {
      try {
        if (!this.scenes) return res.status(503).json({ error: 'Scene repair requires completed setup' });
        const result = await this.scenes.regenerate(req.params.productionId, req.params.sceneId, req.body || {});
        await this.refreshContentReview(req.params.productionId, 'Regenerated scene must be rebuilt and reviewed');
        return res.status(202).json({ success: true, result: {
          ...result,
          scene: this.scenes.decorateScene(result.scene, req.params.productionId)
        } });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
      }
    });

    this.app.post('/api/content/:productionId/scenes/:sceneId/narration', protect, async (req, res) => {
      try {
        if (!this.scenes) return res.status(503).json({ error: 'Narration recovery requires completed setup' });
        const result = await this.scenes.regenerateNarration(req.params.productionId, req.params.sceneId, req.body || {});
        await this.refreshContentReview(req.params.productionId, 'Narration regenerated; rebuild the final video before approval');
        return res.status(202).json({ success: true, result: this.scenes.decorateScene(result, req.params.productionId) });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
      }
    });

    this.app.post('/api/content/:productionId/narration/silence', protect, async (req, res) => {
      try {
        if (!this.scenes) return res.status(503).json({ error: 'Narration recovery requires completed setup' });
        const result = await this.scenes.setSilenceOverride(req.params.productionId, req.body || {});
        await this.refreshContentReview(
          req.params.productionId,
          result.enabled ? 'Intentional silence recorded; rebuild and review before approval' : 'Narration is required again; regenerate it before approval'
        );
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
      }
    });

    this.app.put(
      '/api/content/:productionId/scenes/:sceneId/asset',
      protect,
      express.raw({ type: ['image/*', 'video/*'], limit: '100mb' }),
      async (req, res) => {
        try {
          if (!this.scenes) return res.status(503).json({ error: 'Scene repair requires completed setup' });
          const result = await this.scenes.replaceAsset(req.params.productionId, req.params.sceneId, {
            buffer: req.body,
            contentType: req.get('content-type'),
            filename: req.get('x-file-name'),
            rightsConfirmed: req.get('x-rights-confirmed') === 'true',
            containsSyntheticMedia: req.get('x-synthetic-media') === 'true'
          });
          await this.refreshContentReview(req.params.productionId, 'Replacement scene asset must be rebuilt and reviewed');
          return res.json({ success: true, result: this.scenes.decorateScene(result, req.params.productionId) });
        } catch (error) {
          return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
        }
      }
    );

    this.app.post('/api/content/:productionId/scenes/rebuild', protect, async (req, res) => {
      try {
        if (!this.scenes) return res.status(503).json({ error: 'Scene repair requires completed setup' });
        const result = await this.scenes.rebuild(req.params.productionId);
        await this.refreshContentReview(req.params.productionId, 'Scene repair rebuilt; final approval is required');
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
      }
    });

    this.app.get('/api/content/:productionId/scenes/:sceneId/asset', async (req, res) => {
      try {
        const scene = await this.db.getProductionScene(req.params.productionId, req.params.sceneId);
        if (!scene?.assetPath) return res.status(404).json({ error: 'Scene asset not found' });
        const resolved = path.resolve(scene.assetPath);
        const dataRoot = path.resolve(__dirname, 'data');
        if (!resolved.startsWith(`${dataRoot}${path.sep}`)) return res.status(403).json({ error: 'Scene asset path is not allowed' });
        await fs.access(resolved);
        return res.sendFile(resolved);
      } catch (_error) {
        return res.status(404).json({ error: 'Scene asset not found' });
      }
    });

    this.app.patch('/api/content/:productionId', protect, async (req, res) => {
      try {
        const bundle = await this.db.getProductionBundle(req.params.productionId);
        if (!bundle) return res.status(404).json({ error: 'Content not found' });
        if (bundle.review_status === 'approved' && bundle.schedule?.status === 'published') {
          return res.status(409).json({ error: 'Published content cannot be edited here' });
        }
        const editorData = this.validateEditorData(req.body, bundle.editorData);
        const result = await this.db.saveContentReview(bundle.id, {
          status: bundle.review_status || 'needs_review',
          editorData,
          qualityChecks: bundle.qualityChecks,
          reviewNotes: req.body.reviewNotes ?? bundle.review_notes,
          reviewedAt: bundle.reviewed_at
        });
        return res.json({ success: true, result: this.decorateContentBundle(result) });
      } catch (error) {
        return res.status(400).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/content/:productionId/approve', protect, async (req, res) => {
      try {
        const result = await this.approveContent(req.params.productionId, req.body || {});
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, quality: error.quality });
      }
    });

    this.app.post('/api/content/:productionId/reject', protect, async (req, res) => {
      const bundle = await this.db.getProductionBundle(req.params.productionId);
      if (!bundle) return res.status(404).json({ error: 'Content not found' });
      await this.db.saveContentReview(bundle.id, {
        status: 'rejected',
        editorData: bundle.editorData,
        qualityChecks: bundle.qualityChecks,
        reviewNotes: req.body?.notes || 'Rejected by operator',
        reviewedAt: new Date().toISOString()
      });
      await this.db.updateProductionStatus(bundle.id, 'rejected');
      return res.json({ success: true });
    });

    this.app.post('/api/content/:productionId/retry', protect, async (req, res) => {
      const bundle = await this.db.getProductionBundle(req.params.productionId);
      if (!bundle) return res.status(404).json({ error: 'Content not found' });
      const job = await this.startGenerationJob({
        topic: bundle.strategy.topic || bundle.editorData.title || null,
        style: bundle.strategy.requestedStyle || bundle.strategy.contentType || null,
        length: bundle.strategy.requestedLengthKey || 'medium',
        source: 'retry'
      });
      return res.status(202).json({ success: true, result: job });
    });

    this.app.get('/api/content/:productionId/asset/:kind', async (req, res) => {
      try {
        const bundle = await this.db.getProductionBundle(req.params.productionId);
        if (!bundle) return res.status(404).json({ error: 'Content not found' });
        const allowed = {
          video: bundle.assets?.finalVideo?.path,
          thumbnail: bundle.assets?.thumbnail?.path,
          captions: bundle.assets?.captions?.path,
          script: bundle.assets?.script?.originalPath
        };
        const experimentMatch = req.params.kind.match(/^experiment-thumbnail-(\d+)$/);
        const experimentPath = experimentMatch
          ? bundle.editorData?.packagingExperiment?.thumbnailVariants?.[Number(experimentMatch[1])]?.path
          : null;
        const filePath = allowed[req.params.kind] || experimentPath;
        if (!filePath) return res.status(404).json({ error: 'Asset not found' });
        const resolved = path.resolve(filePath);
        const dataRoot = path.resolve(__dirname, 'data');
        const experimentRoot = path.resolve(__dirname, 'uploads', 'thumbnails');
        const allowedPath = [dataRoot, experimentRoot]
          .some(root => resolved.startsWith(`${root}${path.sep}`));
        if (!allowedPath) return res.status(403).json({ error: 'Asset path is not allowed' });
        await fs.access(resolved);
        return res.sendFile(resolved);
      } catch (_error) {
        return res.status(404).json({ error: 'Asset not found' });
      }
    });

    this.app.put('/api/profile', protect, async (req, res) => {
      try {
        const profile = this.validateProfile(req.body || {});
        return res.json({ success: true, result: await this.db.saveChannelProfile(profile) });
      } catch (error) {
        return res.status(400).json({ success: false, error: error.message });
      }
    });

    this.app.put('/api/operator/strategy', protect, async (req, res) => {
      try {
        const current = await this.db.getChannelStrategy() || {};
        const strategy = this.validateChannelStrategy(req.body || {}, current);
        return res.json({ success: true, result: await this.db.saveChannelStrategy(strategy) });
      } catch (error) {
        return res.status(400).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/operator/start', protect, async (req, res) => {
      try {
        if (isLive()) return res.status(409).json({ success: false, error: 'Dark History is live: stories come from the story pool, not from the planner' });
        if (this.setupRequired || !this.agents.strategy) {
          return res.status(503).json({ success: false, error: 'Finish setup with npm run walkthrough before activating the autonomous operator' });
        }
        if (this.activeJobs.size) {
          return res.status(409).json({ success: false, error: 'Wait for the current generation job to finish before starting an autonomous run' });
        }
        await this.readiness?.assertReady('Autonomous production');
        const current = await this.db.getChannelStrategy() || {};
        const strategy = this.validateChannelStrategy({ ...(req.body || {}), status: 'active' }, current);
        const saved = await this.db.saveChannelStrategy(strategy);
        const run = await this.autonomous.start(saved);
        return res.status(202).json({ success: true, result: run });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/operator/pause', protect, async (_req, res) => {
      const strategy = await this.db.getChannelStrategy();
      if (!strategy) return res.status(404).json({ error: 'Channel strategy not found' });
      const active = await this.db.getActiveOperatorRun();
      if (active) await this.autonomous.cancel(active.id);
      const saved = await this.db.saveChannelStrategy({ ...strategy, status: 'paused' });
      return res.json({ success: true, result: saved });
    });

    this.app.post('/api/operator/runs/:runId/cancel', protect, async (req, res) => {
      const run = await this.autonomous.cancel(req.params.runId);
      if (!run) return res.status(404).json({ error: 'Operator run not found' });
      return res.json({ success: true, result: run });
    });

    this.app.put('/api/content/:productionId/provenance', protect, async (req, res) => {
      try {
        const bundle = await this.db.getProductionBundle(req.params.productionId);
        if (!bundle) return res.status(404).json({ error: 'Content not found' });
        if (bundle.review_status === 'approved' || bundle.schedule) {
          return res.status(409).json({ error: 'Provenance is locked after content is approved or scheduled' });
        }
        if (!this.provenance) this.provenance = new ProvenanceService(this.db);
        await this.provenance.review(bundle.id, req.body || {});
        const updated = await this.db.getProductionBundle(bundle.id);
        const profile = await this.db.getChannelProfile() || {};
        const quality = await this.operator.runQualityChecks({
          ...updated,
          scheduledPublishTime: updated.scheduled_publish_time
        }, profile);
        const reviewStatus = quality.passed ? 'needs_review' : 'needs_attention';
        const result = await this.db.saveContentReview(bundle.id, {
          status: reviewStatus,
          editorData: updated.editorData,
          qualityChecks: quality.checks,
          reviewNotes: quality.passed ? null : `Blocking checks failed: ${quality.blockingFailures.join(', ')}`,
          reviewedAt: null
        });
        return res.json({ success: true, result: this.decorateContentBundle(result) });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/operator/runs/:runId/resume', protect, async (req, res) => {
      try {
        if (isLive()) return res.status(409).json({ success: false, error: 'Dark History is live: operator runs of the old planner are not resumed' });
        if (this.setupRequired || !this.agents.strategy) {
          return res.status(503).json({ success: false, error: 'Finish setup before resuming the autonomous operator' });
        }
        await this.readiness?.assertReady('Autonomous production recovery');
        const strategy = await this.db.getChannelStrategy();
        const run = await this.autonomous.resume(req.params.runId, strategy);
        return res.status(202).json({ success: true, result: run });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/learning/recommendations/:recommendationId/:action', protect, async (req, res) => {
      const { recommendationId, action } = req.params;
      if (!['approve', 'reject'].includes(action)) {
        return res.status(400).json({ error: 'Action must be approve or reject' });
      }
      const status = action === 'approve' ? 'approved' : 'rejected';
      const recommendation = await this.db.reviewLearningRecommendation(recommendationId, status);
      if (!recommendation) return res.status(404).json({ error: 'Learning recommendation not found' });
      await this.operator.notify({
        type: 'learning_recommendation_reviewed',
        level: action === 'approve' ? 'success' : 'info',
        title: action === 'approve' ? 'Channel learning approved' : 'Channel learning rejected',
        message: recommendation.title,
        data: { recommendationId, status }
      });
      return res.json({ success: true, result: recommendation });
    });

    this.app.post('/api/content/:productionId/discoverability/run', protect, async (req, res) => {
      try {
        const bundle = await this.db.getProductionBundle(req.params.productionId);
        if (!bundle) return res.status(404).json({ success: false, error: 'Content not found' });
        const profile = await this.db.getChannelProfile() || {};
        const audit = await this.discoverability.auditProduction(bundle, profile, req.body?.platform || 'youtube');
        if (bundle.review_status !== 'approved' && !bundle.schedule) {
          const updated = await this.db.getProductionBundle(bundle.id);
          const quality = await this.operator.runQualityChecks({
            ...updated,
            scheduledPublishTime: updated.scheduled_publish_time
          }, profile);
          await this.db.saveContentReview(bundle.id, {
            status: quality.passed ? 'needs_review' : 'needs_attention',
            editorData: updated.editorData,
            qualityChecks: quality.checks,
            reviewNotes: quality.passed ? null : `Blocking checks failed: ${quality.blockingFailures.join(', ')}`,
            reviewedAt: null
          });
        }
        const result = await this.db.getProductionBundle(bundle.id);
        return res.json({ success: true, result: this.decorateContentBundle(result), audit });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    });

    this.app.patch('/api/content/:productionId/schedule', protect, async (req, res) => {
      try {
        if (!this.agents.publishing) return res.status(503).json({ error: 'Publishing requires completed setup' });
        const result = await this.agents.publishing.rescheduleContent(req.params.productionId, req.body?.publishTime);
        await this.db.updateProductionStatus(req.params.productionId, 'scheduled');
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.post('/api/content/:productionId/publish-now', protect, async (req, res) => {
      try {
        if (!this.agents.publishing) return res.status(503).json({ error: 'Publishing requires completed setup' });
        const result = await this.agents.publishing.emergencyPublish(req.params.productionId);
        await this.db.updateProductionStatus(req.params.productionId, result.status);
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.delete('/api/content/:productionId/schedule', protect, async (req, res) => {
      try {
        if (!this.agents.publishing) return res.status(503).json({ error: 'Publishing requires completed setup' });
        const result = await this.agents.publishing.deleteScheduledContent(req.params.productionId);
        await this.db.updateProductionStatus(req.params.productionId, 'approved');
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.patch('/api/discoverability/findings/:findingId', protect, async (req, res) => {
      try {
        const finding = await this.discoverability.reviewFinding(req.params.findingId, req.body || {});
        const audit = await this.db.getLatestDiscoverabilityAudit(finding.production_id, finding.platform);
        return res.json({ success: true, result: { finding, audit } });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    });

    this.app.get('/api/experiments', async (_req, res) => {
      try {
        const summary = this.experiments
          ? await this.experiments.getSummary()
          : { experiments: [], candidates: [], activeCount: 0, awaitingDecisionCount: 0 };
        return res.json({ success: true, result: summary });
      } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/experiments', protect, async (req, res) => {
      try {
        if (!this.experiments) return res.status(503).json({ error: 'Finish setup before creating experiments' });
        const experiment = await this.experiments.create(req.body || {});
        return res.status(201).json({ success: true, result: experiment });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.post('/api/experiments/:experimentId/:action', protect, async (req, res) => {
      try {
        if (!this.experiments) return res.status(503).json({ error: 'Finish setup before controlling experiments' });
        const actions = {
          approve: () => this.experiments.approve(req.params.experimentId, req.body),
          start: () => this.experiments.start(req.params.experimentId, req.body),
          refresh: () => this.experiments.refresh(req.params.experimentId),
          adopt: () => this.experiments.adoptWinner(req.params.experimentId, req.body),
          cancel: () => this.experiments.cancel(req.params.experimentId, req.body)
        };
        if (!actions[req.params.action]) return res.status(400).json({ error: 'Unsupported experiment action' });
        const experiment = await actions[req.params.action]();
        await this.operator.notify({
          type: 'growth_experiment_updated',
          level: ['adopt', 'approve'].includes(req.params.action) ? 'success' : 'info',
          title: `Growth experiment ${req.params.action}`,
          message: experiment.title,
          data: { experimentId: experiment.id, status: experiment.status }
        });
        return res.json({ success: true, result: experiment });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.get('/api/retention/:videoId', async (req, res) => {
      const videoId = String(req.params.videoId || '').trim();
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(videoId)) {
        return res.status(400).json({ error: 'A valid YouTube video ID is required' });
      }
      const snapshots = await this.db.listRetentionSnapshots({ videoId, limit: 10 });
      return res.json({ success: true, result: snapshots });
    });

    this.app.post('/api/retention/:videoId/refresh', protect, async (req, res) => {
      try {
        const videoId = String(req.params.videoId || '').trim();
        const measurementWindow = String(req.body?.measurementWindow || 'rolling');
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(videoId)) {
          return res.status(400).json({ error: 'A valid YouTube video ID is required' });
        }
        if (!['24h', '7d', 'rolling'].includes(measurementWindow)) {
          return res.status(400).json({ error: 'Measurement window must be 24h, 7d, or rolling' });
        }
        if (!this.agents.analytics) {
          return res.status(503).json({ error: 'YouTube Analytics is not initialized' });
        }
        const report = await this.agents.analytics.analyzeVideoPerformance(videoId, { measurementWindow });
        return res.json({
          success: true,
          result: report.retentionSnapshot || null,
          retention: report.retention
        });
      } catch (error) {
        return res.status(error.status || 400).json({ error: error.message });
      }
    });

    const ENGAGEMENT_VIDEO_ID = /^[A-Za-z0-9_-]{1,100}$/;

    this.app.get('/api/engagement/:videoId', async (req, res) => {
      try {
        const videoId = String(req.params.videoId || '').trim();
        if (!ENGAGEMENT_VIDEO_ID.test(videoId)) {
          return res.status(400).json({ error: 'A valid YouTube video ID is required' });
        }
        const [insight, comments, drafts] = await Promise.all([
          this.db.getEngagementInsight(videoId),
          this.db.listAudienceComments({ videoId, limit: 200 }),
          this.db.listReplyDrafts({ videoId, limit: 100 })
        ]);
        return res.json({ success: true, result: { insight, comments, drafts } });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/engagement/:videoId/sync', protect, async (req, res) => {
      try {
        if (!this.engagement) return res.status(503).json({ error: 'Audience engagement requires completed setup' });
        const videoId = String(req.params.videoId || '').trim();
        if (!ENGAGEMENT_VIDEO_ID.test(videoId)) {
          return res.status(400).json({ error: 'A valid YouTube video ID is required' });
        }
        const sync = await this.engagement.syncVideoComments(videoId, req.body || {});
        const insight = sync.fetched > 0 || req.body?.analyze === true
          ? await this.engagement.analyzeVideo(videoId)
          : sync.insight;
        return res.status(202).json({ success: true, result: { ...sync, insight } });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.post('/api/engagement/:videoId/draft-replies', protect, async (req, res) => {
      try {
        if (!this.engagement) return res.status(503).json({ error: 'Audience engagement requires completed setup' });
        const videoId = String(req.params.videoId || '').trim();
        if (!ENGAGEMENT_VIDEO_ID.test(videoId)) {
          return res.status(400).json({ error: 'A valid YouTube video ID is required' });
        }
        const result = await this.engagement.draftReplies(videoId, req.body || {});
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.patch('/api/engagement/replies/:draftId', protect, async (req, res) => {
      try {
        if (!this.engagement) return res.status(503).json({ error: 'Audience engagement requires completed setup' });
        const result = await this.engagement.updateReplyDraft(req.params.draftId, req.body || {});
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.post('/api/engagement/replies/:draftId/approve', protect, async (req, res) => {
      try {
        if (!this.engagement) return res.status(503).json({ error: 'Audience engagement requires completed setup' });
        const result = await this.engagement.approveReplyDraft(req.params.draftId, req.body || {});
        // The reply is already live on YouTube; a notification failure must not report an error.
        try {
          await this.operator.notify({
            type: 'audience_reply_posted',
            level: 'success',
            title: 'Audience reply posted',
            message: `A reply was posted on video ${result.videoId}`,
            data: { draftId: result.id, videoId: result.videoId, postedCommentId: result.postedCommentId }
          });
        } catch (notifyError) {
          this.logger.warn(`Posted reply notification failed: ${notifyError.message}`);
        }
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.post('/api/ideas', protect, async (req, res) => {
      const topic = String(req.body?.topic || '').trim();
      if (!topic || topic.length > 200) return res.status(400).json({ error: 'A topic of 200 characters or less is required' });
      const idea = await this.db.createContentIdea({ ...req.body, topic });
      return res.status(201).json({ success: true, result: idea });
    });

    this.app.patch('/api/ideas/:ideaId', protect, async (req, res) => {
      const idea = await this.db.updateContentIdea(req.params.ideaId, req.body || {});
      if (!idea) return res.status(404).json({ error: 'Idea not found' });
      return res.json({ success: true, result: idea });
    });

    this.app.post('/api/ideas/:ideaId/generate', protect, async (req, res) => {
      const idea = await this.db.updateContentIdea(req.params.ideaId, { status: 'generating' });
      if (!idea) return res.status(404).json({ error: 'Idea not found' });
      const job = await this.startGenerationJob({ topic: idea.topic, style: idea.style, length: req.body?.length || 'medium', source: 'idea' });
      await this.db.updateContentIdea(idea.id, { status: 'generated' });
      return res.status(202).json({ success: true, result: job });
    });

    this.app.post('/api/automation/:action', protect, async (req, res) => {
      if (!this.scheduler) return res.status(409).json({ error: 'Finish setup before controlling automation' });
      const { action } = req.params;
      if (action === 'pause') {
        await this.scheduler.pauseAutomation();
        await this.db.setSetting('automation_paused', 'true');
        await this.operator.notify({ type: 'automation_paused', level: 'warning', title: 'Automation paused', message: 'Automation was paused by the operator. No new work starts until it is resumed.' });
      } else if (action === 'resume') {
        if ((await resolveControlState(this.db)).sources.automationPaused === 'environment') {
          return res.status(409).json({ error: 'AUTOMATION_PAUSED=true is set in the service environment; change it there to resume' });
        }
        await this.scheduler.resumeAutomation();
        await this.db.setSetting('automation_paused', 'false');
        await this.operator.notify({ type: 'automation_resumed', level: 'info', title: 'Automation resumed', message: 'Automation was resumed by the operator.' });
        await this.resumeInterruptedAutonomousWork('operator_resume');
      } else {
        return res.status(400).json({ error: 'Action must be pause or resume' });
      }
      return res.json({ success: true, paused: !this.scheduler.isEnabled });
    });

    this.app.put('/api/settings', protect, async (req, res) => {
      const allowed = ['approval_required', 'notification_enabled', 'channel_timezone', 'max_daily_posts', 'content_buffer_days'];
      if (req.body?.approval_required !== undefined && (await resolveControlState(this.db)).sources.approvalRequired === 'environment') {
        return res.status(409).json({ error: 'APPROVAL_REQUIRED is set in the service environment; change it there' });
      }
      for (const key of allowed) {
        if (req.body?.[key] !== undefined) await this.db.setSetting(key, String(req.body[key]));
      }
      const provider = req.body?.video_provider;
      if (provider !== undefined) {
        const supported = ['slideshow', 'auto', 'seedance', 'minimax_h3', 'google_omni', 'kling', 'wan'];
        if (!supported.includes(provider)) return res.status(400).json({ error: 'Unsupported video provider' });
        await this.db.setSetting('video_provider', provider);
      }
      const mode = req.body?.video_generation_mode;
      if (mode !== undefined) {
        if (!['hybrid', 'slideshow'].includes(mode)) return res.status(400).json({ error: 'Unsupported video generation mode' });
        await this.db.setSetting('video_generation_mode', mode);
      }
      if (req.body?.video_clip_duration !== undefined) {
        const value = Number(req.body.video_clip_duration);
        if (!Number.isInteger(value) || value < 3 || value > 30) return res.status(400).json({ error: 'Clip duration must be between 3 and 30 seconds' });
        await this.db.setSetting('video_clip_duration', String(value));
      }
      if (req.body?.video_max_generated_seconds !== undefined) {
        const value = Number(req.body.video_max_generated_seconds);
        if (!Number.isInteger(value) || value < 0 || value > 600) return res.status(400).json({ error: 'Generated seconds cap must be between 0 and 600' });
        await this.db.setSetting('video_max_generated_seconds', String(value));
      }
      return res.json({ success: true, result: await this.db.getAllSettings() });
    });

    this.app.post('/api/notifications/:notificationId/read', protect, async (req, res) => {
      await this.db.markNotificationRead(req.params.notificationId);
      return res.json({ success: true });
    });
  }

  async startGenerationJob(input = {}) {
    if (this.setupRequired || !this.agents.strategy) {
      const error = new Error('Finish setup with npm run walkthrough before generating content');
      error.status = 503;
      throw error;
    }
    if (isLive()) return this.startDocumentaryJob(input);
    if (['scheduler', 'autonomous_operator'].includes(input.source)) {
      await this.readiness?.assertReady('Automated generation');
    }
    const maxConcurrent = Math.max(1, parseInt(process.env.MAX_CONCURRENT_JOBS || '1', 10));
    if (this.activeJobs.size >= maxConcurrent) {
      const error = new Error(`Generation is busy (${this.activeJobs.size}/${maxConcurrent} active jobs). Try again when the current job finishes.`);
      error.status = 429;
      throw error;
    }

    const validation = this.validateGenerateRequestBody(input);
    if (!validation.valid) {
      const error = new Error(validation.error);
      error.status = validation.status;
      throw error;
    }

    const job = await this.db.createGenerationJob({
      ...validation.value,
      source: input.source || 'manual'
    });

    const controller = new AbortController();
    this.jobAbortControllers.set(job.id, controller);
    const work = this.runGenerationJob(job.id, validation.value, controller.signal)
      .catch(error => this.logger.error(`Generation job ${job.id} failed:`, error))
      .finally(() => {
        this.activeJobs.delete(job.id);
        this.jobAbortControllers.delete(job.id);
      });
    this.activeJobs.set(job.id, work);
    return job;
  }

  async resumeGenerationJob(jobId, options = {}) {
    if (this.setupRequired || !this.agents.strategy) {
      const error = new Error('Finish setup with npm run walkthrough before resuming content generation');
      error.status = 503;
      throw error;
    }
    const job = await this.db.getGenerationJob(jobId);
    if (!job) {
      const error = new Error('Generation job not found');
      error.status = 404;
      throw error;
    }
    if (!['failed', 'interrupted'].includes(job.status)) {
      const error = new Error('Only failed or interrupted generation jobs can be resumed');
      error.status = 409;
      throw error;
    }
    if (isDocumentary(job)) {
      // The old pipeline would turn the story's title into a stickman script. A documentary job is retried as a new job.
      await this.releaseInterruptedDocumentaryJobs();
      const error = new Error('A Dark History job is not resumed; the scheduler starts a new job with the next story');
      error.status = 409;
      throw error;
    }
    if (this.activeJobs.has(job.id)) {
      const error = new Error('This generation job is already running');
      error.status = 409;
      throw error;
    }
    const maxConcurrent = Math.max(1, parseInt(process.env.MAX_CONCURRENT_JOBS || '1', 10));
    if (this.activeJobs.size >= maxConcurrent) {
      const error = new Error(`Generation is busy (${this.activeJobs.size}/${maxConcurrent} active jobs). Try again when the current job finishes.`);
      error.status = 429;
      throw error;
    }
    if (['scheduler', 'autonomous_operator'].includes(job.source)) {
      await this.readiness?.assertReady('Automated generation recovery');
    }

    const checkpoints = await this.db.listGenerationCheckpoints(job.id);
    const resumeFrom = options.stage || this.recovery.resumePoint(checkpoints);
    if (!GENERATION_STAGES.includes(resumeFrom)) {
      const error = new Error('Resume stage is not supported');
      error.status = 400;
      throw error;
    }
    if (options.stage) await this.recovery.resetFrom(job.id, resumeFrom);
    const input = {
      topic: job.topic,
      style: job.style,
      length: job.length || 'medium',
      strategyContext: job.details?.strategyContext || {}
    };
    const updated = await this.db.updateGenerationJob(job.id, {
      status: 'queued',
      stage: resumeFrom,
      error: null,
      cancelRequested: false,
      completedAt: null,
      details: {
        resumeCount: Number(job.details?.resumeCount || 0) + 1,
        resumeFrom,
        failedStage: null,
        pausedAt: null,
        pausedBeforeStage: null
      }
    });
    const controller = new AbortController();
    this.jobAbortControllers.set(job.id, controller);
    const work = this.runGenerationJob(job.id, input, controller.signal)
      .catch(error => this.logger.error(`Resumed generation job ${job.id} failed:`, error))
      .finally(() => {
        this.activeJobs.delete(job.id);
        this.jobAbortControllers.delete(job.id);
      });
    this.activeJobs.set(job.id, work);
    return updated;
  }

  async cancelGenerationJob(jobId, reason = 'Cancelled by operator') {
    const job = await this.db.getGenerationJob(jobId);
    if (!job) {
      const error = new Error('Generation job not found');
      error.status = 404;
      throw error;
    }
    if (!['queued', 'running'].includes(job.status)) return job;
    const updated = await this.db.updateGenerationJob(job.id, {
      cancelRequested: true,
      details: { cancelReason: reason }
    });
    const controller = this.jobAbortControllers.get(job.id);
    if (controller && !controller.signal.aborted) controller.abort(reason);
    return updated;
  }

  async waitForGenerationJob(jobId) {
    const work = this.activeJobs.get(jobId);
    if (work) await work;
    const job = await this.db.getGenerationJob(jobId);
    if (!job) throw new Error(`Generation job ${jobId} was not found after it ran`);
    return job;
  }

  async queueScheduledContent(input = {}) {
    // Fail fast: the autonomous operator researches and plans with LLM calls BEFORE its first generation job
    // reaches the readiness gate (startGenerationJob). Checking here keeps a blocked system from spending the
    // free LLM quota on runs that cannot start a video, and lets the scheduler report the reason once.
    // (2026-10-04: the scheduler logged six "queued" operator runs between 06:00 and 16:00 UTC while no
    // generation job was created.)
    await this.readiness?.assertReady('Automated generation');
    // Dark History: the stories come from the pool, not from the planner (no research or planning call is made).
    if (isLive()) return this.startDocumentaryJob(input);
    const strategy = await this.db.getChannelStrategy();
    if (strategy?.status === 'active') {
      const weeklyRows = await this.db.getAllRows(
        `SELECT details FROM generation_jobs
         WHERE status = 'completed'
         AND created_at >= datetime('now', '-7 days')`
      );
      const usableCount = weeklyRows.filter(row => {
        try {
          const details = typeof row.details === 'string' ? JSON.parse(row.details || '{}') : (row.details || {});
          return ['needs_review', 'approved'].includes(details.reviewStatus);
        } catch (_error) {
          return false;
        }
      }).length;
      const remaining = Math.max(1, strategy.cadence_per_week - usableCount);
      return this.autonomous.start({
        ...strategy,
        videos_per_run: Math.min(strategy.videos_per_run, remaining)
      });
    }
    return this.startGenerationJob(input);
  }

  async runGenerationJob(jobId, input, abortSignal = null) {
    try {
      await this.db.updateGenerationJob(jobId, { status: 'running', progress: 2, error: null, completedAt: null });
      const result = await this.generateContent(input.topic, input.style, input.length, {
        jobId,
        strategyContext: input.strategyContext,
        abortSignal,
        pipeline: input.pipeline
      });
      await this.db.updateGenerationJob(jobId, {
        status: 'completed',
        stage: result.scheduledFor ? 'scheduled' : result.reviewStatus,
        progress: 100,
        productionId: result.contentId,
        title: result.title,
        details: {
          reviewStatus: result.reviewStatus,
          qualityScore: result.qualityScore,
          publicationState: result.publicationState || null
        },
        completedAt: new Date().toISOString()
      });
      if (result.topic) {
        // Autonomously selected topics must be visible to the duplicate-premise gate.
        await this.db.executeQuery(
          'UPDATE generation_jobs SET topic = COALESCE(topic, ?) WHERE id = ?',
          [result.topic, jobId]
        );
      }
      if (['needs_review', 'approved'].includes(result.reviewStatus)) {
        await this.db.setSetting('last_content_generation', new Date().toISOString());
      }
      return result;
    } catch (error) {
      if (error.code === 'AUTOMATION_PAUSED') {
        const pausedJob = await this.db.getGenerationJob(jobId);
        await this.db.updateGenerationJob(jobId, {
          status: 'interrupted',
          stage: error.stage || pausedJob?.stage || 'starting',
          error: error.message,
          details: { pausedAt: new Date().toISOString(), pausedBeforeStage: error.stage || null },
          completedAt: new Date().toISOString()
        });
        this.logger.info(`Generation job ${jobId} paused at the ${error.stage} checkpoint`);
        return { paused: true, jobId };
      }
      const cancelled = error.code === 'JOB_CANCELLED';
      const current = await this.db.getGenerationJob(jobId);
      const failedStage = current?.stage || 'starting';
      await this.db.updateGenerationJob(jobId, {
        status: cancelled ? 'cancelled' : 'failed',
        stage: failedStage,
        error: error.message,
        details: { failedStage },
        completedAt: new Date().toISOString()
      });
      if (!error.alerted) await this.operator.notify({
        type: cancelled ? 'generation_cancelled' : 'generation_failure',
        level: cancelled ? 'warning' : 'error',
        title: cancelled ? 'Generation cancelled' : 'Generation failed',
        message: error.message,
        data: { jobId }
      });
      throw error;
    }
  }

  /**
   * Safe checkpoint between stages. Automated jobs stop here while automation is
   * paused; the completed stage checkpoints stay intact so the job resumes later.
   * Manual operator jobs are not affected by the automation pause.
   */
  async assertJobMayContinue(jobId, stage) {
    if (typeof this.db?.getGenerationJob !== 'function') return;
    const job = await this.db.getGenerationJob(jobId);
    if (!job || !['scheduler', 'autonomous_operator'].includes(job.source)) return;
    const control = await resolveControlState(this.db);
    if (!control.automationPaused) return;
    const error = new Error(`Automation paused before the ${stage} stage; work is saved at the last checkpoint`);
    error.code = 'AUTOMATION_PAUSED';
    error.stage = stage;
    throw error;
  }

  /**
   * After a restart (or when automation resumes) continue the most recent
   * interrupted autonomous operator run from its checkpoints instead of
   * abandoning it. Bounded per run so a crash-looping item cannot loop forever.
   */
  async resumeInterruptedAutonomousWork(reason = 'startup') {
    try {
      const control = await resolveControlState(this.db);
      if (!control.autonomousMode || control.automationPaused || !this.autonomous) return null;
      if (isLive()) return null; // old planner runs and old jobs are never resumed while Dark History is live
      const strategy = await this.db.getChannelStrategy();
      if (strategy?.status !== 'active') return null;
      if (await this.db.getActiveOperatorRun()) return null;
      const maxAttempts = Math.max(1, Number(process.env.AUTO_RESUME_MAX_ATTEMPTS || 3));
      const claimBudget = async id => {
        const budgetKey = `auto_resume_count:${id}`;
        const attempts = Number(await this.db.getSetting(budgetKey) || 0);
        if (attempts >= maxAttempts) {
          this.logger.warn(`Interrupted work ${id} reached its automatic resume budget (${maxAttempts}); leaving it for review`);
          return null;
        }
        await this.db.setSetting(budgetKey, String(attempts + 1));
        return attempts + 1;
      };

      const run = await this.db.getRow(
        `SELECT id FROM operator_runs
         WHERE status = 'interrupted' AND updated_at >= datetime('now', '-1 day')
         ORDER BY updated_at DESC LIMIT 1`
      );
      if (run) {
        const attempt = await claimBudget(run.id);
        if (!attempt) return null;
        const resumed = await this.autonomous.resume(run.id, strategy);
        this.logger.info(`Resumed interrupted operator run ${run.id} (${reason}, attempt ${attempt}/${maxAttempts})`);
        return resumed;
      }

      // Scheduler jobs started outside an operator run.
      const job = await this.db.getRow(
        `SELECT id FROM generation_jobs
         WHERE status = 'interrupted' AND source = 'scheduler'
           AND updated_at >= datetime('now', '-1 day')
         ORDER BY updated_at DESC LIMIT 1`
      );
      if (!job) return null;
      const attempt = await claimBudget(job.id);
      if (!attempt) return null;
      const resumed = await this.resumeGenerationJob(job.id);
      this.logger.info(`Resumed interrupted scheduler job ${job.id} (${reason}, attempt ${attempt}/${maxAttempts})`);
      return resumed;
    } catch (error) {
      this.logger.warn(`Automatic recovery of interrupted work did not start: ${error.message}`);
      return null;
    }
  }

  async verifyBeforeUpload(bundle) {
    const productionId = bundle?.id || bundle?.productionId || null;
    const profile = await this.db.getChannelProfile() || {};
    const scenes = productionId && this.db.listProductionScenes
      ? await this.db.listProductionScenes(productionId).catch(() => bundle.scenes || [])
      : (bundle.scenes || []);
    return this.operator.runQualityChecks(
      { ...bundle, scenes: scenes?.length ? scenes : (bundle.scenes || []) },
      profile,
      { excludeProductionId: productionId }
    );
  }

  async recordUploadAuthorizationState(control) {
    try {
      const result = await recordUploadAuthorization(this.db, control);
      if (result.changed && result.previous) {
        await this.operator.notify({
          type: 'upload_authorization_changed',
          level: control.uploadEnabled ? 'warning' : 'info',
          title: control.uploadEnabled ? 'Autonomous uploads authorized' : 'Uploads disabled (kill switch)',
          message: `YOUTUBE_UPLOAD_ENABLED changed from ${result.previous.state} to ${result.state} by the service environment.`,
          data: result.record
        });
      }
      return result;
    } catch (error) {
      this.logger.warn(`Could not record upload authorization state: ${error.message}`);
      return null;
    }
  }

  async updateJobStage(jobId, stage, progress, details = {}) {
    if (!jobId) return;
    const job = await this.db.getGenerationJob(jobId);
    if (job?.cancelRequested) {
      const error = new Error(job.details?.cancelReason || 'Generation cancelled by operator');
      error.code = 'JOB_CANCELLED';
      throw error;
    }
    await this.db.updateGenerationJob(jobId, { stage, progress, details });
  }

  summarizeAgentHandoff(stage, artifact = {}) {
    if (stage === 'strategy') {
      return {
        topic: artifact.topic || null,
        sourceCount: Array.isArray(artifact.researchSources) ? artifact.researchSources.length : 0,
        researchContextCount: Array.isArray(artifact.researchContext) ? artifact.researchContext.length : 0
      };
    }
    if (stage === 'script') {
      return {
        title: artifact.title || null,
        sectionCount: Array.isArray(artifact.mainContent?.sections) ? artifact.mainContent.sections.length : 0,
        claimCount: Array.isArray(artifact.claims) ? artifact.claims.length : 0
      };
    }
    if (stage === 'thumbnail') {
      return {
        path: artifact.path || null,
        reviewRequired: artifact.reviewRequired === true
      };
    }
    if (stage === 'seo') {
      return {
        title: artifact.title || null,
        tagCount: Array.isArray(artifact.tags) ? artifact.tags.length : 0
      };
    }
    if (stage === 'production') {
      return {
        productionId: artifact.id || null,
        sceneCount: Array.isArray(artifact.assets?.video?.scenePlan) ? artifact.assets.video.scenePlan.length : 0,
        simulated: artifact.assets?.finalVideo?.simulated === true
      };
    }
    return {};
  }

  async recordAgentHandoff(jobId, stage, artifact) {
    if (!jobId) return;
    const job = await this.db.getGenerationJob(jobId);
    if (!job) return;
    const agentHandoffs = {
      ...(job.details?.agentHandoffs || {}),
      [stage]: {
        contractVersion: this.agentContracts.version,
        validatedAt: new Date().toISOString(),
        summary: this.summarizeAgentHandoff(stage, artifact)
      }
    };
    await this.db.updateGenerationJob(jobId, { details: { agentHandoffs } });
  }

  /**
   * Script stage with an editor: write, review, and send a rejected draft back with
   * concrete notes (bounded). Nothing is produced from a script that fails review.
   */
  async generateReviewedScript(strategy) {
    const writer = this.agents.scriptWriter;
    let history = [];
    try {
      const rows = await this.db.getAllRows(
        `SELECT s.full_script AS text FROM generation_jobs j
         JOIN productions p ON p.id = j.production_id
         JOIN scripts s ON s.id = p.script_id
         WHERE j.status = 'completed' AND j.created_at >= datetime('now', '-60 days')
         ORDER BY j.created_at DESC LIMIT 40`
      );
      history = rows.map(row => row.text).filter(Boolean);
    } catch (error) {
      this.logger.warn(`Recent script history unavailable for the creative review: ${error.message}`);
    }
    return reviewedScriptLoop({
      write: brief => writer.generateScript(strategy, brief ? { revisionBrief: brief } : {}),
      review: script => reviewScript({ script, strategy, aiText: writer.aiTextService || null, history, logger: this.logger }),
      logger: this.logger
    });
  }

  async generateContent(topic = null, style = null, _length = 'short', options = {}) {
    if (options.pipeline === DOCUMENTARY_PIPELINE) return this.generateDocumentaryContent(options);
    this.logger.info('Starting content generation pipeline...');
    const { jobId = null, strategyContext: rawStrategyContext = {}, abortSignal = null } = options;
    const strategyContext = rawStrategyContext || {};
    const profile = await this.db.getChannelProfile() || {};
    const lengthLabels = { short: '20-45 seconds', medium: '20-45 seconds', long: '20-45 seconds' };

    // Step 1: Strategy
    const strategy = await this.runGenerationStage(jobId, 'strategy', 10, async () => {
      let generated = null;
      const vetted = strategyContext.plan;
      if (vetted && vetted.topic && vetted.topic === topic && typeof this.agents.strategy.buildStrategyFromPlanItem === 'function') {
        generated = await this.agents.strategy.buildStrategyFromPlanItem(vetted);
        if (!generated) this.logger.warn('The planner idea no longer passes the gates; generating a new strategy for the topic');
      }
      if (!generated) generated = await this.agents.strategy.generateContentStrategy(topic);
      const contentStyles = new Set(['tutorial', 'explainer', 'list', 'review', 'story']);
      const requestedStyle = style || profile.default_style || null;
      if (requestedStyle && contentStyles.has(requestedStyle.toLowerCase())) {
        generated.contentType = requestedStyle.charAt(0).toUpperCase() + requestedStyle.slice(1).toLowerCase();
      }
      generated.requestedStyle = requestedStyle;
      generated.requestedLengthKey = 'short';
      generated.requestedLength = lengthLabels.short;
      generated.contentType = 'Story';
      generated.fictional = true;
      generated.provenanceMode = 'fictional';
      generated.angle = strategyContext.angle || generated.angle;
      generated.planRationale = strategyContext.rationale || null;
      generated.targetAudience = strategyContext.audience || profile.target_audience || generated.targetAudience;
      generated.brandVoice = profile.brand_voice || null;
      generated.channelGoal = strategyContext.objective || profile.goal || null;
      generated.channelValueProposition = strategyContext.valueProposition || null;
      generated.channelConstraints = strategyContext.constraints || null;
      generated.contentPillar = strategyContext.pillar || null;
      generated.callToAction = profile.call_to_action || null;
      const generatedResearchSources = Array.isArray(generated.researchSources) ? generated.researchSources : [];
      const contextResearchSources = Array.isArray(strategyContext.researchSources) ? strategyContext.researchSources : [];
      const trustedResearchSource = source => (
        source &&
        typeof source === 'object' &&
        !Array.isArray(source) &&
        source.url &&
        (source.retrievalStatus === 'fetched' || source.status === 'verified')
      );
      generated.researchSources = [...new Map(
        [...generatedResearchSources, ...contextResearchSources]
          .filter(trustedResearchSource)
          .map(source => [source.url, source])
      ).values()];
      return this.agentContracts.handoff('strategy', generated, { productionMode: true });
    });
    // Revalidate after recovery too: a reused checkpoint must satisfy the same
    // communication contract as a freshly generated artifact.
    this.agentContracts.handoff('strategy', strategy, { productionMode: true });
    await this.recordAgentHandoff(jobId, 'strategy', strategy);
    this.logger.info(`Strategy generated: ${strategy.topic}`);

    // Step 2: Script Writing
    const script = await this.runGenerationStage(
      jobId,
      'script',
      25,
      async () => this.agentContracts.handoff(
        'script',
        await this.generateReviewedScript(strategy),
        { strategy }
      )
    );
    this.agentContracts.handoff('script', script, { strategy });
    await this.recordAgentHandoff(jobId, 'script', script);
    this.logger.info(`Script generated: ${script.title}`);

    // Step 3: Thumbnail Design
    const thumbnail = await this.runGenerationStage(
      jobId,
      'thumbnail',
      40,
      async () => this.agentContracts.handoff(
        'thumbnail',
        await this.agents.thumbnailDesigner.generateThumbnail(script),
        { strategy, script }
      )
    );
    this.agentContracts.handoff('thumbnail', thumbnail, { strategy, script });
    await this.recordAgentHandoff(jobId, 'thumbnail', thumbnail);
    this.logger.info('Thumbnail generated');

    // Step 4: SEO Optimization
    const seoData = await this.runGenerationStage(
      jobId,
      'seo',
      52,
      async () => this.agentContracts.handoff(
        'seo',
        await this.agents.seoOptimizer.optimize(script, strategy, { thumbnail }),
        { strategy, script, thumbnail }
      )
    );
    this.agentContracts.handoff('seo', seoData, { strategy, script, thumbnail });
    await this.recordAgentHandoff(jobId, 'seo', seoData);
    this.logger.info('SEO optimization complete');

    // Step 5: Production Management
    const productionData = await this.runGenerationStage(
      jobId,
      'production',
      62,
      async () => this.agentContracts.handoff(
        'production',
        await this.agents.production.processContent({ strategy, script, thumbnail, seo: seoData, jobId, abortSignal }),
        { strategy, script, thumbnail, seo: seoData }
      )
    );
    this.agentContracts.handoff('production', productionData, { strategy, script, thumbnail, seo: seoData });
    await this.recordAgentHandoff(jobId, 'production', productionData);
    this.logger.info('Production processing complete');

    // Re-persist reused production artifacts in case a restart happened between checkpointing and persistence.
    const contentId = await this.db.saveProductionData(productionData);
    await this.db.saveProductionSnapshot(productionData);
    if (!this.provenance) this.provenance = new ProvenanceService(this.db);
    productionData.provenance = await this.provenance.initialize(contentId, productionData);
    productionData.discoverability = this.discoverability
      ? await this.discoverability.auditProduction(productionData, profile, 'youtube')
      : null;
    this.logger.info(`Content saved with ID: ${contentId}`);

    // Step 6: Quality and approval gate
    return this.runGenerationStage(jobId, 'quality_review', 90, async () => {
      // AUTONOMOUS_MODE and APPROVAL_REQUIRED are independent controls: autonomy lets
      // the orchestrator run unattended, it never implies that approval is waived.
      const control = await resolveControlState(this.db);
      const autonomousMode = control.autonomousMode;
      const approvalRequired = control.approvalRequired;
      const packagingExperiment = approvalRequired
        ? await this.preparePackagingExperiment(thumbnail, productionData, seoData, script)
        : null;
      const quality = await this.operator.runQualityChecks(productionData, profile);
      const reviewStatus = quality.passed
        ? (approvalRequired ? 'needs_review' : 'approved')
        : 'needs_attention';
      await this.db.saveContentReview(contentId, {
        status: reviewStatus,
        qualityChecks: quality.checks,
        editorData: packagingExperiment ? {
          packagingExperiment,
          selectedTitleVariant: 0,
          selectedThumbnailVariant: 0
        } : {},
        reviewNotes: quality.passed ? null : `Blocking checks failed: ${quality.blockingFailures.join(', ')}`,
        reviewedAt: approvalRequired ? null : new Date().toISOString()
      });

      let scheduleEntry = null;
      if (reviewStatus === 'approved') {
        scheduleEntry = await this.agents.publishing.scheduleContent(productionData);
        await this.db.updateProductionStatus(contentId, scheduleEntry ? 'scheduled' : productionData.status);
        if (!scheduleEntry) {
          // An approved Short with no schedule row is never published; do not let that be silent.
          this.logger.error(`Approved Short ${contentId} was not scheduled (no publish slot was produced)`);
          await this.operator.notify({
            type: 'approved_not_scheduled',
            level: 'error',
            title: 'Approved Short has no publish slot',
            message: `${script.title} passed every gate but no publish slot was created, so it will not be published until it is scheduled.`,
            data: { contentId },
            dedupeKey: `approved_not_scheduled:${contentId}`,
            dedupeMinutes: 360
          });
        }
      } else {
        await this.db.updateProductionStatus(contentId, reviewStatus);
        // Only a failed quality check is a rejection. A Short that passed every gate while approval is
        // required is simply waiting for the operator and must not be reported as rejected.
        if (autonomousMode && !quality.passed) {
          await this.operator.notify({
            type: 'content_rejected',
            level: 'warning',
            title: 'Production rejected by automated quality gates',
            message: `${script.title} was rejected; the channel will continue with another eligible story instead of requesting human review.`,
            data: { contentId, qualityScore: quality.score, blockingFailures: quality.blockingFailures }
          });
          const error = new Error(`Autonomous production rejected by quality gates: ${quality.blockingFailures.join(', ')}`);
          error.code = 'AUTONOMOUS_QUALITY_REJECTED';
          error.status = 409;
          throw error;
        }
        await this.operator.notify({
          type: 'review_required',
          level: quality.passed ? 'info' : 'warning',
          title: quality.passed ? 'Content ready for review' : 'Content needs attention',
          message: `${script.title} ${quality.passed ? 'is ready for approval' : 'failed one or more quality checks'}`,
          data: { contentId, qualityScore: quality.score }
        });
      }

      return {
        contentId,
        title: script.title,
        topic: strategy.topic || null,
        status: productionData.status,
        reviewStatus,
        qualityScore: quality.score,
        scheduledFor: scheduleEntry ? scheduleEntry.publishTime : null,
        publicationState: publicationState({ qaPassed: quality.passed, control }),
        controlMode: control.mode
      };
    });
  }

  getStoryPool() {
    if (!this.storyPool) this.storyPool = new StoryPool(this.db);
    return this.storyPool;
  }

  /** Starts a Dark History job (same guards as startGenerationJob); the work runs in the background like every job. */
  async startDocumentaryJob(input = {}) {
    if (this.setupRequired || !this.agents.strategy) {
      const error = new Error('Finish setup with npm run walkthrough before generating content');
      error.status = 503;
      throw error;
    }
    if (['scheduler', 'autonomous_operator'].includes(input.source)) await this.readiness?.assertReady('Automated generation');
    const maxConcurrent = Math.max(1, parseInt(process.env.MAX_CONCURRENT_JOBS || '1', 10));
    if (this.activeJobs.size >= maxConcurrent) {
      const error = new Error(`Generation is busy (${this.activeJobs.size}/${maxConcurrent} active jobs). Try again when the current job finishes.`);
      error.status = 429;
      throw error;
    }
    const job = await this.db.createGenerationJob({ topic: null, style: 'documentary', length: 'short', source: input.source || 'manual' });
    await this.db.updateGenerationJob(job.id, { details: { pipeline: DOCUMENTARY_PIPELINE } });
    const controller = new AbortController();
    this.jobAbortControllers.set(job.id, controller);
    const work = this.runGenerationJob(job.id, { pipeline: DOCUMENTARY_PIPELINE, topic: null, style: 'documentary', length: 'short', strategyContext: {} }, controller.signal)
      .catch(error => this.logger.error(`Dark History job ${job.id} failed: ${error.message}`))
      .finally(() => {
        this.activeJobs.delete(job.id);
        this.jobAbortControllers.delete(job.id);
      });
    this.activeJobs.set(job.id, work);
    return job;
  }

  /**
   * One Dark History Short: claim the next pool story, write the grounded script, render, run every gate, schedule.
   * A failure never falls back to the old pipeline and never publishes weaker content: the story returns to the pool (rejected
   * after 3 failed attempts), the owner is alerted with the cause, and the next scheduler tick tries again.
   */
  async generateDocumentaryContent({ jobId = null, abortSignal = null } = {}) {
    await this.assertJobMayContinue(jobId, 'strategy');
    const pool = this.getStoryPool();
    const llm = this.agents.strategy?.aiTextService || this.agents.scriptWriter?.aiTextService;
    let storyId = null;
    let title = null;
    try {
      if (!llm) throw new Error('No text provider is configured for the grounded writer');
      const produced = await produceFromPool({
        pool, llm, generator: this.agents.production?.aiVideoGenerator, signal: abortSignal, logger: this.logger,
        onStage: async (stage, progress, info) => {
          if (info?.storyId) {
            storyId = info.storyId;
            title = info.topic;
            await this.db.updateGenerationJob(jobId, { details: { storyId, storyTitle: title } });
          }
          await this.updateJobStage(jobId, stage, progress);
        }
      });
      const { productionData } = produced;
      const profile = await this.db.getChannelProfile() || {};
      await this.updateJobStage(jobId, 'quality_review', 90);
      const contentId = await this.db.saveProductionData(productionData);
      await this.db.saveProductionSnapshot(productionData);
      if (!this.provenance) this.provenance = new ProvenanceService(this.db);
      productionData.provenance = await this.provenance.initialize(contentId, productionData);
      productionData.discoverability = this.discoverability
        ? await this.discoverability.auditProduction(productionData, profile, 'youtube')
        : null;
      const control = await resolveControlState(this.db);
      const quality = await this.operator.runQualityChecks(productionData, profile);
      const reviewStatus = quality.passed ? (control.approvalRequired ? 'needs_review' : 'approved') : 'needs_attention';
      await this.db.saveContentReview(contentId, {
        status: reviewStatus,
        qualityChecks: quality.checks,
        editorData: {},
        reviewNotes: quality.passed ? null : `Blocking checks failed: ${quality.blockingFailures.join(', ')}`,
        reviewedAt: control.approvalRequired ? null : new Date().toISOString()
      });
      let scheduleEntry = null;
      if (reviewStatus === 'approved') {
        scheduleEntry = await this.agents.publishing.scheduleContent(productionData);
        await this.db.updateProductionStatus(contentId, scheduleEntry ? 'scheduled' : productionData.status);
        if (!scheduleEntry) {
          throw Object.assign(new Error('The Short passed every gate but no publish slot was created'), { code: 'DOCUMENTARY_NOT_SCHEDULED' });
        }
      } else {
        await this.db.updateProductionStatus(contentId, reviewStatus);
        if (!quality.passed) {
          throw Object.assign(new Error(`Quality gates rejected the Short: ${quality.blockingFailures.join(', ')}`), { code: 'AUTONOMOUS_QUALITY_REJECTED', status: 409 });
        }
        await this.operator.notify({
          type: 'review_required', level: 'info', title: 'Content ready for review',
          message: `${productionData.script.title} is ready for approval`, data: { contentId, qualityScore: quality.score }
        });
      }
      return {
        contentId,
        title: productionData.script.title,
        topic: productionData.strategy.topic,
        status: productionData.status,
        reviewStatus,
        qualityScore: quality.score,
        scheduledFor: scheduleEntry ? scheduleEntry.publishTime : null,
        publicationState: publicationState({ qaPassed: quality.passed, control }),
        controlMode: control.mode
      };
    } catch (error) {
      // produceFromPool already returned the story for its own failures; a failure after it (gates, schedule) is released here
      if (storyId && error.attempts === undefined) await releaseAfterFailure(pool, storyId, title, error);
      await this.alertDocumentaryFailure(error, jobId);
      error.alerted = true;
      throw error;
    }
  }

  async alertDocumentaryFailure(error, jobId) {
    if (['AUTOMATION_PAUSED', 'JOB_CANCELLED'].includes(error.code)) return;
    const attempts = error.attempts ? ` (attempt ${error.attempts} of 3 for this story)` : '';
    await this.operator.notify({
      type: 'documentary_failure',
      level: 'error',
      title: error.storyRejected ? 'Dark History story rejected after repeated failures' : 'Dark History production failed',
      message: `${error.storyTitle ? `"${error.storyTitle}": ` : ''}${String(error.message).slice(0, 900)}${attempts}. Nothing was published and no other kind of Short was made instead; the next scheduler tick tries again${error.storyRejected ? ' with another story' : ''}.`,
      data: { jobId, storyId: error.storyId || null, attempts: error.attempts || null },
      dedupeKey: `documentary_failure:${error.code || 'error'}:${String(error.message).slice(0, 60)}`,
      dedupeMinutes: 360
    });
  }

  /** A documentary job that was running when the process stopped: close it and give its story back (not the story's fault). */
  async releaseInterruptedDocumentaryJobs() {
    try {
      const rows = await this.db.getAllRows("SELECT id, details FROM generation_jobs WHERE status = 'interrupted'");
      for (const row of rows) {
        const details = typeof row.details === 'string' ? JSON.parse(row.details || '{}') : (row.details || {});
        if (details.pipeline !== DOCUMENTARY_PIPELINE) continue;
        if (details.storyId) await this.getStoryPool().release(details.storyId, { reason: 'the job was interrupted by a restart', countAttempt: false });
        await this.db.updateGenerationJob(row.id, { status: 'failed', error: 'Interrupted by a restart; the story went back to the pool and the scheduler starts a new job', details: { storyId: null } });
      }
    } catch (error) {
      this.logger.warn(`Could not release interrupted Dark History jobs: ${error.message}`);
    }
  }

  async runGenerationStage(jobId, stage, progress, producer) {
    if (jobId) await this.assertJobMayContinue(jobId, stage);
    if (!jobId) {
      await this.updateJobStage(jobId, stage, progress);
      return producer();
    }
    if (!this.recovery) {
      this.recovery = new GenerationRecoveryService(this.db, {
        logger: this.logger,
        updateJobStage: (...args) => this.updateJobStage(...args)
      });
    }
    return this.recovery.run(jobId, stage, progress, producer);
  }

  validateEditorData(input = {}, existing = {}) {
    const output = { ...existing };
    if (input.title !== undefined) {
      const title = String(input.title).trim();
      if (!title || title.length > 100) throw new Error('Title must be between 1 and 100 characters');
      output.title = title;
    }
    if (input.description !== undefined) {
      const description = String(input.description).trim();
      if (description.length > 5000) throw new Error('Description must be 5,000 characters or less');
      output.description = description;
    }
    if (input.tags !== undefined) {
      const tags = Array.isArray(input.tags)
        ? input.tags
        : String(input.tags).split(',');
      output.tags = tags.map(tag => String(tag).trim()).filter(Boolean).slice(0, 30);
    }
    if (input.publishTime !== undefined) {
      const date = new Date(input.publishTime);
      if (Number.isNaN(date.getTime())) throw new Error('Publish time must be a valid date');
      if (date.getTime() <= Date.now() + 60000) {
        throw new Error('Publish time must be at least one minute in the future; use the explicit publish-now action for immediate publishing');
      }
      output.publishTime = date.toISOString();
    }
    if (input.privacyStatus !== undefined) {
      if (!['private', 'unlisted', 'public'].includes(input.privacyStatus)) throw new Error('Invalid privacy status');
      output.privacyStatus = input.privacyStatus;
    }
    if (input.factChecked !== undefined) output.factChecked = input.factChecked === true;
    if (input.rightsConfirmed !== undefined) output.rightsConfirmed = input.rightsConfirmed === true;
    const experiment = output.packagingExperiment;
    if (input.selectedTitleVariant !== undefined) {
      const selected = Number(input.selectedTitleVariant);
      if (!Number.isInteger(selected) || !experiment?.titleVariants?.[selected]) {
        throw new Error('Selected title variant is invalid');
      }
      output.selectedTitleVariant = selected;
    }
    if (input.selectedThumbnailVariant !== undefined) {
      const selected = Number(input.selectedThumbnailVariant);
      if (!Number.isInteger(selected) || !experiment?.thumbnailVariants?.[selected]) {
        throw new Error('Selected thumbnail variant is invalid');
      }
      output.selectedThumbnailVariant = selected;
    }
    return output;
  }

  buildTitleExperimentVariants(title) {
    const control = String(title || '').trim().slice(0, 100);
    const withoutPunctuation = control.replace(/[.!?]+$/, '');
    return [
      { label: 'Control', title: control },
      { label: 'Step-by-step', title: `${withoutPunctuation}: Step-by-Step`.slice(0, 100) },
      { label: 'Curiosity', title: `${withoutPunctuation}: What Most People Miss`.slice(0, 100) }
    ];
  }

  async preparePackagingExperiment(thumbnail, productionData, seoData, script) {
    const approved = await this.db.listLearningRecommendations({ status: 'approved', limit: 25 });
    const recommendation = approved.find(item => item.proposedChange?.experiment === 'title_thumbnail_variant');
    if (!recommendation) return null;
    try {
      const generated = await this.agents.thumbnailDesigner.generateABVariants(thumbnail.concept);
      return {
        sourceRecommendationId: recommendation.id,
        hypothesis: recommendation.title,
        status: 'draft',
        titleVariants: Array.isArray(seoData.packagingVariants) && seoData.packagingVariants.length
          ? seoData.packagingVariants.map(item => ({
              label: item.label,
              title: item.title,
              mode: item.mode,
              rationale: item.rationale,
              score: item.score,
              thumbnailComplementarity: item.thumbnailComplementarity
            }))
          : this.buildTitleExperimentVariants(seoData.title || script.title),
        thumbnailVariants: [
          { label: 'Control', path: productionData.assets?.thumbnail?.path, concept: thumbnail.concept },
          ...generated
        ],
        createdAt: new Date().toISOString()
      };
    } catch (error) {
      this.logger.warn(`Packaging experiment preparation failed without blocking production: ${error.message}`);
      return null;
    }
  }

  validateProfile(input) {
    const textFields = ['channelName', 'goal', 'targetAudience', 'brandVoice', 'defaultStyle', 'callToAction', 'visualStyle', 'timezone'];
    const result = {};
    for (const field of textFields) {
      if (input[field] !== undefined) {
        const value = String(input[field]).trim();
        if (value.length > 500) throw new Error(`${field} is too long`);
        result[field] = value;
      }
    }
    if (input.bannedTopics !== undefined) {
      const topics = Array.isArray(input.bannedTopics) ? input.bannedTopics : String(input.bannedTopics).split(',');
      result.bannedTopics = topics.map(topic => String(topic).trim()).filter(Boolean).slice(0, 50);
    }
    return result;
  }

  decorateContentBundle(bundle) {
    const experiment = bundle.editorData?.packagingExperiment;
    return {
      ...bundle,
      scenes: (bundle.scenes || []).map(scene => this.scenes
        ? this.scenes.decorateScene(scene, bundle.id)
        : scene),
      assetUrls: {
        video: bundle.assets?.finalVideo?.path && !bundle.assets?.finalVideo?.simulated ? `/api/content/${bundle.id}/asset/video` : null,
        thumbnail: bundle.assets?.thumbnail?.path ? `/api/content/${bundle.id}/asset/thumbnail` : null,
        experimentThumbnails: (experiment?.thumbnailVariants || []).map((_variant, index) =>
          `/api/content/${bundle.id}/asset/experiment-thumbnail-${index}`
        ),
        captions: bundle.assets?.captions?.path ? `/api/content/${bundle.id}/asset/captions` : null,
        script: bundle.assets?.script?.originalPath ? `/api/content/${bundle.id}/asset/script` : null
      }
    };
  }

  async refreshContentReview(productionId, reviewNotes) {
    const bundle = await this.db.getProductionBundle(productionId);
    if (!bundle) return null;
    const profile = await this.db.getChannelProfile() || {};
    const quality = await this.operator.runQualityChecks({
      ...bundle,
      scheduledPublishTime: bundle.scheduled_publish_time
    }, profile);
    const status = quality.passed ? 'needs_review' : 'needs_attention';
    return this.db.saveContentReview(productionId, {
      status,
      editorData: { ...(bundle.editorData || {}), factChecked: false, rightsConfirmed: false },
      qualityChecks: quality.checks,
      reviewNotes: reviewNotes || (quality.passed ? null : `Blocking checks failed: ${quality.blockingFailures.join(', ')}`),
      reviewedAt: null
    });
  }

  async approveContent(productionId, input) {
    const bundle = await this.db.getProductionBundle(productionId);
    if (!bundle) {
      const error = new Error('Content not found');
      error.status = 404;
      throw error;
    }
    if (bundle.schedule?.status === 'published') {
      const error = new Error('Content is already published');
      error.status = 409;
      throw error;
    }

    const editorData = this.validateEditorData(input, bundle.editorData);
    const packagingExperiment = editorData.packagingExperiment;
    const thumbnailVariant = packagingExperiment?.thumbnailVariants?.[editorData.selectedThumbnailVariant];
    const titleVariant = packagingExperiment?.titleVariants?.[editorData.selectedTitleVariant];
    if (titleVariant && input.title === undefined) editorData.title = titleVariant.title;
    if (!editorData.factChecked || !editorData.rightsConfirmed) {
      const error = new Error('Confirm the factual review and media rights checks before approval');
      error.status = 409;
      throw error;
    }
    const productionData = {
      id: bundle.id,
      status: bundle.status,
      strategy: bundle.strategy,
      script: { ...bundle.script, title: editorData.title || bundle.script.title },
      thumbnail: bundle.thumbnail,
      seo: {
        ...bundle.seo,
        title: editorData.title || bundle.seo.title,
        description: editorData.description || bundle.seo.description,
        tags: editorData.tags || bundle.seo.tags
      },
      assets: thumbnailVariant
        ? { ...bundle.assets, thumbnail: { ...bundle.assets.thumbnail, path: thumbnailVariant.path } }
        : bundle.assets,
      timeline: bundle.timeline,
      scheduledPublishTime: editorData.publishTime || input.publishTime || bundle.scheduled_publish_time,
      priority: bundle.priority,
      estimatedDuration: bundle.estimated_duration,
      privacyStatus: editorData.privacyStatus || process.env.DEFAULT_PRIVACY_STATUS || 'private',
      provenance: bundle.provenance,
      containsSyntheticMedia: bundle.provenance?.containsSyntheticMedia === true,
      scenes: bundle.scenes || []
    };
    const profile = await this.db.getChannelProfile() || {};
    const quality = await this.operator.runQualityChecks(productionData, profile);
    if (!quality.passed) {
      await this.db.saveContentReview(bundle.id, {
        status: 'needs_attention', editorData, qualityChecks: quality.checks,
        reviewNotes: `Blocking checks failed: ${quality.blockingFailures.join(', ')}`
      });
      const error = new Error('Content still has blocking quality failures');
      error.status = 409;
      error.quality = quality;
      throw error;
    }

    let scheduleEntry = bundle.schedule;
    if (!scheduleEntry) {
      scheduleEntry = await this.agents.publishing.scheduleContent(productionData);
    } else if (scheduleEntry.status !== 'published') {
      scheduleEntry.title = productionData.script.title;
      scheduleEntry.publishTime = productionData.scheduledPublishTime;
      scheduleEntry.status = 'scheduled';
      scheduleEntry.metadata = {
        ...scheduleEntry.metadata,
        seo: productionData.seo,
        thumbnail: productionData.assets.thumbnail,
        video: productionData.assets.finalVideo,
        audio: productionData.assets.audio,
        captions: productionData.assets.captions,
        privacyStatus: editorData.privacyStatus || process.env.DEFAULT_PRIVACY_STATUS || 'private',
        containsSyntheticMedia: productionData.containsSyntheticMedia
      };
      await this.db.updateScheduleEntry(scheduleEntry);
      await this.agents.publishing.loadPublishQueue();
    }
    if (!scheduleEntry) {
      const finalVideoReady = Boolean(
        productionData.assets?.finalVideo?.path &&
        productionData.assets?.finalVideo?.simulated !== true &&
        String(productionData.assets.finalVideo.path).toLowerCase().endsWith('.mp4')
      );
      const error = new Error(
        !finalVideoReady
          ? 'A real MP4 is required before content can be approved for scheduling'
          : 'Choose an explicit future publish time before approving this content for scheduling'
      );
      error.status = 409;
      throw error;
    }

    await this.db.saveContentReview(bundle.id, {
      status: 'approved', editorData, qualityChecks: quality.checks,
      reviewNotes: input.reviewNotes || 'Approved by operator', reviewedAt: new Date().toISOString()
    });
    await this.db.updateProductionStatus(bundle.id, 'scheduled');
    await this.operator.notify({
      type: 'content_approved', level: 'success', title: 'Content approved',
      message: `${productionData.script.title} is scheduled for ${scheduleEntry.publishTime}`,
      data: { productionId, publishTime: scheduleEntry.publishTime }
    });
    return { productionId, reviewStatus: 'approved', qualityScore: quality.score, schedule: scheduleEntry };
  }

  async start() {
    const initialized = await this.initialize();
    
    if (!initialized) {
      console.log(chalk.red('\n❌ Failed to initialize. Please check your configuration.'));
      process.exit(1);
    }
    
    const PORT = process.env.PORT || 3456;
    const HOST = process.env.HOST || '127.0.0.1';
    this.server = this.app.listen(PORT, HOST, () => {
      console.log(chalk.green(`\n✅ YouTube Automation Agent running on port ${PORT}`));
      console.log(chalk.gray('─'.repeat(50)));
      console.log(chalk.white('📊 Dashboard: ') + chalk.cyan(`http://${HOST}:${PORT}`));
      console.log(chalk.white('🔧 API Health: ') + chalk.cyan(`http://localhost:${PORT}/health`));
      console.log(chalk.white('📅 Schedule: ') + chalk.cyan(`http://localhost:${PORT}/schedule`));
      console.log(chalk.white('📈 Analytics: ') + chalk.cyan(`http://localhost:${PORT}/analytics`));
      console.log(chalk.gray('─'.repeat(50)));
      if (this.setupRequired) {
        console.log(chalk.yellow('\n⚙️  Setup is required. The dashboard is available; run npm run walkthrough to enable generation.'));
      } else if (this.scheduler?.isEnabled === false) {
        console.log(chalk.yellow('\n⏸️  Automation is paused. Manual generation remains available; scheduled generation and publishing are disabled.'));
      } else {
        console.log(chalk.yellow('\n🤖 Automation is active. Approved content will be published on schedule.'));
      }
    });
  }
}

// Start the agent
if (require.main === module) {
  const agent = new YouTubeAutomationAgent();
  installProcessGuards({
    logger: new Logger('Process'),
    stopScheduler: async () => { if (agent.scheduler?.stopAutomation) await agent.scheduler.stopAutomation(); },
    closeServer: () => new Promise(resolve => (agent.server ? agent.server.close(() => resolve()) : resolve())),
  });
  agent.start().catch(error => {
    console.error(chalk.red('Fatal error:'), error);
    process.exit(1);
  });
}

module.exports = { YouTubeAutomationAgent };
