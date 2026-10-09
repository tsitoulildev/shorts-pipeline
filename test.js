const { Database } = require('./database/db');
const { Logger } = require('./utils/logger');
const { CredentialManager } = require('./utils/credential-manager');
const { AudienceEngagementService } = require('./utils/audience-engagement-service');
const { DailyAutomation } = require('./schedules/daily-automation');
const chalk = require('chalk');
const path = require('path');
const { ProductionReadinessService } = require('./utils/production-readiness-service');
const { normalizeTags, validateYouTubeMetadata } = require('./utils/youtube-metadata-validator');

class SystemTest {
  constructor() {
    this.logger = new Logger('SystemTest');
    this.testResults = {};
  }

  async runAllTests() {
    console.log(chalk.cyan.bold('\n🧪 YouTube Automation Agent - System Test'));
    console.log(chalk.gray('═'.repeat(60)));
    
    const tests = [
      { name: 'Database Connection', test: () => this.testDatabase() },
      { name: 'Production Persistence', test: () => this.testProductionPersistence() },
      { name: 'Automation Events Table', test: () => this.testAutomationEventsTable() },
      { name: 'Operator Workflow API', test: () => this.testOperatorWorkflowAPI() },
      { name: 'Autonomous Channel Operator', test: () => this.testAutonomousChannelOperator() },
      { name: 'Autonomous Planner JSON Reliability', test: () => this.testAutonomousPlannerJsonReliability() },
      { name: 'Closed-loop Channel Learning', test: () => this.testChannelLearningLoop() },
      { name: 'Horror Shorts Learning Loop', test: () => this.testHorrorLearningLoop() },
      { name: 'Controlled Growth Experiments Studio', test: () => this.testGrowthExperimentsStudio() },
      { name: 'Outcome and ROI Studio', test: () => this.testOutcomeROIStudio() },
      { name: 'Scene-Aware Retention Studio', test: () => this.testSceneAwareRetentionStudio() },
      { name: 'Production Readiness Gate', test: () => this.testProductionReadinessGate() },
      { name: 'Durable Multi-Provider Video Generation', test: () => this.testVideoProviderLayer() },
      { name: 'Scene Repair Studio', test: () => this.testSceneRepairStudio() },
      { name: 'Narration Reliability and Recovery', test: () => this.testNarrationReliability() },
      { name: 'Free Local Voice Fallback', test: () => this.testFreeLocalVoiceFallback() },
      { name: 'Documentary Orchestration Contract', test: () => this.testDocumentaryOrchestrationContract() },
      { name: 'Safe Provider Readiness Defaults', test: () => this.testSafeProviderReadinessDefaults() },
      { name: 'Live Provider Smoke CLI', test: () => this.testLiveProviderSmokeCLI() },
      { name: 'Current Gemini Provider Defaults', test: () => this.testCurrentGeminiProviderDefaults() },
      { name: 'Gemini Readiness Thinking Budget', test: () => this.testGeminiReadinessThinkingBudget() },
      { name: 'Gemini Free Model Failover', test: () => this.testGeminiFreeModelFailover() },
      { name: 'Research and Provenance Desk', test: () => this.testProvenanceDesk() },
      { name: 'DarkzSEO Discoverability Preflight', test: () => this.testDiscoverabilityPreflight() },
      { name: 'Open Issue Regressions', test: () => this.testOpenIssueRegressions() },
      { name: 'Resumable Generation Checkpoints', test: () => this.testResumableGenerationCheckpoints() },
      { name: 'API Validation and Security', test: () => this.testAPIValidationAndSecurity() },
      { name: 'Publishing Safety', test: () => this.testPublishingSafety() },
      { name: 'Upload Authorization Policy', test: () => this.testUploadAuthorizationPolicy() },
      { name: 'Multi-Provider Credential Validation', test: () => this.testCredentialValidation() },
      { name: 'AI Text Service Token Compatibility', test: () => this.testAITextServiceTokenParams() },
      { name: 'AI Text Provider Failover', test: () => this.testAITextProviderFailover() },
      { name: 'Free LLM Catalog Integrity', test: () => this.testFreeLLMCatalogIntegrity() },
      { name: 'Free LLM Cooldown Tracking', test: () => this.testLLMCooldownTracker() },
      { name: 'Free LLM Sensitive Task Routing', test: () => this.testFreeLLMSensitiveRouting() },
      { name: 'Free-Only Text Provider Selection', test: () => this.testFreeOnlyPrimarySelection() },
      { name: 'Evidence-Aware Visual Handoff', test: () => this.testEvidenceAwareVisualHandoff() },
      { name: 'Agent Communication Contracts', test: () => this.testAgentCommunicationContracts() },
      { name: 'Placeholder Scheduling Guard', test: () => this.testPlaceholderSchedulingGuard() },
      { name: 'FFmpeg Resolution', test: () => this.testFFmpegResolution() },
      { name: 'Final Video Technical Gates', test: () => this.testFinalVideoTechnicalGates() },
      { name: 'Gemini Media Provider Selection', test: () => this.testGeminiMediaProvider() },
      { name: 'Slideshow Renderer', test: () => this.testSlideshowRenderer() },
      { name: 'Evergreen Template Topics', test: () => this.testEvergreenTopics() },
      { name: 'Thumbnail Creative Direction', test: () => this.testThumbnailCreativeDirection() },
      { name: 'Documentary Packaging Strategy', test: () => this.testDocumentaryPackagingStrategy() },
      { name: 'Documentary Production Direction', test: () => this.testDocumentaryProductionDirection() },
      { name: 'Evidence-Based Publishing Strategy', test: () => this.testEvidenceBasedPublishingStrategy() },
      { name: 'Contextual Analytics Interpretation', test: () => this.testContextualAnalyticsInterpretation() },
      { name: 'Walkthrough Module', test: () => this.testWalkthroughModule() },
      { name: 'Logger System', test: () => this.testLogger() },
      { name: 'Directory Structure', test: () => this.testDirectories() },
      { name: 'Agent Loading', test: () => this.testAgentLoading() },
      { name: 'Configuration Files', test: () => this.testConfiguration() },
      { name: 'Audience Comment Store', test: () => this.testAudienceCommentStore() },
      { name: 'Engagement Insight Store', test: () => this.testEngagementInsightStore() },
      { name: 'Reply Draft Lifecycle Store', test: () => this.testReplyDraftStore() },
      { name: 'YouTube Scope Detection', test: () => this.testYouTubeScopeDetection() },
      { name: 'Audience Comment Sync', test: () => this.testAudienceCommentSync() },
      { name: 'Audience Comment Analysis', test: () => this.testAudienceCommentAnalysis() },
      { name: 'Audience Idea Mining', test: () => this.testAudienceIdeaMining() },
      { name: 'Reply Drafting', test: () => this.testReplyDrafting() },
      { name: 'Reply Approval and Posting', test: () => this.testReplyApprovalAndPosting() },
      { name: 'Engagement AI Provider Wiring', test: () => this.testEngagementAIProviderWiring() },
      { name: 'Engagement Sync Schedule', test: () => this.testEngagementSyncSchedule() },
      { name: 'Growth Experiment Refresh Schedule', test: () => this.testGrowthExperimentRefreshSchedule() }
    ];

    let passed = 0;
    let failed = 0;

    for (const { name, test } of tests) {
      try {
        console.log(chalk.cyan(`\n🔍 Testing ${name}...`));
        await test();
        console.log(chalk.green(`✅ ${name} - PASSED`));
        this.testResults[name] = { status: 'PASSED' };
        passed++;
      } catch (error) {
        console.log(chalk.red(`❌ ${name} - FAILED`));
        console.log(chalk.red(`   Error: ${error.message}`));
        if (process.env.GITHUB_ACTIONS === 'true') {
          console.log(`::error title=Test failed: ${name}::${String(error.message).replace(/[\r\n]+/g, ' ').slice(0, 900)}`);
        }
        this.testResults[name] = { status: 'FAILED', error: error.message };
        failed++;
      }
    }

    // Display summary
    console.log(chalk.gray('\n' + '═'.repeat(60)));
    console.log(chalk.cyan.bold('📊 Test Summary:'));
    console.log(chalk.green(`✅ Passed: ${passed}`));
    console.log(chalk.red(`❌ Failed: ${failed}`));
    console.log(chalk.cyan(`📝 Total: ${passed + failed}`));

    if (failed === 0) {
      console.log(chalk.green.bold('\n🎉 All tests passed! System is ready to run.'));
      console.log(chalk.cyan('Run: npm start'));
    } else {
      console.log(chalk.yellow.bold('\n⚠️  Some tests failed. Please check the errors above.'));
      console.log(chalk.cyan('Run: npm run setup (to reconfigure)'));
    }

    return failed === 0;
  }

  async testDatabase() {
    const db = new Database();
    await db.initialize();
    
    // Test basic operations
    const stats = await db.getStats();
    if (!stats) throw new Error('Failed to get database stats');
    
    // Test settings
    await db.setSetting('test_key', 'test_value', 'Test setting');
    const value = await db.getSetting('test_key');
    if (value !== 'test_value') throw new Error('Settings read/write failed');
    
    await db.close();
    this.logger.info('Database test completed successfully');
  }

  async testProductionPersistence() {
    const db = new Database();
    await db.initialize();

    const production = {
      id: `prod_test_${Date.now()}`,
      status: 'processing',
      assets: { finalVideo: { path: 'placeholder.mp4' } },
      timeline: { created: new Date().toISOString() },
      scheduledPublishTime: new Date().toISOString(),
      priority: 25,
      estimatedDuration: '1:00'
    };

    const firstId = await db.saveProductionData(production);
    if (firstId !== production.id) {
      throw new Error('saveProductionData did not return the production id');
    }

    const secondId = await db.saveProductionData({
      ...production,
      status: 'ready',
      priority: 90
    });
    if (secondId !== production.id) {
      throw new Error('saveProductionData upsert did not return the production id');
    }

    const saved = await db.getRow('SELECT status, priority FROM productions WHERE id = ?', [production.id]);
    if (!saved || saved.status !== 'ready' || saved.priority !== 90) {
      throw new Error('saveProductionData did not upsert the existing production row');
    }

    await db.executeQuery('DELETE FROM productions WHERE id = ?', [production.id]);
    await db.close();
    this.logger.info('Production persistence test completed successfully');
  }

  async testAutomationEventsTable() {
    const db = new Database();
    await db.initialize();

    await db.executeQuery(
      'INSERT INTO automation_events (event_type, status, data, created_at) VALUES (?, ?, ?, datetime("now"))',
      ['test_event', 'success', JSON.stringify({ ok: true })]
    );

    const row = await db.getRow(
      'SELECT event_type, status, data FROM automation_events WHERE event_type = ? ORDER BY created_at DESC',
      ['test_event']
    );

    if (!row || row.status !== 'success') {
      throw new Error('automation_events row was not persisted');
    }

    await db.executeQuery('DELETE FROM automation_events WHERE event_type = ?', ['test_event']);
    await db.close();
    this.logger.info('Automation events table test completed successfully');
  }

  async testOperatorWorkflowAPI() {
    const previousApiKey = process.env.API_KEY;
    process.env.API_KEY = 'local-test-api-key';
    try {
    const { YouTubeAutomationAgent } = require('./index');
    const { OperatorService } = require('./utils/operator-service');
    const db = new Database();
    await db.initialize();
    let server;
    let job;
    let learningRecommendation;

    try {
      job = await db.createGenerationJob({ topic: 'Operator workflow test', style: 'explainer', length: 'short' });
      await db.updateGenerationJob(job.id, { status: 'running', stage: 'script', progress: 25 });
      const updated = await db.getGenerationJob(job.id);
      if (updated.stage !== 'script' || updated.progress !== 25) {
        throw new Error('Generation job progress was not persisted');
      }

      const operator = new OperatorService(db);
      operator.notify = async () => null;
      const quality = await operator.runQualityChecks({
        script: { title: 'Test title', fullScript: 'x'.repeat(250) },
        seo: { title: 'Test title', description: 'x'.repeat(80), tags: ['one', 'two', 'three'] },
        assets: { finalVideo: { path: 'placeholder.info', simulated: true } }
      }, { bannedTopics: [] });
      if (quality.passed || !quality.blockingFailures.includes('video')) {
        throw new Error('Quality gate did not block a simulated video');
      }

      const agent = new YouTubeAutomationAgent();
      agent.db = db;
      agent.operator = operator;
      agent.agents = {
        analytics: {
          getRecentAnalytics: async () => ({ totalVideos: 0, averagePerformanceScore: 0, topPerformers: [], insights: [] })
        }
      };
      agent.scheduler = {
        isEnabled: true,
        pauseAutomation: async function() { this.isEnabled = false; },
        resumeAutomation: async function() { this.isEnabled = true; }
      };
      agent.isInitialized = true;
      agent.setupAPI();
      server = await new Promise(resolve => {
        const running = agent.app.listen(0, () => resolve(running));
      });
      const { port } = server.address();
      const apiHeaders = { 'Content-Type': 'application/json', ...(process.env.API_KEY ? { 'x-api-key': process.env.API_KEY } : {}) };
      const response = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
      const dashboard = await response.json();
      if (
        !response.ok ||
        !Array.isArray(dashboard.jobs) ||
        !Array.isArray(dashboard.pipeline) ||
        !Array.isArray(dashboard.operatorRuns)
      ) {
        throw new Error('Operator dashboard API did not return its data contract');
      }
      const unavailableStart = await fetch(`http://127.0.0.1:${port}/api/operator/start`, {
        method: 'POST',
        headers: apiHeaders,
        body: '{}'
      });
      if (unavailableStart.status !== 503) {
        throw new Error('Autonomous operator did not fail closed when its strategy agent was unavailable');
      }

      learningRecommendation = await db.saveLearningRecommendation({
        fingerprint: `operator-api-${Date.now()}`,
        category: 'format',
        title: 'Test evidence-backed recommendation',
        rationale: 'Created only for API contract verification.',
        evidence: { sampleSize: 4 },
        proposedChange: { target: 'future_plans', prefer: 'tutorial' },
        confidence: 'medium'
      });
      const approveLearning = await fetch(
        `http://127.0.0.1:${port}/api/learning/recommendations/${learningRecommendation.id}/approve`,
        { method: 'POST', headers: apiHeaders, body: '{}' }
      );
      const approvedLearning = await approveLearning.json();
      if (!approveLearning.ok || approvedLearning.result?.status !== 'approved') {
        throw new Error('Learning recommendation review API did not persist approval');
      }
    } finally {
      if (server) await new Promise(resolve => server.close(resolve));
      if (job) await db.executeQuery('DELETE FROM generation_jobs WHERE id = ?', [job.id]);
      if (learningRecommendation) await db.executeQuery('DELETE FROM learning_recommendations WHERE id = ?', [learningRecommendation.id]);
      await db.close();
    }

    this.logger.info('Operator workflow API test completed successfully');
    } finally {
      if (previousApiKey === undefined) delete process.env.API_KEY;
      else process.env.API_KEY = previousApiKey;
    }
  }
  async testAutonomousChannelOperator() {
    const { ContentStrategyAgent } = require('./agents/content-strategy-agent');
    const { AutonomousChannelOperator } = require('./utils/autonomous-channel-operator');
    const db = new Database();
    await db.initialize();
    const previousStrategy = await db.getChannelStrategy();
    let run;
    let recoverableJob;

    try {
      const strategy = await db.saveChannelStrategy({
        objective: 'Grow an original Horror Stickman Shorts channel',
        audience: 'Global English horror Shorts viewers',
        valueProposition: 'Original psychological micro-horror in a consistent Dark Stickman visual universe',
        contentPillars: ['Everyday Situations Gone Wrong', 'Impossible Messages, Voices & Sounds'],
        cadencePerWeek: 28,
        videosPerRun: 2,
        defaultFormat: 'story',
        defaultLength: 'short',
        successMetric: 'Retention, completion, returning viewers, and subscriber growth',
        constraints: 'Original fiction only; no semantic duplicates, true crime, gore-first content, or brand drift',
        status: 'active'
      });
      if (strategy.contentPillars.length !== 2 || strategy.cadence_per_week !== 28 || strategy.default_length !== 'short') {
        throw new Error('Horror Stickman channel strategy was not persisted correctly');
      }

      const strategyAgent = new ContentStrategyAgent(db, {});
      const validNicheCandidate = {
        topic: 'She Got a Text From Her Own Bedroom While She Was Alone',
        idea: 'Message from the empty room',
        storyFamily: 'phone-message horror',
        everydayAnchor: 'alone in an apartment at night',
        fearMechanism: 'her phone receives a message from a device inside the room she has not entered',
        hook: 'Her phone buzzed from inside the locked bedroom.',
        scrollStopMoment: 'A lone dark stickman stares at a glowing phone while a locked bedroom door sits behind her.',
        visualWhy: 'One figure, one locked door, and one impossible signal are readable instantly.',
        visualVariety: ['phone buzz in hallway', 'locked bedroom door', 'message changes as she approaches', 'shadow visible under the door'],
        curiosityAngle: 'Who is sending the message from the locked room?',
        escalationLadder: ['the sender describes her movement', 'the message says not to open the door just before the handle moves'],
        payoff: 'The final message comes from her own number and says that the person outside the bedroom is not her.',
        fitRationale: 'Relatable apartment setting, immediate impossible signal, two escalations, and a recontextualizing final beat.',
        storyEngine: 'impossible-message',
        autonomyRisk: 'low',
        nicheFit: 10,
        visualStrength: 10,
        curiosityGap: 10,
        visualVarietyScore: 9,
        retentionPotential: 10,
        originalityScore: 10,
        brandFit: 10,
        twistScore: 9,
        premiseLegibility: 10,
        payoffStrength: 9,
        fictional: true
      };
      if (!strategyAgent.isApprovedNicheCandidate(validNicheCandidate)) {
        throw new Error('Strong Horror Stickman candidate failed the locked niche contract');
      }

      const trueCrimeCandidate = { ...validNicheCandidate, topic: 'True Crime: The Real Murder in Apartment 6', storyEngine: 'ordinary-to-impossible' };
      if (strategyAgent.isApprovedNicheCandidate(trueCrimeCandidate)) {
        throw new Error('True-crime dependency bypassed the Horror Stickman contract');
      }
      const weakOriginality = { ...validNicheCandidate, originalityScore: 7 };
      if (strategyAgent.isApprovedNicheCandidate(weakOriginality)) {
        throw new Error('Low-originality premise bypassed the Horror Stickman originality gate');
      }
      const invalidEngineCandidate = { ...validNicheCandidate, storyEngine: 'generic-monster' };
      if (strategyAgent.isApprovedNicheCandidate(invalidEngineCandidate)) {
        throw new Error('Candidate without a canonical Horror Stickman story engine was accepted');
      }

      strategyAgent.analyzeTrends = async function() {
        this.trendingTopics = [{ topic: 'Apartment horror short pattern', score: 8, sources: ['trending'], evidence: [] }];
        this.competitorData = [];
      };
      strategyAgent.aiTextService = { isAvailable: () => false };
      const planned = await strategyAgent.researchAndPlanChannel(strategy);
      if (
        planned.plan.length !== 2 ||
        planned.plan.some(item => item.fictional !== true || item.length !== 'short' || item.sourceUrls.length !== 0)
      ) {
        throw new Error('Strategy did not produce a fiction-only Horror Stickman autonomous plan');
      }

      const receivedInputs = [];
      let resumedJobs = 0;
      const operator = new AutonomousChannelOperator(db, {
        researchAndPlan: async () => planned,
        startGenerationJob: async input => {
          receivedInputs.push(input);
          return { id: `fake-job-${receivedInputs.length}` };
        },
        waitForGenerationJob: async jobId => ({
          id: jobId,
          status: 'completed',
          production_id: `production-${jobId}`,
          details: { reviewStatus: 'needs_review' }
        }),
        resumeGenerationJob: async jobId => {
          resumedJobs++;
          await db.updateGenerationJob(jobId, { status: 'completed', productionId: `production-${jobId}` });
          return db.getGenerationJob(jobId);
        }
      });
      run = await operator.start(strategy);
      await operator.activeRuns.get(run.id);
      const completed = await db.getOperatorRun(run.id);
      if (
        completed.status !== 'waiting_review' ||
        completed.generatedJobs.length !== 2 ||
        receivedInputs.some(input => input.source !== 'autonomous_operator' || !input.strategyContext?.angle) ||
        receivedInputs[0].strategyContext.researchSources.length !== 0
      ) {
        throw new Error('Autonomous operator did not execute the planned workflow');
      }

      recoverableJob = await db.createGenerationJob({ topic: planned.plan[0].topic, source: 'autonomous_operator' });
      await db.updateGenerationJob(recoverableJob.id, { status: 'interrupted', stage: 'script' });
      const interruptedJobs = completed.generatedJobs.map((item, index) => index === 0
        ? { ...item, jobId: recoverableJob.id, status: 'interrupted', reviewStatus: null }
        : item);
      await db.updateOperatorRun(run.id, {
        status: 'interrupted',
        stage: 'producing_1_of_2',
        progress: 40,
        generatedJobs: interruptedJobs,
        error: 'The application restarted before this operator run finished',
        completedAt: new Date().toISOString()
      });
      await operator.resume(run.id, strategy);
      await operator.activeRuns.get(run.id);
      const recoveredRun = await db.getOperatorRun(run.id);
      if (resumedJobs !== 1 || recoveredRun.status !== 'waiting_review' || recoveredRun.generatedJobs[0].status !== 'completed') {
        throw new Error('Autonomous operator did not continue from its saved plan and interrupted job');
      }
    } finally {
      if (run) {
        const stored = await db.getOperatorRun(run.id);
        for (const item of stored?.generatedJobs || []) {
          if (item.ideaId) await db.executeQuery('DELETE FROM content_ideas WHERE id = ?', [item.ideaId]);
        }
        await db.executeQuery('DELETE FROM operator_runs WHERE id = ?', [run.id]);
      }
      if (previousStrategy) {
        await db.saveChannelStrategy({
          objective: previousStrategy.objective,
          audience: previousStrategy.audience,
          valueProposition: previousStrategy.value_proposition,
          contentPillars: previousStrategy.contentPillars,
          cadencePerWeek: previousStrategy.cadence_per_week,
          videosPerRun: previousStrategy.videos_per_run,
          defaultFormat: previousStrategy.default_format,
          defaultLength: previousStrategy.default_length,
          successMetric: previousStrategy.success_metric,
          constraints: previousStrategy.constraints,
          status: previousStrategy.status
        });
      } else {
        await db.executeQuery("DELETE FROM channel_strategies WHERE id = 'default'");
      }
      if (recoverableJob) await db.executeQuery('DELETE FROM generation_jobs WHERE id = ?', [recoverableJob.id]);
      await db.close();
    }

    this.logger.info('Autonomous channel operator test completed successfully');
  }

  async testAutonomousPlannerJsonReliability() {
    const { ContentStrategyAgent } = require('./agents/content-strategy-agent');
    const agent = new ContentStrategyAgent(null, {});
    const calls = [];
    const candidate = {
      topic: 'She Heard Her Own Voice Behind the Locked Door',
      idea: 'Voice behind the door',
      storyFamily: 'impossible-sound',
      everydayAnchor: 'apartment hallway',
      fearMechanism: 'her own voice answers from a locked empty room',
      angle: 'the voice starts repeating words before she says them',
      hook: 'Her own voice whispered behind the locked door.',
      scrollStopMoment: 'A dark stickman faces a locked door while a second pale speech cue appears behind it.',
      visualWhy: 'One figure and one impossible source of sound read immediately.',
      visualVariety: ['hallway and door', 'ear against door', 'phone confirms she is alone', 'shadow under door'],
      curiosityAngle: 'How can her own voice be inside the empty room?',
      escalationLadder: ['the voice copies her', 'the voice speaks first'],
      payoff: 'The voice says her next sentence before she can speak, then the hallway light goes out.',
      fitRationale: 'Everyday setting, immediate impossible sound, escalation, and final recontextualization.',
      storyEngine: 'impossible-sound',
      autonomyRisk: 'low',
      nicheFit: 10,
      visualStrength: 9,
      curiosityGap: 10,
      visualVarietyScore: 8,
      retentionPotential: 10,
      originalityScore: 10,
      brandFit: 10,
      twistScore: 9,
      premiseLegibility: 10,
      payoffStrength: 9,
      targetAudience: 'Global English horror Shorts viewers',
      contentType: 'Story',
      keywords: ['horror','scary story'],
      fictional: true
    };

    agent.aiTextService = {
      isAvailable: () => true,
      generateText: async (_prompt, options) => {
        calls.push(options);
        if (calls.length === 1) return '{"candidates":[';
        return JSON.stringify({ candidates: [candidate] });
      }
    };

    const plan = await agent.generateAutonomousPlanWithAI({
      audience: 'Global English horror Shorts viewers',
      contentPillars: ['Everyday Situations Gone Wrong'],
      default_format: 'story',
      default_length: 'short'
    }, {
      signals: [],
      recentTopics: [],
      approvedLearnings: []
    }, 1);

    if (calls.length !== 2 || plan.length !== 1 || plan[0].topic !== candidate.topic) {
      throw new Error('Horror planner did not recover from a truncated JSON response');
    }
    if (calls.some(options =>
      Number(options.maxTokens) < 4096 ||
      options.thinkingLevel !== 'low' ||
      options.responseMimeType !== 'application/json'
    )) {
      throw new Error('Horror planner does not reserve a reliable JSON output contract');
    }

    const extracted = agent.parseAIJsonResponse('prefix\n[{"topic":"array extraction"}]\nsuffix');
    if (!Array.isArray(extracted) || extracted[0]?.topic !== 'array extraction') {
      throw new Error('Planner JSON parser cannot recover a top-level array from surrounding text');
    }

    const fictional = await agent.enrichStrategyWithResearch({ ...candidate, researchSources: [{ url: 'https://example.com' }] });
    if (fictional.fictional !== true || fictional.provenanceMode !== 'fictional' || fictional.researchSources.length !== 0) {
      throw new Error('Original horror fiction was incorrectly routed through factual provenance research');
    }

    const normalized = agent.normalizeAutonomousPlan([candidate], { audience: candidate.targetAudience }, 1, { recentTopics: [] });
    if (normalized.length !== 1 || normalized[0].length !== 'short' || normalized[0].sourceUrls.length !== 0) {
      throw new Error('Horror planner normalization did not lock fiction/Shorts output');
    }

    const different = { ...candidate, topic: 'The Elevator Opened on a Floor That Did Not Exist' };
    agent.generateAutonomousPlanWithAI = async () => [different];
    let driftRejected = false;
    try {
      await agent.generateContentStrategyWithAI(candidate.topic);
    } catch (error) {
      driftRejected = error.code === 'STRATEGY_TOPIC_DRIFT';
    }
    if (!driftRejected) throw new Error('Requested Horror premise drift was not rejected');

    this.logger.info('Horror planner JSON reliability test completed successfully');
  }

  async testChannelLearningLoop() {
    const fs = require('fs').promises;
    const os = require('os');
    const { ChannelLearningEngine } = require('./utils/channel-learning-engine');
    const { ContentStrategyAgent } = require('./agents/content-strategy-agent');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-learning-'));
    const db = new Database();
    db.dbPath = path.join(directory, 'learning.db');
    await db.initialize();

    try {
      const learning = new ChannelLearningEngine(db);
      const report = (videoId, format, performanceScore, ctr, retention, simulated = false) => ({
        videoId,
        videoDetails: {
          title: `${format} automation guide`,
          publishedAt: new Date(Date.now() - 8 * 86400000).toISOString()
        },
        analytics: {
          simulated,
          views: { totalViews: 500, totalImpressions: 5000, averageCTR: ctr },
          watchTime: { averageViewPercentage: retention, averageViewDuration: 240, totalWatchTime: 2000 },
          engagement: { engagementRate: format === 'tutorial' ? 6 : 2 }
        },
        thumbnailMetrics: { impressions: 5000, clickThroughRate: ctr },
        performance: { score: performanceScore, grade: 'B' }
      });
      const context = format => ({
        strategy: { topic: `${format} topic`, contentType: format, requestedLengthKey: 'medium' },
        script: { hook: 'A concise opening that immediately promises a useful and concrete result.' },
        thumbnail: { concept: { composition: 'centered' } }
      });

      await learning.capture(report('learning-tutorial-1', 'tutorial', 88, 7.5, 62), context('tutorial'), '7d');
      await learning.capture(report('learning-tutorial-2', 'tutorial', 84, 7, 58), context('tutorial'), '7d');
      await learning.capture(report('learning-list-1', 'list', 52, 3.5, 39), context('list'), '7d');
      await learning.capture(report('learning-list-2', 'list', 48, 3, 35), context('list'), '7d');
      await learning.capture(report('learning-simulated', 'review', 99, 12, 90, true), context('review'), '7d');

      const summary = await learning.getSummary();
      const recommendation = summary.recommendations.find(item => item.category === 'format');
      if (summary.measuredVideos !== 4 || !recommendation || !/tutorial/.test(recommendation.title)) {
        throw new Error('Learning engine did not derive a real-evidence format recommendation');
      }
      if (summary.recommendations.some(item => /review/.test(item.title))) {
        throw new Error('Simulated analytics influenced a learning recommendation');
      }

      const approved = await db.reviewLearningRecommendation(recommendation.id, 'approved');
      if (approved.status !== 'approved') throw new Error('Learning recommendation approval was not persisted');

      const strategyAgent = new ContentStrategyAgent(db, {});
      strategyAgent.analyzeTrends = async function() {
        this.trendingTopics = [];
        this.competitorData = [];
      };
      strategyAgent.generateAutonomousPlanWithAI = async function(channelStrategy, research, targetCount) {
        return this.buildFallbackAutonomousPlan(channelStrategy, research, targetCount);
      };
      const planned = await strategyAgent.researchAndPlanChannel({
        objective: 'Teach useful automation',
        audience: 'Small teams',
        value_proposition: 'Practical guidance',
        contentPillars: ['Automation'],
        videos_per_run: 1,
        default_format: 'tutorial',
        default_length: 'medium'
      });
      if (
        planned.research.approvedLearnings.length !== 1 ||
        !planned.research.sources.includes('Approved analytics learnings')
      ) {
        throw new Error('Approved learning was not supplied to autonomous planning');
      }

      const due = await learning.getDueMeasurementWindows({
        youtube_id: 'unmeasured-video',
        published_at: new Date(Date.now() - 8 * 86400000).toISOString()
      });
      if (!due.includes('24h') || !due.includes('7d')) {
        throw new Error('24-hour and 7-day learning windows were not scheduled');
      }

      const { YouTubeAutomationAgent } = require('./index');
      const { ThumbnailDesignerAgent } = require('./agents/thumbnail-designer-agent');
      const workflow = new YouTubeAutomationAgent();
      const titleVariants = workflow.buildTitleExperimentVariants('Automate Your Weekly Reporting');
      const selected = workflow.validateEditorData(
        { selectedTitleVariant: 1, selectedThumbnailVariant: 2 },
        { packagingExperiment: { titleVariants, thumbnailVariants: [{}, {}, {}] } }
      );
      if (titleVariants.length !== 3 || selected.selectedTitleVariant !== 1 || selected.selectedThumbnailVariant !== 2) {
        throw new Error('Packaging experiment selections were not validated');
      }

      const thumbnailDesigner = new ThumbnailDesignerAgent(db, {});
      thumbnailDesigner.createThumbnail = async (_concept, suffix) => `base-${suffix}`;
      thumbnailDesigner.addTextOverlay = async (_path, _concept, suffix) => `overlay-${suffix}`;
      thumbnailDesigner.optimizeForYouTube = async (_path, suffix) => `optimized-${suffix}.jpg`;
      const thumbnailVariants = await thumbnailDesigner.generateABVariants({
        primaryText: 'GUIDE',
        colors: { primary: 'blue', secondary: 'white', accent: 'green' },
        composition: 'split'
      });
      if (thumbnailVariants.length !== 3 || thumbnailVariants.some(item => !item.path.endsWith('.jpg'))) {
        throw new Error('Approved packaging learning did not produce complete thumbnail variants');
      }
    } finally {
      await db.close();
      await fs.rm(directory, { recursive: true, force: true });
    }

    this.logger.info('Closed-loop channel learning test completed successfully');
  }

  async testGrowthExperimentsStudio() {
    const fs = require('fs').promises;
    const os = require('os');
    const { GrowthExperimentService } = require('./utils/growth-experiment-service');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-experiments-'));
    const db = new Database();
    db.dbPath = path.join(directory, 'experiments.db');
    await db.initialize();
    const productionId = 'experiment-production';
    const thumbnails = await Promise.all(['control', 'variant-a', 'variant-b'].map(async name => {
      const file = path.join(directory, `${name}.jpg`);
      await fs.writeFile(file, Buffer.from(`thumbnail-${name}`));
      return file;
    }));

    try {
      await db.saveProductionData({
        id: productionId, status: 'published',
        assets: { thumbnail: { path: thumbnails[0] }, finalVideo: { path: 'fixture.mp4' } },
        timeline: {}, scheduledPublishTime: new Date().toISOString(), priority: 50, estimatedDuration: '8:00'
      });
      await db.saveProductionSnapshot({
        id: productionId,
        strategy: { topic: 'Controlled growth' },
        script: { title: 'Control title' },
        thumbnail: { path: thumbnails[0] },
        seo: { title: 'Control title', description: 'Fixture', tags: [] }
      });
      const sourceLearning = await db.saveLearningRecommendation({
        fingerprint: 'growth-experiment-source', category: 'packaging',
        title: 'Test packaging', rationale: 'CTR trails the channel baseline.',
        evidence: { measuredVideos: 4 }, proposedChange: { experiment: 'title_thumbnail_variant' }, confidence: 'medium'
      });
      await db.reviewLearningRecommendation(sourceLearning.id, 'approved');
      await db.saveContentReview(productionId, {
        status: 'approved',
        editorData: {
          packagingExperiment: {
            sourceRecommendationId: sourceLearning.id,
            hypothesis: 'A clearer promise improves qualified clicks.',
            titleVariants: [
              { label: 'Control', title: 'Control title' },
              { label: 'Clear benefit', title: 'A Clearer Automation Benefit' },
              { label: 'Curiosity', title: 'The Automation Detail You Missed' }
            ],
            thumbnailVariants: [
              { label: 'Control', path: thumbnails[0] },
              { label: 'Clear benefit', path: thumbnails[1] },
              { label: 'Curiosity', path: thumbnails[2] }
            ]
          }
        }
      });
      const schedule = await db.saveScheduleEntry({
        productionId, title: 'Control title', publishTime: new Date(Date.now() - 8 * 86400000).toISOString(),
        status: 'published', priority: 50,
        metadata: { seo: { title: 'Control title', description: 'Fixture', tags: [] }, thumbnail: { path: thumbnails[0] } }
      });
      schedule.status = 'published';
      schedule.youtubeId = 'youtube-experiment-1';
      schedule.youtubeUrl = 'https://www.youtube.com/watch?v=youtube-experiment-1';
      schedule.publishedAt = new Date(Date.now() - 8 * 86400000).toISOString();
      await db.updateScheduleEntry(schedule);

      const cumulative = [
        { impressions: 10000, clicks: 500, views: 700 },
        { impressions: 11000, clicks: 550, views: 770 },
        { impressions: 12000, clicks: 650, views: 860 },
        { impressions: 13000, clicks: 690, views: 920 }
      ];
      let reportIndex = 0;
      const analytics = {
        analyzeVideoPerformance: async () => {
          const point = cumulative[Math.min(reportIndex++, cumulative.length - 1)];
          return {
            analytics: {
              simulated: false,
              views: { totalViews: point.views, totalImpressions: point.impressions, averageCTR: point.clicks / point.impressions * 100 },
              watchTime: { totalWatchTime: point.views * 4, averageViewPercentage: 55 },
              engagement: { engagementRate: 4.5 },
              outcomes: { netSubscribers: Math.floor(point.views / 100), estimatedRevenue: point.views / 100 }
            },
            thumbnailMetrics: { impressions: point.impressions, clickThroughRate: point.clicks / point.impressions * 100 }
          };
        }
      };
      const applied = [];
      const publishing = {
        applyVideoPackaging: async (videoId, packaging) => applied.push({ videoId, ...packaging })
      };
      let clock = Date.now();
      const service = new GrowthExperimentService(db, analytics, publishing, { now: () => new Date(clock) });
      let experiment = await service.create({ productionId, armDurationHours: 24, minImpressions: 100 });
      if (experiment.status !== 'draft' || experiment.arms.length !== 3 || !experiment.arms[0].isControl) {
        throw new Error('Experiment plan did not persist a control and complete variant arms');
      }

      let confirmationBlocked = false;
      try { await service.approve(experiment.id); } catch (error) { confirmationBlocked = error.code === 'EXPERIMENT_CONFIRMATION_REQUIRED'; }
      if (!confirmationBlocked) throw new Error('Experiment approval did not require explicit confirmation');
      experiment = await service.approve(experiment.id, { confirmed: true });
      experiment = await service.start(experiment.id, { confirmed: true });
      if (experiment.status !== 'running' || applied.length !== 1) throw new Error('Approved experiment did not start on its control arm');

      for (let index = 0; index < 3; index++) {
        clock += 24 * 3600000;
        experiment = await service.refresh(experiment.id);
      }
      if (
        experiment.status !== 'awaiting_winner' || !experiment.winningArmId ||
        experiment.arms.find(arm => arm.id === experiment.winningArmId)?.label !== 'Clear benefit' ||
        experiment.result.guardrails.passed !== true || applied.at(-1).title !== 'Control title'
      ) {
        throw new Error('Experiment did not select an evidence-backed winner and restore the control');
      }

      experiment = await service.adoptWinner(experiment.id, { confirmed: true });
      const learned = (await db.listLearningRecommendations({ status: 'approved', limit: 20 }))
        .find(item => item.evidence?.experimentId === experiment.id);
      if (experiment.status !== 'adopted' || !learned || applied.at(-1).title !== 'A Clearer Automation Benefit') {
        throw new Error('Winner adoption did not update packaging and approve the resulting learning');
      }

      const storedSamples = await db.listExperimentSamples(experiment.id);
      if (storedSamples.length < 6 || storedSamples.some(sample => !Number.isFinite(sample.metrics.impressions))) {
        throw new Error('Experiment evidence samples were not durably stored');
      }
    } finally {
      await db.close();
      await fs.rm(directory, { recursive: true, force: true });
    }

    this.logger.info('Controlled Growth Experiments Studio test completed successfully');
  }

  async testOutcomeROIStudio() {
    const fs = require('fs').promises;
    const os = require('os');
    const { ChannelLearningEngine } = require('./utils/channel-learning-engine');
    const { AnalyticsOptimizationAgent } = require('./agents/analytics-optimization-agent');
    const { YouTubeAutomationAgent } = require('./index');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-outcomes-'));
    const db = new Database();
    db.dbPath = path.join(directory, 'outcomes.db');
    await db.initialize();

    try {
      const validated = new YouTubeAutomationAgent().validateChannelStrategy({
        objective: 'Grow a durable automation audience', audience: 'Small teams',
        contentPillars: ['Automation', 'Tool reviews'], primaryKpi: 'subscribers',
        targetValue: 40, targetWindowDays: 28, monthlyBudget: 100,
        outcomeCurrency: 'USD', status: 'active'
      });
      const strategy = await db.saveChannelStrategy(validated);
      if (strategy.primary_kpi !== 'subscribers' || strategy.target_value !== 40 || strategy.target_window_days !== 28) {
        throw new Error('Structured outcome strategy was not validated and persisted');
      }

      const learning = new ChannelLearningEngine(db);
      const report = (videoId, format, subscribers, revenue) => ({
        videoId,
        videoDetails: { title: `${format} outcome fixture`, publishedAt: new Date(Date.now() - 8 * 86400000).toISOString() },
        analytics: {
          simulated: false,
          views: { totalViews: 1000, totalImpressions: 10000, averageCTR: 5 },
          watchTime: { averageViewPercentage: 45, averageViewDuration: 240, totalWatchTime: 4000 },
          engagement: { engagementRate: 4 },
          outcomes: {
            subscribersAvailable: true, subscribersGained: subscribers + 1, subscribersLost: 1,
            netSubscribers: subscribers, revenueAvailable: true, estimatedRevenue: revenue,
            monetizedPlaybacks: 500, playbackBasedCpm: 8, currency: 'USD'
          }
        },
        thumbnailMetrics: { impressions: 10000, clickThroughRate: 5 },
        performance: { score: 70, grade: 'B' }
      });
      const context = (format, pillar) => ({
        strategy: { topic: `${format} topic`, contentType: format, requestedLengthKey: 'medium', contentPillar: pillar },
        script: { hook: 'A concise, outcome-aligned opening.' },
        thumbnail: { concept: { composition: 'centered' } },
        productionCost: { amount: 2, currency: 'USD', complete: true, providers: ['fixture-video'] }
      });
      await learning.capture(report('outcome-tutorial-1', 'tutorial', 12, 5), context('tutorial', 'Automation'), '7d');
      await learning.capture(report('outcome-tutorial-2', 'tutorial', 10, 5), context('tutorial', 'Automation'), '7d');
      await learning.capture(report('outcome-list-1', 'list', 2, 5), context('list', 'Tool reviews'), '7d');
      await learning.capture(report('outcome-list-2', 'list', 1, 5), context('list', 'Tool reviews'), '7d');

      const summary = await learning.getSummary();
      const recommendation = summary.recommendations.find(item => item.category === 'outcome_alignment');
      if (
        summary.outcome.goal.id !== 'subscribers' || summary.outcome.observed !== 25 ||
        summary.outcome.progressPercent !== 62.5 || summary.outcome.economics.roi !== 150 ||
        !recommendation || recommendation.status !== 'pending' || recommendation.proposedChange.autoApply !== false
      ) {
        throw new Error('Outcome evidence did not produce the expected goal scorecard and approval-gated recommendation');
      }

      const analytics = new AnalyticsOptimizationAgent(db, { getYouTubeAuth: () => ({}) });
      analytics.youtubeAnalytics = {
        reports: {
          query: async ({ metrics }) => {
            if (metrics.includes('estimatedRevenue')) throw new Error('not monetized');
            return { data: { rows: [[7, 2]] } };
          }
        }
      };
      const outcomes = await analytics.getOutcomeAnalytics('outcome-video', '2026-08-01', '2026-08-07');
      if (!outcomes.subscribersAvailable || outcomes.netSubscribers !== 5 || outcomes.revenueAvailable || outcomes.estimatedRevenue !== null) {
        throw new Error('Unavailable monetization evidence was converted into a false zero');
      }
    } finally {
      await db.close();
      await fs.rm(directory, { recursive: true, force: true });
    }

    this.logger.info('Outcome and ROI Studio test completed successfully');
  }

  async testSceneAwareRetentionStudio() {
    const fs = require('fs').promises;
    const os = require('os');
    const { ChannelLearningEngine } = require('./utils/channel-learning-engine');
    const { AnalyticsOptimizationAgent } = require('./agents/analytics-optimization-agent');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-retention-'));
    const db = new Database();
    db.dbPath = path.join(directory, 'retention.db');
    await db.initialize();

    try {
      const learning = new ChannelLearningEngine(db);
      const points = Array.from({ length: 100 }, (_, index) => {
        const elapsedRatio = (index + 1) / 100;
        let audienceWatchRatio;
        let relativeRetentionPerformance;
        if (elapsedRatio <= 0.17) {
          audienceWatchRatio = 1 - elapsedRatio * 0.4;
          relativeRetentionPerformance = 0.64;
        } else if (elapsedRatio <= 0.5) {
          audienceWatchRatio = 0.93 - ((elapsedRatio - 0.17) / 0.33) * 0.48;
          relativeRetentionPerformance = 0.31;
        } else {
          audienceWatchRatio = 0.45 - (elapsedRatio - 0.5) * 0.08;
          relativeRetentionPerformance = 0.7;
        }
        return {
          elapsedRatio,
          audienceWatchRatio,
          relativeRetentionPerformance,
          startedWatching: index === 0 ? 800 : 0,
          stoppedWatching: elapsedRatio > 0.17 && elapsedRatio <= 0.5 ? 5 : 1,
          totalSegmentImpressions: 800
        };
      });
      const context = {
        productionId: 'retention-production',
        contentFormat: 'long_form',
        title: 'Scene retention fixture',
        publishedAt: new Date(Date.now() - 8 * 86400000).toISOString(),
        retentionDuration: 90,
        retentionScenes: [
          { id: 'scene-hook', position: 0, label: 'Hook', duration: 15 },
          { id: 'scene-intro', position: 1, label: 'Introduction', duration: 30 },
          { id: 'scene-demo', position: 2, label: 'Demonstration', duration: 45 }
        ]
      };
      const snapshot = await learning.captureRetention({
        available: true,
        simulated: false,
        videoId: 'retention-video-1',
        title: context.title,
        publishedAt: context.publishedAt,
        durationSeconds: 90,
        points
      }, context, '7d', { views: 800, impressions: 12000 });

      if (
        !snapshot || snapshot.points.length !== 100 || snapshot.sceneMetrics.length !== 3 ||
        snapshot.summary.primaryDropoff?.id !== 'scene-intro' || snapshot.confidence !== 'high'
      ) {
        throw new Error('The real retention curve was not mapped to the expected scene evidence');
      }
      const recommendation = (await db.listLearningRecommendations({ limit: 20 }))
        .find(item => item.category === 'scene_retention');
      if (!recommendation || recommendation.status !== 'pending' || recommendation.proposedChange.autoEditPublishedContent !== false) {
        throw new Error('Scene retention learning bypassed pending review or published-content safety');
      }
      const approvedBeforeReview = await db.listLearningRecommendations({ status: 'approved', limit: 20 });
      if (approvedBeforeReview.some(item => item.id === recommendation.id)) {
        throw new Error('Pending scene retention learning entered autonomous planning');
      }
      await db.reviewLearningRecommendation(recommendation.id, 'approved');
      const approvedAfterReview = await db.listLearningRecommendations({ status: 'approved', limit: 20 });
      if (!approvedAfterReview.some(item => item.id === recommendation.id)) {
        throw new Error('Approved scene retention learning was not made available to planning');
      }

      const skipped = await learning.captureRetention({
        available: true,
        simulated: true,
        videoId: 'retention-simulated',
        durationSeconds: 90,
        points
      }, context, '7d', { views: 1000 });
      if (skipped !== null || (await db.listRetentionSnapshots({ limit: 10 })).length !== 1) {
        throw new Error('Simulated retention evidence was persisted');
      }

      const timeline = db.buildRetentionSceneContext(context.retentionScenes);
      const totalSeconds = context.retentionScenes.reduce((sum, scene) => sum + Number(scene.duration || 0), 0);
      if (
        timeline.length !== context.retentionScenes.length ||
        timeline[0].startSeconds !== 0 ||
        timeline[timeline.length - 1].endSeconds !== totalSeconds
      ) {
        throw new Error('Retention context did not lay the source scenes out as one continuous timeline');
      }

      const analytics = new AnalyticsOptimizationAgent(db, { getYouTubeAuth: () => ({}) });
      analytics.youtubeAnalytics = {
        reports: {
          query: async () => ({
            data: {
              columnHeaders: [
                'elapsedVideoTimeRatio', 'audienceWatchRatio', 'relativeRetentionPerformance',
                'startedWatching', 'stoppedWatching', 'totalSegmentImpressions'
              ].map(name => ({ name })),
              rows: [[0.01, 0.99, 0.7, 10, 1, 10]]
            }
          })
        }
      };
      const apiCurve = await analytics.getAudienceRetention('fixture-video', null, 'PT2M30S');
      if (!apiCurve.available || apiCurve.durationSeconds !== 150 || apiCurve.points[0].audienceWatchRatio !== 0.99) {
        throw new Error('YouTube audience retention response was not normalized correctly');
      }
    } finally {
      await db.close();
      await fs.rm(directory, { recursive: true, force: true });
    }

    this.logger.info('Scene-Aware Retention Studio test completed successfully');
  }

  async testProductionReadinessGate() {
    const fs = require('fs').promises;
    const os = require('os');
    let savedRun = null;
    const db = {
      generateId: () => 'readiness_test',
      saveReadinessRun: async run => {
        savedRun = {
          ...run,
          started_at: run.startedAt,
          completed_at: run.completedAt
        };
        return savedRun;
      },
      getLatestReadinessRun: async () => savedRun
    };
    const passingProbe = label => async () => ({ message: `${label} verified` });
    const service = new ProductionReadinessService(db, { credentials: {} }, {
      probes: {
        text: passingProbe('Text'),
        image: passingProbe('Image'),
        videoProvider: passingProbe('Video provider'),
        narration: passingProbe('Narration'),
        videoAssembly: passingProbe('Video'),
        youtube: passingProbe('YouTube'),
        metadata: passingProbe('Metadata')
      }
    });
    const passed = await service.run({ includePaidMedia: true });
    if (passed.status !== 'passed' || passed.checks.length !== 7 || !savedRun) {
      throw new Error('A successful readiness run was not persisted correctly');
    }
    await service.assertReady('Test automation');

    const failingService = new ProductionReadinessService(db, { credentials: {} }, {
      probes: {
        text: passingProbe('Text'),
        image: passingProbe('Image'),
        videoProvider: passingProbe('Video provider'),
        narration: passingProbe('Narration'),
        videoAssembly: passingProbe('Video'),
        youtube: async () => { throw new Error('token rejected sk-secret-value'); },
        metadata: passingProbe('Metadata')
      }
    });
    const failed = await failingService.run();
    if (failed.status !== 'failed' || failed.blockingFailures[0] !== 'youtube_access') {
      throw new Error('A blocking readiness probe did not fail closed');
    }
    if (failed.checks.find(check => check.id === 'youtube_access').message.includes('sk-secret-value')) {
      throw new Error('Readiness diagnostics did not redact a provider-shaped secret');
    }
    let blocked = false;
    try {
      await failingService.assertReady('Test publishing');
    } catch (error) {
      blocked = error.status === 409;
    }
    if (!blocked) throw new Error('Failed readiness did not block protected automation');

    const tags = normalizeTags(['#Automation', 'automation', 'bad"tag', 'x'.repeat(140)]);
    const metadata = validateYouTubeMetadata({
      title: 'A valid title',
      description: 'A valid upload description.',
      tags,
      metadata: { category: 22, language: 'en' }
    });
    if (!metadata.valid || tags[0] !== 'Automation' || tags.includes('automation') || tags.some(tag => tag.includes('"') || tag.length > 100)) {
      throw new Error('YouTube metadata normalization is unsafe or invalid');
    }

    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-readiness-db-'));
    const persistenceDb = new Database();
    persistenceDb.dbPath = path.join(directory, 'readiness.db');
    try {
      await persistenceDb.initialize();
      await persistenceDb.saveReadinessRun(passed);
      const persisted = await persistenceDb.getLatestReadinessRun();
      if (persisted?.id !== passed.id || persisted.checks.length !== 7 || persisted.summary.passed !== 7) {
        throw new Error('Readiness evidence did not round-trip through SQLite');
      }
    } finally {
      await persistenceDb.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
    this.logger.info('Production readiness gate test completed successfully');
  }

  async testVideoProviderLayer() {
    const fs = require('fs').promises;
    const os = require('os');
    const { runFFmpeg, checkFFmpeg } = require('./utils/ffmpeg');
    const { MediaGenerationService } = require('./utils/media-generation-service');
    const {
      VideoProvider, VideoProviderRegistry, SeedanceProvider, MiniMaxH3Provider,
      GoogleOmniProvider, KlingProvider, WanProvider
    } = require('./utils/video-providers');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-media-provider-'));
    const db = new Database();
    db.dbPath = path.join(directory, 'media.db');
    await db.initialize();
    const job = await db.createGenerationJob({ topic: 'Provider durability test' });
    const source = path.join(directory, 'source.mp4');
    let createCalls = 0;
    let pollCalls = 0;

    try {
      if (!(await checkFFmpeg())) {
        this.logger.warn('Skipping provider MP4 durability assertion because FFmpeg is unavailable');
        return;
      }
      await runFFmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:d=1', '-c:v', 'mpeg4', source]);
      const fake = new VideoProvider('seedance', {
        model: 'bytedance/seedance-2.5',
        capabilities: { minDuration: 4, maxDuration: 30, cancellation: true }
      });
      fake.isAvailable = () => true;
      fake.createTask = async () => {
        createCalls++;
        return { externalTaskId: 'prediction-1', status: 'queued' };
      };
      fake.getTask = async id => {
        pollCalls++;
        return { externalTaskId: id, status: 'succeeded', outputUrl: 'fake://video' };
      };
      fake.downloadResult = async (_task, outputPath) => {
        await fs.copyFile(source, outputPath);
        return outputPath;
      };
      const registry = new VideoProviderRegistry({}, { providers: { seedance: fake } });
      const service = new MediaGenerationService(db, {}, { registry, pollIntervalMs: 10, sleep: async () => {} });
      const output = path.join(directory, 'output.mp4');
      const input = {
        jobId: job.id,
        productionId: 'prod-provider-test',
        scene: { index: 0 },
        provider: fake,
        outputPath: output,
        request: { prompt: 'A red frame', duration: 4, resolution: '720p', aspectRatio: '16:9' }
      };
      const first = await service.generateClip(input);
      const second = await service.generateClip(input);
      const tasks = await db.listMediaGenerationTasks(job.id);
      if (createCalls !== 1 || pollCalls !== 1 || !second.reused || tasks.length !== 1) {
        throw new Error('A completed provider task was duplicated instead of being reused');
      }
      if (first.task.external_task_id !== 'prediction-1' || tasks[0].model !== 'bytedance/seedance-2.5') {
        throw new Error('Provider task identity and model evidence did not persist');
      }
      const providers = registry.list();
      for (const id of ['seedance', 'minimax_h3', 'google_omni', 'kling', 'wan', 'slideshow']) {
        if (!providers.find(provider => provider.id === id)) throw new Error(`Missing video provider: ${id}`);
      }
      const shortOnly = new VideoProvider('wan', { model: 'wan-test', capabilities: { minDuration: 2, maxDuration: 15, firstFrame: true } });
      shortOnly.isAvailable = () => true;
      const routed = new VideoProviderRegistry({}, { providers: { seedance: fake, wan: shortOnly } });
      if (routed.select('auto', ['wan', 'seedance'], { duration: 20 }).id !== 'seedance') {
        throw new Error('Automatic video routing ignored the requested duration capability');
      }
      if (routed.select('auto', ['seedance', 'wan'], { duration: 8, generateAudio: true }).id !== 'slideshow') {
        throw new Error('Automatic video routing selected a provider without requested native audio support');
      }
      const listedJob = (await db.listGenerationJobs(10)).find(item => item.id === job.id);
      if (listedJob?.mediaTasks?.length !== 1 || listedJob.mediaTasks[0].external_task_id !== 'prediction-1') {
        throw new Error('Generation job history did not expose its durable provider task');
      }

      let seedanceSubmission;
      const seedance = new SeedanceProvider({}, { client: { predictions: {
        create: async submission => {
          seedanceSubmission = submission;
          return { id: 'seedance-task', status: 'starting' };
        }
      } } });
      const seedanceTask = await seedance.createTask({ prompt: 'Seedance scene', duration: 30, aspectRatio: '16:9' });
      if (seedanceTask.externalTaskId !== 'seedance-task' || seedanceSubmission.model !== 'bytedance/seedance-2.5' || seedanceSubmission.input.duration !== 30) {
        throw new Error('Seedance adapter did not submit the expected Replicate task');
      }
      const fileOutput = seedance.normalizeTask({ id: 'file-output', status: 'succeeded', output: { url: () => new URL('https://example.com/video.mp4') } });
      if (fileOutput.outputUrl !== 'https://example.com/video.mp4') throw new Error('Seedance FileOutput was not normalized');

      let minimaxBody;
      const minimax = new MiniMaxH3Provider({}, { apiKey: 'test', http: {
        post: async (_url, body) => { minimaxBody = body; return { data: { task_id: 'h3-task' } }; }
      } });
      const minimaxTask = await minimax.createTask({ prompt: 'H3 scene', duration: 15, resolution: '2K', aspectRatio: '9:16' });
      if (minimaxTask.externalTaskId !== 'h3-task' || minimaxBody.model !== 'MiniMax-H3' || minimaxBody.content[0].type !== 'text') {
        throw new Error('MiniMax H3 adapter did not submit the expected multimodal task');
      }

      let googleName;
      const google = new GoogleOmniProvider({}, { client: {
        interactions: { create: async () => ({ id: 'omni-task', output_video: { uri: 'https://generativelanguage.googleapis.com/v1beta/files/omni-file:download?alt=media' } }) },
        files: { get: async ({ name }) => { googleName = name; return { state: { name: 'ACTIVE' } }; } }
      } });
      const googleTask = await google.createTask({ prompt: 'Omni scene', aspectRatio: '16:9' });
      await google.getTask(googleTask.externalTaskId);
      if (googleTask.status !== 'queued' || googleName !== 'files/omni-file') throw new Error('Gemini Omni URI task was not normalized for polling');

      let klingBody;
      const kling = new KlingProvider({}, { accessKey: 'access', secretKey: 'secret', http: {
        post: async (_url, body) => { klingBody = body; return { data: { data: { task_id: 'kling-task' } } }; }
      } });
      const klingTask = await kling.createTask({ prompt: 'Kling scene', duration: 8, aspectRatio: '16:9' });
      if (klingTask.externalTaskId !== 'kling-task' || klingBody.model_name !== 'kling-v3-omni' || klingBody.sound !== 'off') {
        throw new Error('Kling adapter did not submit the expected task');
      }

      let wanBody;
      const wan = new WanProvider({}, { apiKey: 'test', http: {
        post: async (_url, body) => { wanBody = body; return { data: { output: { task_id: 'wan-task' } } }; }
      } });
      const wanTask = await wan.createTask({ prompt: 'Wan scene', duration: 10, resolution: '720p', aspectRatio: '16:9' });
      if (wanTask.externalTaskId !== 'wan-task' || wanBody.model !== 'wan2.7-t2v-2026-06-12' || wanBody.parameters.resolution !== '720P') {
        throw new Error('Wan adapter did not submit the expected task-specific model payload');
      }
    } finally {
      await db.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
    this.logger.info('Durable multi-provider video generation test completed successfully');
  }

  async testSceneRepairStudio() {
    const fs = require('fs').promises;
    const os = require('os');
    const sharp = require('sharp');
    const { SceneRepairService, buildInitialSceneManifest } = require('./utils/scene-repair-service');
    const { OperatorService } = require('./utils/operator-service');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-scene-repair-'));
    const db = new Database();
    db.dbPath = path.join(directory, 'scenes.db');
    await db.initialize();

    try {
      const imagePath = path.join(directory, 'scene.png');
      const oldVideoPath = path.join(directory, 'old.mp4');
      const originalAudioPath = path.join(directory, 'original.mp3');
      await sharp({ create: { width: 320, height: 180, channels: 3, background: '#203a5f' } }).png().toFile(imagePath);
      await fs.writeFile(oldVideoPath, Buffer.from('previous final video'));
      await fs.writeFile(originalAudioPath, Buffer.from('previous narration'));
      const production = {
        id: `prod_scene_${Date.now()}`,
        status: 'ready',
        script: {
          title: 'Repair one scene',
          fullScript: 'A complete factual-review-safe script for testing selective scene repair without replacing the entire production.',
          hook: { text: 'Fix one weak moment without starting over.' },
          introduction: { greeting: 'Hello.', topicIntro: 'Scene repair matters.', valueProposition: 'Save time and credits.' },
          mainContent: { sections: [
            { title: 'Selective repair', content: 'Keep the scenes that work and replace only the scene that does not.' },
            { title: 'Examples', content: ['Example 1: [Specific case study]', 'A real example without template markers.'] }
          ] },
          conclusion: { recap: ['Preserve good work.'], finalThought: 'Review the repaired timeline.' },
          callToAction: {
            type: 'call_to_action', duration: '15 seconds', subscribe: 'Subscribe.', like: 'Like.',
            comment: 'Comment.', nextVideo: 'Watch the next video.'
          }
        },
        seo: { title: 'Repair one scene', description: 'A detailed description of selective scene repair for video production workflows.', tags: ['video', 'repair', 'workflow'] },
        strategy: { topic: 'Selective scene repair' },
        assets: {
          video: { visualAssets: [imagePath] },
          audio: { path: originalAudioPath, status: 'ready', simulated: false, provider: 'fixture-tts', model: 'fixture-voice' },
          thumbnail: { path: imagePath },
          finalVideo: { path: oldVideoPath, simulated: false, duration: '1:00', provider: { actualProvider: 'slideshow' } }
        },
        timeline: { readyForUpload: new Date().toISOString() },
        scheduledPublishTime: new Date(Date.now() + 86400000).toISOString(),
        priority: 50,
        estimatedDuration: '1:00'
      };
      await db.saveProductionData(production);
      await db.saveProductionSnapshot(production);
      await db.saveContentReview(production.id, { status: 'needs_review', editorData: {}, qualityChecks: [] });
      await db.saveContentProvenance(production.id, {
        sources: [], claims: [], containsSyntheticMedia: false, status: 'not_required',
        summary: { sourceCount: 0, verifiedSources: 0, claimCount: 0, resolvedClaims: 0, highRiskClaims: 0, unresolvedClaims: 0 }
      });
      await db.saveChannelProfile({ channelName: 'Test channel', visualStyle: 'animated' });

      const manifest = buildInitialSceneManifest(production, { actualProvider: 'slideshow', model: 'local-ffmpeg' });
      if (manifest.length < 3 || manifest.some(scene => scene.assetPath !== imagePath)) {
        throw new Error('Initial scene manifest did not preserve the script structure and visual assets');
      }
      const examplesScene = manifest.find(scene => scene.label === 'Examples');
      const ctaScene = manifest.find(scene => scene.label === 'Call to action');
      if (/\[[^\]]*\]/.test(examplesScene?.scriptText || '') || examplesScene?.scriptText !== 'A real example without template markers.') {
        throw new Error('Template placeholders leaked into scene narration');
      }
      if (ctaScene?.scriptText !== 'Subscribe. Like. Comment. Watch the next video.') {
        throw new Error('Call-to-action metadata leaked into spoken narration');
      }
      await db.replaceProductionScenes(production.id, manifest);
      for (const scene of await db.listProductionScenes(production.id)) {
        await db.updateProductionScene(production.id, scene.id, {
          audioPath: originalAudioPath, narrationStatus: 'current',
          narrationProvider: 'fixture-tts', narrationModel: 'fixture-voice'
        });
      }
      const roundTrip = await db.listProductionScenes(production.id);
      if (roundTrip.length !== manifest.length || roundTrip[0].scriptText !== manifest[0].scriptText) {
        throw new Error('Scene manifest did not round-trip through SQLite');
      }

      const fakeProvider = {
        id: 'seedance', model: 'seedance-test',
        normalizeRequest: request => ({ ...request, duration: Math.min(4, Number(request.duration || 4)) })
      };
      let useSlideshow = false;
      let regeneratedVisualStyle = null;
      const fakeGenerator = {
        mediaGeneration: {
          settings: async () => ({ provider: 'seedance', order: ['seedance'], clipDuration: 4, resolution: '720p', aspectRatio: '16:9' }),
          registry: { select: () => useSlideshow ? { id: 'slideshow' } : fakeProvider, get: () => fakeProvider },
          generateClip: async ({ outputPath }) => {
            await fs.mkdir(path.dirname(outputPath), { recursive: true });
            await fs.writeFile(outputPath, Buffer.from('generated scene video'));
            return { outputPath, task: { model: fakeProvider.model, external_task_id: 'scene-task-1' } };
          },
          isValidVideo: async () => true
        },
        generateVisualAssets: async (_prompt, style) => { regeneratedVisualStyle = style; return [imagePath]; },
        async generateTTSAudio(_text, outputPath) {
          await fs.writeFile(outputPath, Buffer.from('scene narration'));
          this.lastNarrationResult = {
            status: 'ready', path: outputPath, provider: 'fixture-tts', model: 'fixture-voice-v2',
            externalTaskId: 'narration-task-1', generatedAt: new Date().toISOString(),
            cost: { provider: 'fixture-tts', amount: null, invoiceRequired: true }
          };
          return outputPath;
        },
        isUsableAudioFile: async filePath => Boolean(filePath && await fs.stat(filePath).then(stat => stat.size > 0).catch(() => false)),
        renderMediaTimeline: async (_segments, outputPath) => { await fs.writeFile(outputPath, Buffer.from('rebuilt visual timeline')); return outputPath; },
        addAudioToVideo: async (videoPath, _audioPath, outputPath) => { await fs.copyFile(videoPath, outputPath); return outputPath; }
      };
      const service = new SceneRepairService(db, fakeGenerator, { dataRoot: directory, logger: this.logger });
      service.rebuildNarration = async () => originalAudioPath;
      const first = roundTrip[0];
      const edited = await service.updateScene(production.id, first.id, {
        scriptText: `${first.scriptText} Updated narration.`, prompt: `${first.prompt} Brighter composition.`, factualChange: false
      });
      if (edited.status !== 'visual_stale' || edited.narrationStatus !== 'stale' || edited.revision !== first.revision + 1) {
        throw new Error('Scene edits did not invalidate only the scene rebuild and narration state');
      }

      const quality = await new OperatorService(db).runQualityChecks({ ...(await db.getProductionBundle(production.id)), scenes: await db.listProductionScenes(production.id) }, {});
      if (quality.passed || !quality.blockingFailures.includes('scene_integrity')) {
        throw new Error('Approval quality checks did not block an unrepaired scene');
      }
      const estimate = await service.regenerationEstimate(production.id, first.id);
      if (!estimate.paid || estimate.provider !== 'seedance') throw new Error('Paid scene estimate did not expose provider billing risk');
      let paidBlocked = false;
      try {
        await service.regenerate(production.id, first.id, { regenerateNarration: true });
      } catch (error) {
        paidBlocked = error.code === 'PAID_CONFIRMATION_REQUIRED';
      }
      if (!paidBlocked) throw new Error('Paid scene regeneration started without explicit confirmation');
      const regenerated = await service.regenerate(production.id, first.id, { confirmPaid: true, regenerateNarration: true });
      if (
        regenerated.scene.status !== 'needs_rebuild' || regenerated.scene.externalTaskId !== 'scene-task-1' ||
        regenerated.scene.narrationStatus !== 'current' || regenerated.scene.narrationProvider !== 'fixture-tts' ||
        regenerated.scene.narrationTaskId !== 'narration-task-1'
      ) {
        throw new Error('Confirmed selective regeneration did not persist visual and narration evidence');
      }
      useSlideshow = true;
      await service.regenerate(production.id, roundTrip[1].id);
      if (regeneratedVisualStyle !== 'animated') {
        throw new Error('Scene regeneration ignored the configured channel visual style');
      }

      const second = roundTrip[1];
      const replacement = await sharp({ create: { width: 320, height: 180, channels: 3, background: '#ad3d45' } }).png().toBuffer();
      let rightsBlocked = false;
      try {
        await service.replaceAsset(production.id, second.id, { buffer: replacement, contentType: 'image/png', filename: 'replacement.png' });
      } catch (error) {
        rightsBlocked = error.code === 'RIGHTS_CONFIRMATION_REQUIRED';
      }
      if (!rightsBlocked) throw new Error('Uploaded scene asset bypassed rights confirmation');
      const replaced = await service.replaceAsset(production.id, second.id, {
        buffer: replacement, contentType: 'image/png', filename: 'replacement.png', rightsConfirmed: true
      });
      if (replaced.assetOrigin !== 'uploaded' || !replaced.rightsConfirmed || replaced.status !== 'needs_rebuild') {
        throw new Error('Replacement asset evidence did not persist');
      }

      const ordered = await service.reorder(production.id, (await db.listProductionScenes(production.id)).map(scene => scene.id).reverse());
      if (ordered[0].id === first.id) throw new Error('Scene timeline order did not persist');
      const rebuilt = await service.rebuild(production.id);
      const finalBundle = await db.getProductionBundle(production.id);
      if (!rebuilt.finalVideo || finalBundle.assets.finalVideo.previousPath !== oldVideoPath || finalBundle.scenes.some(scene => scene.status !== 'ready')) {
        throw new Error('Scene rebuild did not preserve the prior video and finalize every scene');
      }
      const revisions = await db.listProductionSceneRevisions(production.id);
      for (const action of ['edit', 'regenerate', 'replace_asset', 'reorder', 'rebuild']) {
        if (!revisions.some(revision => revision.action === action)) throw new Error(`Scene revision history is missing ${action}`);
      }

      const locked = await service.updateScene(production.id, ordered[0].id, { locked: true });
      let lockBlocked = false;
      try {
        await service.updateScene(production.id, locked.id, { prompt: 'Unauthorized locked edit' });
      } catch (error) {
        lockBlocked = error.status === 409;
      }
      if (!lockBlocked) throw new Error('Locked scene accepted an edit');
    } finally {
      await db.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
    this.logger.info('Scene Repair Studio test completed successfully');
  }

  async testNarrationReliability() {
    const fs = require('fs').promises;
    const os = require('os');
    const { SceneRepairService } = require('./utils/scene-repair-service');
    const { OperatorService } = require('./utils/operator-service');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-narration-'));
    const db = new Database();
    db.dbPath = path.join(directory, 'narration.db');
    await db.initialize();

    try {
      const productionId = 'prod-narration-recovery';
      const visualPath = path.join(directory, 'scene.png');
      const videoPath = path.join(directory, 'video.mp4');
      await fs.writeFile(visualPath, Buffer.from('visual'));
      await fs.writeFile(videoPath, Buffer.from('video'));
      const production = {
        id: productionId, status: 'ready',
        strategy: { topic: 'Narration recovery' },
        script: {
          title: 'Narration recovery',
          fullScript: 'A complete script that demonstrates reliable narration recovery and explicit operator controls.'.repeat(4)
        },
        seo: {
          title: 'Narration recovery',
          description: 'A detailed explanation of reliable narration recovery for production workflows.',
          tags: ['narration', 'recovery', 'workflow']
        },
        assets: {
          audio: { path: path.join(directory, 'missing.mp3.info'), status: 'unavailable', simulated: true, error: 'Provider quota exhausted' },
          finalVideo: { path: videoPath, simulated: false }, thumbnail: { path: visualPath }
        },
        timeline: {}, priority: 50, scheduledPublishTime: new Date(Date.now() + 86400000).toISOString()
      };
      await db.saveProductionData(production);
      await db.saveProductionSnapshot(production);
      await db.replaceProductionScenes(productionId, [{
        id: 'scene-narration-1', label: 'Opening', scriptText: 'This narration must be recovered.',
        prompt: 'Opening visual', duration: 8, assetType: 'image', assetOrigin: 'generated', assetPath: visualPath,
        status: 'ready', narrationStatus: 'unavailable', narrationError: 'Provider quota exhausted', rightsConfirmed: true
      }]);

      const blockedQuality = await new OperatorService(db).runQualityChecks({
        ...production, scenes: await db.listProductionScenes(productionId)
      }, {});
      if (blockedQuality.passed || !blockedQuality.blockingFailures.includes('narration')) {
        throw new Error('Missing narration did not block production quality');
      }

      let failProvider = true;
      const generator = {
        async generateTTSAudio(_text, outputPath) {
          if (failProvider) {
            this.lastNarrationResult = {
              status: 'failed', provider: 'openai', model: 'gpt-4o-mini-tts',
              generatedAt: new Date().toISOString(), error: 'Provider quota exhausted',
              cost: { provider: 'openai', amount: null, invoiceRequired: true }
            };
            throw new Error('Provider quota exhausted');
          }
          await fs.writeFile(outputPath, Buffer.from('recovered narration'));
          this.lastNarrationResult = {
            status: 'ready', path: outputPath, provider: 'openai', model: 'gpt-4o-mini-tts',
            externalTaskId: 'tts-task-1', generatedAt: new Date().toISOString(),
            cost: { provider: 'openai', amount: null, invoiceRequired: true }
          };
          return outputPath;
        },
        isUsableAudioFile: async filePath => Boolean(filePath && await fs.stat(filePath).then(stat => stat.size > 0).catch(() => false))
      };
      const service = new SceneRepairService(db, generator, {
        dataRoot: directory, logger: this.logger, getMediaDuration: async () => 5.25
      });

      let confirmationBlocked = false;
      try {
        await service.regenerateNarration(productionId, 'scene-narration-1');
      } catch (error) {
        confirmationBlocked = error.code === 'NARRATION_COST_CONFIRMATION_REQUIRED';
      }
      if (!confirmationBlocked) throw new Error('Narration regeneration bypassed the provider-cost confirmation');

      let outagePersisted = false;
      try {
        await service.regenerateNarration(productionId, 'scene-narration-1', { confirmCost: true });
      } catch (_error) {
        const failed = await db.getProductionScene(productionId, 'scene-narration-1');
        outagePersisted = failed.narrationStatus === 'failed' && failed.narrationProvider === 'openai' && /quota/.test(failed.narrationError);
      }
      if (!outagePersisted) throw new Error('Narration provider failure evidence was not persisted');

      failProvider = false;
      const recovered = await service.regenerateNarration(productionId, 'scene-narration-1', { confirmCost: true });
      if (
        recovered.narrationStatus !== 'current' || recovered.narrationProvider !== 'openai' ||
        recovered.narrationModel !== 'gpt-4o-mini-tts' || recovered.narrationTaskId !== 'tts-task-1' ||
        recovered.status !== 'needs_rebuild' || recovered.duration !== 5.75
      ) {
        throw new Error('Narration-only recovery did not preserve provider evidence and rebuild state');
      }

      let weakSilenceBlocked = false;
      try {
        await service.setSilenceOverride(productionId, { enabled: true, confirmed: true, reason: 'silent' });
      } catch (error) {
        weakSilenceBlocked = /at least 10/.test(error.message);
      }
      if (!weakSilenceBlocked) throw new Error('Intentional silence was accepted without a meaningful reason');

      await service.setSilenceOverride(productionId, {
        enabled: true, confirmed: true, reason: 'This visual demonstration intentionally uses captions only.'
      });
      const silenceBundle = await db.getProductionBundle(productionId);
      const silenceQuality = await new OperatorService(db).runQualityChecks(silenceBundle, {});
      const narrationCheck = silenceQuality.checks.find(check => check.id === 'narration');
      if (!narrationCheck?.passed || silenceBundle.scenes[0].narrationStatus !== 'intentional_silence') {
        throw new Error('Confirmed intentional silence did not satisfy the narration evidence gate');
      }

      const revisions = await db.listProductionSceneRevisions(productionId);
      for (const action of ['regenerate_narration', 'confirm_intentional_silence']) {
        if (!revisions.some(revision => revision.action === action)) throw new Error(`Narration history is missing ${action}`);
      }
    } finally {
      await db.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
    this.logger.info('Narration reliability and recovery test completed successfully');
  }

  async testDocumentaryOrchestrationContract() {
    const { YouTubeAutomationAgent } = require('./index');
    const { DailyAutomation } = require('./schedules/daily-automation');
    const { PublishingSchedulingAgent } = require('./agents/publishing-scheduling-agent');
    const { ContentStrategyAgent } = require('./agents/content-strategy-agent');
    const { ScriptWriterAgent } = require('./agents/script-writer-agent');
    const { ThumbnailDesignerAgent } = require('./agents/thumbnail-designer-agent');
    const { SEOOptimizerAgent } = require('./agents/seo-optimizer-agent');
    const { ProductionManagementAgent } = require('./agents/production-management-agent');
    const { AIVideoGenerator } = require('./utils/ai-video-generator');
    const fs = require('fs').promises;

    const agent = new YouTubeAutomationAgent();
    const strategyDefaults = agent.validateChannelStrategy({
      objective: 'Grow an original Horror Stickman Shorts channel',
      audience: 'Global English horror Shorts viewers',
      contentPillars: ['Everyday Situations Gone Wrong'],
      status: 'active'
    }, {});
    if (
      strategyDefaults.defaultFormat !== 'story' ||
      strategyDefaults.defaultLength !== 'short' ||
      strategyDefaults.cadencePerWeek !== 21
    ) {
      throw new Error('Operator defaults do not match the canonical Horror Stickman 3/day (21/week) Shorts contract');
    }

    const now = Date.now();
    let lastGeneration = new Date(now - 3 * 3600000).toISOString();
    const scheduler = new DailyAutomation({}, {
      getChannelStrategy: async () => ({ status: 'active', cadence_per_week: 28 }),
      getAllRows: async () => [],
      getSetting: async key => key === 'last_content_generation' ? lastGeneration : null
    }, {});
    if (await scheduler.shouldGenerateContentToday()) {
      throw new Error('Horror Shorts pacing ignored the ~6-hour 28/week generation interval');
    }
    lastGeneration = new Date(now - 7 * 3600000).toISOString();
    if (!await scheduler.shouldGenerateContentToday()) {
      throw new Error('Horror Shorts pacing did not allow the next due generation window');
    }

    // Without an explicit cadence the gate falls back to the channel identity: 3/day = 21/week = one Short per 8 hours.
    let defaultLast = new Date(now - 7 * 3600000).toISOString();
    const defaultPaced = new DailyAutomation({}, {
      getChannelStrategy: async () => ({ status: 'active' }),
      getAllRows: async () => [],
      getSetting: async key => key === 'last_content_generation' ? defaultLast : null
    }, {});
    if (await defaultPaced.shouldGenerateContentToday()) {
      throw new Error('Default Horror Shorts pacing ignored the 8-hour (21/week) generation interval');
    }
    defaultLast = new Date(now - 9 * 3600000).toISOString();
    if (!await defaultPaced.shouldGenerateContentToday()) {
      throw new Error('Default Horror Shorts pacing did not allow the next due window after 8 hours');
    }

    const existingPublishTime = new Date(now + 8 * 3600000).toISOString();
    const publishing = new PublishingSchedulingAgent({
      getChannelStrategy: async () => ({ status: 'active', cadence_per_week: 28 }),
      getScheduleEntriesInRange: async () => [{
        id: 'existing-short',
        publishTime: existingPublishTime,
        metadata: { contentType: 'short' },
        status: 'scheduled'
      }]
    }, {});
    let cadenceBlocked = false;
    try {
      await publishing.assertPublishingCadence(
        new Date(new Date(existingPublishTime).getTime() + 2 * 3600000).toISOString(),
        'short'
      );
    } catch (error) {
      cadenceBlocked = error.code === 'CADENCE_CONFLICT';
    }
    if (!cadenceBlocked) throw new Error('Core Shorts cadence allowed uploads too close together');

    const previousAutonomousMode = process.env.AUTONOMOUS_MODE;
    process.env.AUTONOMOUS_MODE = 'true';
    try {
      const strategyFallbackAgent = new ContentStrategyAgent({
        saveContentStrategy: async () => {}
      }, {});
      strategyFallbackAgent.aiTextService.isAvailable = () => true;
      strategyFallbackAgent.historicalPerformance = [];
      strategyFallbackAgent.trendingTopics = [];
      strategyFallbackAgent.competitorData = [];
      strategyFallbackAgent.generateContentStrategyWithAI = async () => {
        const drift = new Error('Horror strategy substituted a different requested premise');
        drift.code = 'STRATEGY_TOPIC_DRIFT';
        throw drift;
      };
      const fallbackStrategy = await strategyFallbackAgent.generateContentStrategy(
        'The Night Guard Saw Himself on a Camera From Tomorrow'
      );
      if (
        fallbackStrategy.topic !== 'The Night Guard Saw Himself on a Camera From Tomorrow' ||
        fallbackStrategy.storyEngine !== 'viewer-knows-first' ||
        fallbackStrategy.generationSource !== 'deterministic-fallback' ||
        !strategyFallbackAgent.isApprovedNicheCandidate(fallbackStrategy)
      ) {
        throw new Error('Deterministic Horror strategy fallback no longer preserves the requested premise and hard gates');
      }

      const writer = Object.create(ScriptWriterAgent.prototype);
      const range = writer.targetNarrationWordRange({});
      if (range.min !== 90 || range.max !== 140) throw new Error('Horror script word contract is not 90-140');

      const flagshipStrategy = {
        topic: 'She Got a Text From Her Own Bedroom While She Was Alone',
        idea: 'The Text From Upstairs',
        hook: 'Her phone buzzed from inside the locked bedroom',
        everydayAnchor: 'A woman sits downstairs alone while her locked bedroom is empty',
        fearMechanism: 'messages begin arriving from the phone location inside the locked bedroom',
        escalationLadder: [
          'the messages describe what she is doing downstairs',
          'the bedroom door handle begins moving while another message arrives'
        ],
        visualVariety: [
          'stickman holding glowing phone downstairs',
          'dark staircase leading toward bedroom',
          'locked bedroom door with moving handle',
          'phone showing a message from her own number',
          'second shadow appearing behind the downstairs stickman'
        ],
        storyEngine: 'impossible-message',
        payoff: 'The final message comes from her own number and says the person outside the bedroom is not her.',
        nicheFit: 10,
        visualStrength: 10,
        curiosityGap: 10,
        visualVarietyScore: 9,
        retentionPotential: 10,
        originalityScore: 10,
        brandFit: 10,
        twistScore: 9,
        premiseLegibility: 10,
        payoffStrength: 9,
        fictional: true
      };

      const deterministicFallback = writer.buildDeterministicHorrorFallback(flagshipStrategy, 'regression-test');
      if (
        deterministicFallback.metadata?.spokenWordCount < 90 ||
        deterministicFallback.metadata?.spokenWordCount > 140 ||
        deterministicFallback.mainContent?.sections?.length < 4 ||
        deterministicFallback.mainContent?.sections?.length > 7 ||
        writer.scriptContractIssues(deterministicFallback).length
      ) {
        throw new Error('Deterministic Horror script fallback no longer satisfies the same production contract');
      }

      const thumbnailGate = new ThumbnailDesignerAgent({ saveThumbnail: async () => {} }, {});
      thumbnailGate.assertAutonomousThumbnailContract({
        score: 96,
        visualIdea: 'A lone dark stickman stares at a glowing phone while a locked bedroom door creates one impossible threat cue behind her.',
        truthBoundary: 'Original fiction only; no gore, real people, logos, or twist spoiler.',
        scoring: { brandConsistency: 100, curiosity: 96, engineAlignment: 100 }
      }, flagshipStrategy);
      let weakVisualRejected = false;
      try {
        thumbnailGate.assertAutonomousThumbnailContract({
          score: 70,
          visualIdea: 'Bright funny cartoon.',
          truthBoundary: '',
          scoring: { brandConsistency: 30, curiosity: 40 }
        }, flagshipStrategy);
      } catch (error) {
        weakVisualRejected = error.code === 'AUTONOMOUS_THUMBNAIL_CONTRACT';
      }
      if (!weakVisualRejected) throw new Error('Bright/comedic visual hook bypassed the Horror brand gate');

      const packagingGate = new SEOOptimizerAgent({ getKeywordHistory: async () => [] }, {});
      packagingGate.assertAutonomousPackagingContract({
        selected: {
          title: 'She Got a Text From Her Own Bedroom',
          score: 94,
          scoring: { curiosity: 96, credibility: 100, specificity: 92, thumbnailComplementarity: 90 }
        },
        packagingScore: { overall: 92 },
        thumbnail: { concept: { score: 96 } },
        sources: [],
        strategy: flagshipStrategy,
        description: 'Her phone buzzed from inside the locked bedroom. Original Dark Stickman psychological horror short.'
      });

      const production = Object.create(ProductionManagementAgent.prototype);
      const script = {
        hook: { text: 'Her phone buzzed from inside the locked bedroom.' },
        mainContent: {
          sections: [1,2,3,4].map(number => ({
            title: `Beat ${number}`,
            content: [`The threat moves closer in beat ${number} without revealing the ending too early.`],
            duration: 7,
            visualQuery: `dark stickman apartment horror visual beat ${number}`,
            visualRequiredAny: ['stickman','phone'],
            visualForbiddenAny: ['bright','comedy','gore']
          }))
        }
      };
      const scenes = production.createHorrorStickmanScenePlan(script, flagshipStrategy, 32);
      if (
        scenes.length !== 4 ||
        scenes.some(scene => !/vertical 9:16/i.test(scene.prompt) || !/same recurring adult stickman/i.test(scene.prompt))
      ) {
        throw new Error('Horror production scene plan lost the vertical Dark Stickman consistency contract');
      }

      const generator = Object.create(AIVideoGenerator.prototype);
      const enhanced = generator.enhanceVisualPrompt('stickman beside a locked door', 'dark stickman psychological horror');
      if (!/vertical 9:16/i.test(enhanced) || !/no gore/i.test(enhanced) || !/dark stickman/i.test(enhanced)) {
        throw new Error('Synthetic image prompt lost Horror Stickman vertical safety anchors');
      }

      const operatorSource = (await fs.readFile(require.resolve('./utils/operator-service'), 'utf8'));
      if (
        !/short:\s*\[90, 140\]/.test(operatorSource) ||
        !/short:\s*\[20, 45\]/.test(operatorSource) ||
        !/duplicate_premise/.test(operatorSource) ||
        !/FROM generation_jobs[\s\S]*status = 'completed'/.test(operatorSource) ||
        !/horror_brand_style/.test(operatorSource)
      ) {
        throw new Error('Operator QA no longer enforces Horror Shorts word/runtime/originality/brand gates');
      }

      const mainSource = YouTubeAutomationAgent.prototype.generateContent.toString();
      if (!/requestedLengthKey = 'short'/.test(mainSource) || !/generated\.fictional = true/.test(mainSource)) {
        throw new Error('Canonical orchestrator can drift back to non-Short or factual generation');
      }
    } finally {
      if (previousAutonomousMode === undefined) delete process.env.AUTONOMOUS_MODE;
      else process.env.AUTONOMOUS_MODE = previousAutonomousMode;
    }

    this.logger.info('Horror Stickman orchestration contract test completed successfully');
  }

  async testSafeProviderReadinessDefaults() {
    const fs = require('fs').promises;
    const path = require('path');

    const envExample = await fs.readFile(path.join(__dirname, '.env.example'), 'utf8');
    if (
      /OPENAI_#/.test(envExample) ||
      /API_KEY=change-me-before-startyour-openai-api-key-here/.test(envExample)
    ) {
      throw new Error('The environment example still contains malformed or conflated API-key guidance');
    }

    const setupSource = await fs.readFile(path.join(__dirname, 'setup.js'), 'utf8');
    if (
      /AUTO_PUBLISH_ENABLED=true/.test(setupSource) ||
      /DAILY_CONTENT_ENABLED=true/.test(setupSource) ||
      /Your first video will be generated and scheduled within 24 hours/.test(setupSource)
    ) {
      throw new Error('Legacy auto-publish or daily-generation defaults remain in setup');
    }
    if (
      !/LONG_FORM_PER_WEEK=0/.test(setupSource) ||
      !/SHORTS_PER_WEEK=21/.test(setupSource) ||
      !/SHORTS_PER_DAY_TARGET=3/.test(setupSource)
    ) {
      throw new Error('Setup defaults do not reflect the canonical Horror Stickman 3/day (21/week) Shorts cadence');
    }
    if (!/AUTONOMOUS_MODE=false/.test(setupSource) || !/YOUTUBE_UPLOAD_ENABLED=false/.test(setupSource) || !/FREE_MEDIA_ONLY=true/.test(setupSource)) {
      throw new Error('Setup defaults can bypass the safe-boot autonomous, upload, or free-media policy');
    }
    if (!/AUTONOMOUS_MODE=false/.test(envExample) || !/YOUTUBE_UPLOAD_ENABLED=false/.test(envExample)) {
      throw new Error('Environment example no longer boots with autonomous upload disabled');
    }

    const channelIdentity = require('./config/channel-identity.json');
    if (
      Number(channelIdentity.publishingCadence?.shortsPerDay?.min) !== 2 ||
      Number(channelIdentity.publishingCadence?.shortsPerDay?.target) !== 3 ||
      Number(channelIdentity.publishingCadence?.shortsPerDay?.max) !== 4 ||
      Number(channelIdentity.publishingCadence?.shortsPerDay?.scaleCeiling) !== 20
    ) {
      throw new Error('Canonical Horror Stickman cadence is not locked to the 2-4/day launch range with target 3/day');
    }

    const runtimeVerifySource = await fs.readFile(path.join(__dirname, 'deploy', 'oracle-vm', 'verify-runtime.sh'), 'utf8');
    if (
      !/YOUTUBE_UPLOAD_ENABLED=false/.test(runtimeVerifySource) ||
      !/automationPaused/.test(runtimeVerifySource) ||
      !/expectedAgents/.test(runtimeVerifySource) ||
      /YOUTUBE_UPLOAD_ENABLED=true/.test(runtimeVerifySource)
    ) {
      throw new Error('Oracle runtime acceptance does not prove the safe seven-agent deployment state');
    }

    const autonomousVerifySource = await fs.readFile(path.join(__dirname, 'deploy', 'oracle-vm', 'verify-autonomous-runtime.sh'), 'utf8');
    const autonomousActivateSource = await fs.readFile(path.join(__dirname, 'deploy', 'oracle-vm', 'activate-autonomous.sh'), 'utf8');
    const installSource = await fs.readFile(path.join(__dirname, 'deploy', 'oracle-vm', 'install.sh'), 'utf8');
    const schedulerSource = await fs.readFile(path.join(__dirname, 'schedules', 'daily-automation.js'), 'utf8');
    const databaseSource = await fs.readFile(path.join(__dirname, 'database', 'db.js'), 'utf8');
    const niche = require('./config/horror-stickman-niche.json');

    if (
      !/AUTONOMOUS_MODE=true/.test(autonomousVerifySource) ||
      !/YOUTUBE_UPLOAD_ENABLED=true/.test(autonomousVerifySource) ||
      !/approval_required/.test(autonomousVerifySource) ||
      !/status !== 'active'/.test(autonomousVerifySource)
    ) {
      throw new Error('Autonomous runtime verification no longer proves no-human production state');
    }
    if (
      !/approval_required', 'false'/.test(autonomousActivateSource) ||
      !/automation_paused', 'false'/.test(autonomousActivateSource) ||
      !/YOUTUBE_UPLOAD_ENABLED=true/.test(autonomousActivateSource) ||
      !/api\/operator\/start/.test(autonomousActivateSource) ||
      !/verify-autonomous-runtime\.sh/.test(autonomousActivateSource) ||
      !/verify-runtime\.sh/.test(autonomousActivateSource) ||
      !/systemctl show youtube-agent\.service --property=Environment --value/.test(autonomousActivateSource) ||
      !/split\(autonomousPolicy\)/.test(autonomousActivateSource) ||
      !/baseConstraints/.test(autonomousActivateSource)
    ) {
      throw new Error('Autonomous activation no longer enables the quality-gated production loop');
    }
    if (!/activate-autonomous\.sh/.test(installSource)) {
      throw new Error('Oracle installer does not activate autonomous production after safe acceptance');
    }
    if (!/cron\.schedule\('0 \*\/2 \* \* \*'/.test(schedulerSource)) {
      throw new Error('Generation cadence is not checked frequently enough to sustain the Horror Stickman 4/day pacing contract');
    }
    if (!/\['approval_required', 'false'/.test(databaseSource)) {
      throw new Error('New databases still default to human approval');
    }
    if (
      Number(niche.hardGates?.nicheFitMin) < 9 ||
      Number(niche.hardGates?.visualStrengthMin) < 8 ||
      Number(niche.hardGates?.curiosityGapMin) < 9 ||
      Number(niche.hardGates?.retentionPotentialMin) < 9 ||
      Number(niche.hardGates?.originalityMin) < 9 ||
      Number(niche.hardGates?.brandFitMin) < 9 ||
      Number(niche.hardGates?.minVisualStates) < 4 ||
      Number(niche.hardGates?.maxVisualStates) > 7 ||
      Number(niche.hardGates?.minEscalationSteps) < 2 ||
      !Array.isArray(niche.brandSignature?.storyEngines) || niche.brandSignature.storyEngines.length < 8 ||
      niche.autonomousEditorialPolicy?.humanReviewRequired !== false
    ) {
      throw new Error('Horror Stickman hook/originality/brand/retention gates were weakened');
    }

    const packageJson = require('./package.json');
    if (packageJson.scripts['readiness:providers'] !== 'node scripts/provider-readiness-report.js') {
      throw new Error('Safe provider readiness command is missing');
    }

    const reportSource = await fs.readFile(path.join(__dirname, 'scripts', 'provider-readiness-report.js'), 'utf8');
    if (/apiKey\s*:\s*raw|client_secret\s*:\s*raw|tokens\.youtube\s*[,}]/.test(reportSource)) {
      throw new Error('Provider readiness report risks exposing raw credential values');
    }

    this.logger.info('Safe provider readiness defaults test completed successfully');
  }

  async testLiveProviderSmokeCLI() {
    const fs = require('fs').promises;
    const path = require('path');
    const packageJson = require('./package.json');
    if (packageJson.scripts['readiness:live'] !== 'node scripts/live-provider-smoke.js') {
      throw new Error('Live provider smoke command is missing');
    }

    const source = await fs.readFile(path.join(__dirname, 'scripts', 'live-provider-smoke.js'), 'utf8');
    if (!/--paid-image/.test(source) || !/--paid-video/.test(source) || !/--youtube/.test(source)) {
      throw new Error('Live provider smoke CLI does not require explicit paid-media and YouTube flags');
    }
    if (!/youtube\.channels\.list|probeYouTube/.test(
      await fs.readFile(path.join(__dirname, 'utils', 'production-readiness-service.js'), 'utf8')
    )) {
      throw new Error('YouTube readiness probe is not read-only channel access');
    }
    if (/videos\.insert|scheduleContent|publishContent|uploadToYouTube/.test(source)) {
      throw new Error('Live provider smoke CLI contains a publishing/upload path');
    }
    if (!/delete details\.taskId/.test(source) || !/delete details\.channelId/.test(source)) {
      throw new Error('Live provider smoke output is not stripping sensitive operational identifiers');
    }

    this.logger.info('Live provider smoke CLI test completed successfully');
  }

  async testCurrentGeminiProviderDefaults() {
    const fs = require('fs').promises;
    const path = require('path');

    const generatorSource = await fs.readFile(path.join(__dirname, 'utils', 'ai-video-generator.js'), 'utf8');
    const providerSource = await fs.readFile(path.join(__dirname, 'utils', 'video-providers.js'), 'utf8');
    const envExample = await fs.readFile(path.join(__dirname, '.env.example'), 'utf8');

    if (!/gemini-3\.8-flash-tts/.test(generatorSource) || /gemini-3\.1-flash-tts-preview/.test(generatorSource)) {
      throw new Error('Gemini narration default is still pinned to the legacy preview TTS model');
    }
    if (!/gemini-omni-1\.1-flash/.test(providerSource) || /gemini-omni-flash-preview/.test(providerSource)) {
      throw new Error('Gemini video default is still pinned to the legacy Omni preview model');
    }
    if (
      !/GEMINI_TTS_MODEL=gemini-3\.8-flash-tts/.test(envExample) ||
      !/GEMINI_VIDEO_MODEL=gemini-omni-1\.1-flash/.test(envExample)
    ) {
      throw new Error('Environment guidance does not match current Gemini provider defaults');
    }

    this.logger.info('Current Gemini provider defaults test completed successfully');
  }

  async testGeminiReadinessThinkingBudget() {
    const fs = require('fs').promises;
    const path = require('path');
    const aiSource = await fs.readFile(path.join(__dirname, 'utils', 'ai-text-service.js'), 'utf8');
    const readinessSource = await fs.readFile(path.join(__dirname, 'utils', 'production-readiness-service.js'), 'utf8');

    if (!/gemini-3\.8-flash/.test(aiSource)) {
      throw new Error('Gemini text default is not current');
    }
    if (!/thinkingLevel:\s*options\.thinkingLevel/.test(aiSource)) {
      throw new Error('Gemini text service cannot pass an explicit thinking level');
    }
    if (!/maxTokens:\s*128/.test(readinessSource) || !/thinkingLevel:\s*'low'/.test(readinessSource)) {
      throw new Error('Gemini readiness probe does not reserve enough visible output budget with low thinking');
    }

    this.logger.info('Gemini readiness thinking budget test completed successfully');
  }

  async testGeminiFreeModelFailover() {
    const { AITextService } = require('./utils/ai-text-service');
    const service = Object.create(AITextService.prototype);
    const tried = [];
    service.logger = { warn: () => {} };
    service._generateGemini = async (_client, _providerName, model) => {
      tried.push(model);
      if (model === 'gemini-3.8-flash') {
        const error = new Error('Quota exceeded for GenerateRequestsPerDayPerProjectPerModel-FreeTier');
        error.status = 429;
        throw error;
      }
      return 'READY';
    };

    const response = await service._generateGeminiWithModelFallback(
      {},
      'Google Gemini',
      'gemini-3.8-flash',
      'Reply READY',
      {}
    );
    const secondResponse = await service._generateGeminiWithModelFallback(
      {},
      'Google Gemini',
      'gemini-3.8-flash',
      'Reply READY again',
      {}
    );

    if (
      response !== 'READY' ||
      secondResponse !== 'READY' ||
      tried.join(',') !== 'gemini-3.8-flash,gemini-3.7-flash,gemini-3.7-flash'
    ) {
      throw new Error(`Gemini free-model failover/cooldown did not rotate correctly: ${tried.join(',')}`);
    }

    this.logger.info('Gemini free model failover test completed successfully');
  }

  async testProvenanceDesk() {
    const fs = require('fs').promises;
    const os = require('os');
    const { ProvenanceService } = require('./utils/provenance-service');
    const { OperatorService } = require('./utils/operator-service');
    const { PublishingSchedulingAgent } = require('./agents/publishing-scheduling-agent');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-provenance-'));
    const db = new Database();
    db.dbPath = path.join(directory, 'provenance.db');
    await db.initialize();
    const productionId = 'prod-provenance-test';
    const videoPath = path.join(directory, 'video.mp4');
    const audioPath = path.join(directory, 'narration.mp3');
    const thumbnailPath = path.join(directory, 'thumbnail.jpg');
    const captionsPath = path.join(directory, 'captions.vtt');
    const { runFFmpeg, checkFFmpeg } = require('./utils/ffmpeg');
    if (!(await checkFFmpeg())) {
      throw new Error('FFmpeg is required for the provenance quality fixture');
    }
    await runFFmpeg([
      '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-shortest', '-c:v', 'mpeg4', '-c:a', 'aac', videoPath
    ]);
    await runFFmpeg([
      '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-q:a', '4', audioPath
    ]);
    await fs.writeFile(thumbnailPath, Buffer.from('documentary-thumbnail-fixture'));
    await fs.writeFile(captionsPath, 'WEBVTT\\n\\n00:00.000 --> 00:01.000\\nEvidence-aware automation.\\n');

    try {
      await db.saveProductionData({
        id: productionId,
        status: 'needs_review',
        assets: {
          finalVideo: { path: videoPath, simulated: false },
          audio: { path: audioPath, status: 'ready', simulated: false, provider: 'fixture-tts' },
          thumbnail: { path: thumbnailPath, generatedWith: 'documentary-frame', productionReady: true },
          captions: { path: captionsPath }
        },
        timeline: {}, scheduledPublishTime: new Date(Date.now() + 86400000).toISOString(),
        priority: 50, estimatedDuration: '1:00'
      });
      const production = {
        id: productionId,
        strategy: {
          topic: 'Evidence-aware automation',
          researchSources: [{
            url: 'https://example.com/research/fact',
            title: 'Official research evidence',
            publisher: 'Example Institute',
            sourceType: 'official'
          }]
        },
        script: {
          title: 'Evidence-aware automation',
          fullScript: 'A sufficiently detailed script with a factual statement that must be reviewed before this production can be approved.'.repeat(3),
          claims: [{
            text: 'The documented workflow reduces repeated manual steps.',
            riskLevel: 'standard',
            sourceUrls: ['https://example.com/research/fact']
          }]
        },
        seo: {
          title: 'Evidence-aware automation',
          description: 'A detailed description of an evidence-aware automation workflow for careful channel operators.',
          tags: ['automation', 'evidence', 'workflow']
        },
        assets: {
          finalVideo: { path: videoPath, simulated: false },
          audio: { path: audioPath, status: 'ready', simulated: false, provider: 'fixture-tts' },
          thumbnail: { path: thumbnailPath, generatedWith: 'documentary-frame', productionReady: true },
          captions: { path: captionsPath }
        }
      };
      await db.saveProductionSnapshot(production);

      const provenanceService = new ProvenanceService(db);
      const initialized = await provenanceService.initialize(productionId, production);
      if (
        initialized.status !== 'blocked' || initialized.sources.length !== 1 ||
        initialized.claims.length !== 1 || initialized.claims[0].sourceIds.length !== 1
      ) {
        throw new Error('Generated research sources and claims were not initialized as unresolved provenance');
      }

      const publishGuard = new PublishingSchedulingAgent(db, {});
      publishGuard.publishQueue = [{ productionId, status: 'scheduled', metadata: {} }];
      let blockedPublishRejected = false;
      try {
        await publishGuard.publishContent(productionId);
      } catch (error) {
        blockedPublishRejected = error.code === 'PROVENANCE_BLOCKED';
      }
      if (!blockedPublishRejected) throw new Error('Publishing did not independently enforce the provenance gate');

      let unverifiedSupportRejected = false;
      try {
        await provenanceService.review(productionId, {
          sources: initialized.sources,
          claims: [{ ...initialized.claims[0], status: 'supported' }]
        });
      } catch (error) {
        unverifiedSupportRejected = /verified source/.test(error.message);
      }
      if (!unverifiedSupportRejected) throw new Error('A claim was supported without reviewer-verified evidence');

      const reviewed = await provenanceService.review(productionId, {
        sources: initialized.sources.map(source => ({ ...source, status: 'verified' })),
        claims: [{ ...initialized.claims[0], status: 'supported' }],
        containsSyntheticMedia: true
      });
      if (reviewed.status !== 'verified' || !reviewed.containsSyntheticMedia || reviewed.summary.unresolvedClaims !== 0) {
        throw new Error('A complete evidence review was not persisted as verified');
      }

      const bundle = await db.getProductionBundle(productionId);
      const quality = await new OperatorService(db).runQualityChecks({ ...production, provenance: bundle.provenance }, {});
      if (!quality.passed || !quality.checks.find(check => check.id === 'provenance' && check.passed)) {
        throw new Error('Verified provenance did not satisfy the production quality gate');
      }

      let uploadRequest;
      const publishing = new PublishingSchedulingAgent(db, {});
      publishing.youtube = {
        videos: { insert: async request => { uploadRequest = request; return { data: { id: 'provenance-video' } }; } }
      };
      const previousUploadFlag = process.env.YOUTUBE_UPLOAD_ENABLED;
      process.env.YOUTUBE_UPLOAD_ENABLED = 'true'; // In-memory videos.insert mock only.
      try {
        await publishing.uploadToYouTube({
          publishTime: new Date(Date.now() + 86400000).toISOString(),
          metadata: {
            seo: production.seo,
            video: { path: videoPath },
            privacyStatus: 'private',
            containsSyntheticMedia: true
          }
        });
      } finally {
        if (previousUploadFlag === undefined) delete process.env.YOUTUBE_UPLOAD_ENABLED;
        else process.env.YOUTUBE_UPLOAD_ENABLED = previousUploadFlag;
      }
      if (uploadRequest?.requestBody?.status?.containsSyntheticMedia !== true) {
        throw new Error('Synthetic-media disclosure was not handed to the YouTube upload request');
      }

      let emptyWaiverRejected = false;
      try {
        new ProvenanceService(db).build({
          sources: reviewed.sources,
          claims: [{ ...reviewed.claims[0], status: 'waived', notes: '' }]
        });
      } catch (error) {
        emptyWaiverRejected = /reviewer note/.test(error.message);
      }
      if (!emptyWaiverRejected) throw new Error('A claim waiver without a reviewer note was accepted');
    } finally {
      await db.close();
      await fs.rm(directory, { recursive: true, force: true });
    }

    this.logger.info('Research and provenance desk test completed successfully');
  }

  async testDiscoverabilityPreflight() {
    const previousApiKey = process.env.API_KEY;
    process.env.API_KEY = 'local-test-api-key';
    try {
    const fs = require('fs').promises;
    const os = require('os');
    const { DiscoverabilityService } = require('./utils/discoverability-service');
    const { DarkzSEOAdapter } = require('./utils/discoverability-adapters/darkzseo');
    const { OperatorService } = require('./utils/operator-service');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-discoverability-'));
    const db = new Database();
    db.dbPath = path.join(directory, 'discoverability.db');
    await db.initialize();
    const productionId = 'prod-discoverability-test';
    const fakeAdapter = {
      audit: async content => ({
        schemaVersion: '1.0',
        engine: { name: 'darkzseo', version: '1.4.0' },
        mode: 'content',
        target: content.id,
        status: 'attention_required',
        summary: {
          severity: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0, INFO: 0 },
          category: { SEO: 0, GEO: 1, AIO: 0, AEO: 0 }
        },
        findings: [{
          ruleId: 'geo.trust_network', category: 'GEO', severity: 'HIGH',
          applicability: ['youtube', 'content'],
          message: 'Trust Network: Long content lacks authority links',
          remediation: 'Add a verified authority source.'
        }]
      })
    };

    try {
      const bundledReport = await new DarkzSEOAdapter({ scriptPath: null }).audit({
        id: 'bundled-audit', platform: 'youtube', brand: 'AgentTube', title: 'Best workflow review',
        description: 'A useful comparison.', transcript: 'Detailed content '.repeat(100),
        sections: [{ title: 'What should you choose?', content: 'answer '.repeat(61) }]
      });
      if (
        bundledReport.engine.version !== '1.4.0-bundled' ||
        !bundledReport.findings.some(finding => finding.ruleId === 'aio.comparison_intent') ||
        !bundledReport.findings.some(finding => finding.ruleId === 'aio.direct_answer')
      ) {
        throw new Error('The bundled discoverability audit did not provide the public content contract');
      }
      const configuredPath = process.env.DARKZSEO_PATH;
      delete process.env.DARKZSEO_PATH;
      try {
        if (new DarkzSEOAdapter().scriptPath !== null) {
          throw new Error('DarkzSEO selected an external Python checkout without explicit configuration');
        }
      } finally {
        if (configuredPath === undefined) delete process.env.DARKZSEO_PATH;
        else process.env.DARKZSEO_PATH = configuredPath;
      }
      const brokenExternal = new DarkzSEOAdapter({ scriptPath: 'broken-darkzseo.py' });
      brokenExternal.auditExternal = async () => {
        const error = new Error('No module named darkzseo');
        error.code = 'DARKZSEO_FAILED';
        throw error;
      };
      const fallbackReport = await brokenExternal.audit({
        id: 'external-fallback', platform: 'youtube', title: 'Fallback audit'
      });
      if (fallbackReport.engine.version !== '1.4.0-bundled' || fallbackReport.status === 'unavailable') {
        throw new Error('A broken external DarkzSEO runtime did not fall back to the bundled audit');
      }
      await db.saveProductionData({
        id: productionId, status: 'needs_review', assets: {}, timeline: {},
        scheduledPublishTime: null, priority: 50, estimatedDuration: '1:00'
      });
      const production = {
        id: productionId,
        script: { title: 'AgentTube discoverability', fullScript: 'Detailed content '.repeat(200), sections: [] },
        seo: { title: 'AgentTube discoverability', description: 'A detailed discoverability review.', chapters: [] },
        provenance: { sources: [] }
      };
      await db.saveProductionSnapshot(production);
      const service = new DiscoverabilityService(db, { adapter: fakeAdapter });
      const first = await service.auditProduction(production, { channel_name: 'AgentTube' });
      if (first.engineVersion !== '1.4.0' || first.findings.length !== 1 || first.pendingCount !== 1) {
        throw new Error('The versioned DarkzSEO report was not persisted');
      }

      const quality = await new OperatorService(db).runQualityChecks({ ...production, discoverability: first }, {});
      const discoverabilityCheck = quality.checks.find(check => check.id === 'discoverability');
      if (!discoverabilityCheck || discoverabilityCheck.passed || discoverabilityCheck.blocking) {
        throw new Error('High-priority discoverability guidance was not advisory and visible');
      }

      let shortReasonRejected = false;
      try {
        await service.reviewFinding(first.findings[0].id, { status: 'dismissed', reason: 'no' });
      } catch (error) {
        shortReasonRejected = /at least 5/.test(error.message);
      }
      if (!shortReasonRejected) throw new Error('A false-positive dismissal without reviewer evidence was accepted');

      await service.reviewFinding(first.findings[0].id, { status: 'dismissed', reason: 'The cited source is attached in the approved evidence desk.' });
      const second = await service.auditProduction(production, { channel_name: 'AgentTube' });
      if (second.findings[0].reviewStatus !== 'dismissed' || second.pendingCount !== 0) {
        throw new Error('Finding review evidence did not carry forward across matching audits');
      }
      const reviewedQuality = await new OperatorService(db).runQualityChecks({ ...production, discoverability: second }, {});
      if (!reviewedQuality.checks.find(check => check.id === 'discoverability' && check.passed)) {
        throw new Error('A dismissed false positive remained an actionable quality warning');
      }

      const { YouTubeAutomationAgent } = require('./index');
      const apiAgent = new YouTubeAutomationAgent();
      apiAgent.db = db;
      apiAgent.operator = new OperatorService(db);
      apiAgent.discoverability = service;
      apiAgent.setupAPI();
      const server = await new Promise(resolve => {
        const listener = apiAgent.app.listen(0, '127.0.0.1', () => resolve(listener));
      });
      try {
        const address = server.address();
        const apiHeaders = { 'content-type': 'application/json', ...(process.env.API_KEY ? { 'x-api-key': process.env.API_KEY } : {}) };
        const runResponse = await fetch(`http://127.0.0.1:${address.port}/api/content/${productionId}/discoverability/run`, {
          method: 'POST', headers: apiHeaders, body: JSON.stringify({ platform: 'youtube' })
        });
        const runPayload = await runResponse.json();
        if (!runResponse.ok || runPayload.audit?.schemaVersion !== '1.0' || !runPayload.result?.discoverability) {
          throw new Error('Discoverability run API did not return the persisted versioned audit');
        }
        const apiFinding = runPayload.audit.findings[0];
        const reviewResponse = await fetch(`http://127.0.0.1:${address.port}/api/discoverability/findings/${apiFinding.id}`, {
          method: 'PATCH', headers: apiHeaders, body: JSON.stringify({ status: 'accepted' })
        });
        const reviewPayload = await reviewResponse.json();
        if (!reviewResponse.ok || reviewPayload.result?.finding?.reviewStatus !== 'accepted') {
          throw new Error('Discoverability review API did not persist the operator decision');
        }
      } finally {
        await new Promise(resolve => server.close(resolve));
      }

      const unavailableService = new DiscoverabilityService(db, {
        adapter: { audit: async () => { const error = new Error('Python is not installed'); error.code = 'DARKZSEO_UNAVAILABLE'; throw error; } }
      });
      const unavailable = await unavailableService.auditProduction(production, { channel_name: 'AgentTube' });
      if (unavailable.status !== 'unavailable' || unavailable.errorCode !== 'DARKZSEO_UNAVAILABLE' || unavailable.findings.length !== 0) {
        throw new Error('An unavailable DarkzSEO runtime was not stored explicitly');
      }
      const unavailableQuality = await new OperatorService(db).runQualityChecks({ ...production, discoverability: unavailable }, {});
      const unavailableCheck = unavailableQuality.checks.find(check => check.id === 'discoverability');
      if (!unavailableCheck || unavailableCheck.passed || unavailableCheck.blocking) {
        throw new Error('DarkzSEO runtime availability did not remain an explicit non-blocking check');
      }
    } finally {
      await db.close();
      await fs.rm(directory, { recursive: true, force: true });
    }

    this.logger.info('DarkzSEO discoverability preflight test completed successfully');
    } finally {
      if (previousApiKey === undefined) delete process.env.API_KEY;
      else process.env.API_KEY = previousApiKey;
    }
  }
  async testOpenIssueRegressions() {
    const { ModernAuth } = require('./modern-auth');
    const { YouTubeAutomationAgent } = require('./index');

    const auth = new ModernAuth();
    const fixedRedirect = auth.resolveRedirect({
      youtube: { redirect_uris: ['http://127.0.0.1'] }
    });
    if (fixedRedirect.hostname !== '127.0.0.1' || fixedRedirect.port < 8000 || fixedRedirect.pathname !== '/') {
      throw new Error('OAuth did not use a desktop-app loopback redirect with a local dynamic port');
    }

    const pipeline = new YouTubeAutomationAgent();
    pipeline.db = {
      getChannelProfile: async () => ({}),
      saveProductionData: async data => data.id,
      saveProductionSnapshot: async () => {},
      getSetting: async () => 'true',
      saveContentReview: async () => {},
      updateProductionStatus: async () => {}
    };
    pipeline.provenance = { initialize: async () => ({ sources: [], claims: [], status: 'not_required' }) };
    pipeline.operator = {
      runQualityChecks: async () => ({ passed: true, score: 100, checks: [], blockingFailures: [] }),
      notify: async () => {}
    };
    pipeline.preparePackagingExperiment = async () => null;
    pipeline.agents = {
      strategy: { generateContentStrategy: async () => ({
        topic: 'Null context',
        contentType: 'Explainer',
        angle: 'Original angle',
        researchSources: [{
          url: 'https://example.test/null-context',
          title: 'Null-context regression evidence',
          status: 'verified'
        }],
        researchContext: [{
          url: 'https://example.test/null-context',
          excerpt: 'A regression fixture proving that a null optional strategy context does not break the canonical pipeline.'
        }]
      }) },
      scriptWriter: { generateScript: async strategy => ({
        title: strategy.topic,
        hook: { text: 'The empty room answered before she even knocked.' },
        fullScript: 'Complete Horror Shorts regression fixture.',
        mainContent: {
          sections: [
            {
              title: 'Ordinary setup',
              content: ['She was alone in the apartment when a quiet knock came from the room she had locked before leaving for work.'],
              duration: 7
            },
            {
              title: 'First escalation',
              content: ['She stepped closer, and the knocking copied her footsteps exactly, stopping each time she stopped in the dark hallway.'],
              duration: 7
            },
            {
              title: 'Second escalation',
              content: ['Her phone lit up with a message from her own number telling her not to touch the bedroom door.'],
              duration: 7
            },
            {
              title: 'Twist',
              content: ['Then the handle turned from her side of the door, while the knocking continued softly from directly behind her.'],
              duration: 7
            }
          ]
        },
        callToAction: { subscribe: '' },
        claims: [],
        metadata: { strategy, fictional: true, spokenWordCount: 104 }
      }) },
      thumbnailDesigner: { generateThumbnail: async () => ({ path: 'thumbnail.png' }) },
      seoOptimizer: { optimize: async script => ({ title: script.title, description: 'Description', tags: ['test'] }) },
      production: { processContent: async input => ({
        id: 'null-context-production',
        status: 'ready',
        ...input,
        assets: {
          video: {
            scenePlan: [{
              index: 0,
              label: 'Regression section',
              narration: 'A null optional strategy context must not interrupt a valid generation handoff.'
            }],
            simulated: false
          },
          audio: { path: 'narration.mp3', simulated: false },
          finalVideo: { path: 'final.mp4', simulated: false },
          thumbnail: { path: 'thumbnail.png' }
        },
        timeline: {},
        scheduledPublishTime: new Date(Date.now() + 86400000).toISOString(),
        priority: 50
      }) },
      publishing: { scheduleContent: async () => null }
    };
    const generated = await pipeline.generateContent(null, null, 'short', { strategyContext: null });
    if (generated.contentId !== 'null-context-production') {
      throw new Error('A null manual strategy context still prevented generation');
    }

    // Autonomous mode with approval required: passing every gate means "ready for review",
    // never "rejected". Only a real gate failure is an autonomous rejection.
    const savedControl = {
      AUTONOMOUS_MODE: process.env.AUTONOMOUS_MODE,
      APPROVAL_REQUIRED: process.env.APPROVAL_REQUIRED
    };
    const notifications = [];
    pipeline.operator.notify = async notification => { notifications.push(notification.type); };
    try {
      process.env.AUTONOMOUS_MODE = 'true';
      process.env.APPROVAL_REQUIRED = 'true';

      const awaitingApproval = await pipeline.generateContent(null, null, 'short', { strategyContext: null });
      if (awaitingApproval.reviewStatus !== 'needs_review') {
        throw new Error(`A gate-passing production awaiting approval ended as ${awaitingApproval.reviewStatus}`);
      }
      if (notifications.includes('content_rejected') || !notifications.includes('review_required')) {
        throw new Error(`A gate-passing production awaiting approval sent the wrong notification: ${notifications.join(', ')}`);
      }

      notifications.length = 0;
      pipeline.operator.runQualityChecks = async () => ({
        passed: false, score: 40, checks: [], blockingFailures: ['narration']
      });
      let rejection = null;
      try {
        await pipeline.generateContent(null, null, 'short', { strategyContext: null });
      } catch (error) {
        rejection = error;
      }
      if (!rejection || rejection.code !== 'AUTONOMOUS_QUALITY_REJECTED') {
        throw new Error('A production that failed a gate was not rejected in autonomous mode');
      }
      if (!notifications.includes('content_rejected')) {
        throw new Error('A real autonomous rejection did not send the rejection notification');
      }
    } finally {
      for (const [name, value] of Object.entries(savedControl)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }

    this.logger.info('Open issue regression test completed successfully');
  }

  async testResumableGenerationCheckpoints() {
    const fs = require('fs').promises;
    const os = require('os');
    const { YouTubeAutomationAgent } = require('./index');
    const { GenerationRecoveryService } = require('./utils/generation-recovery-service');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-recovery-'));
    const db = new Database();
    db.dbPath = path.join(directory, 'recovery.db');
    await db.initialize();

    const thumbnailPath = path.join(directory, 'thumbnail.jpg');
    const videoPath = path.join(directory, 'video.mp4');
    await fs.writeFile(thumbnailPath, Buffer.from('thumbnail'));
    await fs.writeFile(videoPath, Buffer.from('video'));
    const strategy = {
      topic: 'Checkpointed automation',
      contentType: 'Tutorial',
      angle: 'Explain how checkpointed automation preserves work across restarts.',
      requestedStyle: 'tutorial',
      requestedLengthKey: 'short',
      researchSources: [{
        url: 'https://example.test/checkpoint-evidence',
        title: 'Checkpoint evidence',
        status: 'verified'
      }],
      researchContext: [{
        url: 'https://example.test/checkpoint-evidence',
        excerpt: 'Checkpointed automation preserves completed stages across controlled restarts.'
      }]
    };
    const script = {
      title: 'Checkpointed automation',
      fullScript: 'A complete script that can be reused after an interrupted generation run.',
      mainContent: {
        sections: [{
          title: 'Reusable stage',
          content: ['Checkpointed automation preserves completed work across a controlled restart.'],
          duration: 60
        }]
      },
      claims: [],
      metadata: { strategy }
    };
    let strategyCalls = 0;
    let scriptCalls = 0;
    let productionCalls = 0;

    try {
      const agent = new YouTubeAutomationAgent();
      agent.db = db;
      agent.recovery = new GenerationRecoveryService(db, {
        logger: agent.logger,
        baseDelayMs: 0,
        updateJobStage: (...args) => agent.updateJobStage(...args)
      });
      agent.readiness = { assertReady: async () => true };
      agent.operator = {
        runQualityChecks: async () => ({ passed: true, score: 100, checks: [{ passed: true }], blockingFailures: [] }),
        notify: async () => null
      };
      agent.agents = {
        strategy: { generateContentStrategy: async () => { strategyCalls++; return strategy; } },
        scriptWriter: { generateScript: async () => { scriptCalls++; return script; } },
        thumbnailDesigner: { generateThumbnail: async () => ({ path: thumbnailPath, concept: {} }) },
        seoOptimizer: { optimize: async () => ({ title: script.title, description: 'A complete description.', tags: ['automation'] }) },
        production: {
          processContent: async input => {
            productionCalls++;
            return {
              id: `recovery-production-${Date.now()}`,
              status: 'ready',
              ...input,
              assets: {
                video: {
                  scenePlan: [{
                    index: 0,
                    label: 'Reusable stage',
                    narration: 'Checkpointed automation preserves completed work across a controlled restart.',
                    assetPath: videoPath,
                    simulated: false
                  }],
                  simulated: false
                },
                audio: { path: videoPath, simulated: false },
                finalVideo: { path: videoPath, simulated: false },
                thumbnail: { path: thumbnailPath }
              },
              timeline: {},
              scheduledPublishTime: new Date(Date.now() + 86400000).toISOString(),
              priority: 50,
              estimatedDuration: '2:00'
            };
          }
        },
        publishing: { scheduleContent: async () => null }
      };

      const job = await db.createGenerationJob({
        topic: strategy.topic,
        style: 'tutorial',
        length: 'short',
        source: 'manual',
        strategyContext: { objective: 'Test recovery' }
      });
      await db.saveGenerationCheckpoint(job.id, 'strategy', {
        status: 'completed', artifact: strategy, completedAt: new Date().toISOString()
      });
      await db.saveGenerationCheckpoint(job.id, 'script', {
        status: 'completed', artifact: script, completedAt: new Date().toISOString()
      });
      await db.updateGenerationJob(job.id, { status: 'running', stage: 'thumbnail', progress: 40 });
      await db.markInterruptedJobs();
      const interrupted = await db.getGenerationJob(job.id);
      if (interrupted.status !== 'interrupted' || interrupted.stage !== 'thumbnail') {
        throw new Error('Restart recovery did not preserve the interrupted stage');
      }

      const resumed = await agent.resumeGenerationJob(job.id);
      if (resumed.details?.resumeFrom !== 'thumbnail') {
        throw new Error('Resume did not select the first incomplete stage');
      }
      await agent.waitForGenerationJob(job.id);
      const completed = await db.getGenerationJob(job.id);
      const checkpoints = await db.listGenerationCheckpoints(job.id);
      if (
        completed.status !== 'completed' ||
        checkpoints.filter(item => item.status === 'completed').length !== 6 ||
        strategyCalls !== 0 || scriptCalls !== 0 || productionCalls !== 1 ||
        !completed.details.reusedStages.includes('strategy') || !completed.details.reusedStages.includes('script')
      ) {
        throw new Error('Generation did not resume from verified checkpoints');
      }

      let transientAttempts = 0;
      const transientJob = await db.createGenerationJob({ topic: 'Transient retry' });
      const recovered = await agent.recovery.run(transientJob.id, 'strategy', 10, async () => {
        transientAttempts++;
        if (transientAttempts === 1) {
          const error = new Error('Temporary provider failure');
          error.status = 503;
          throw error;
        }
        return { topic: 'Recovered strategy' };
      });
      const transientCheckpoint = await db.getGenerationCheckpoint(transientJob.id, 'strategy');
      if (recovered.topic !== 'Recovered strategy' || transientAttempts !== 2 || transientCheckpoint.attempt_count !== 2) {
        throw new Error('A retry-safe transient stage failure was not recovered with bounded attempts');
      }

      const invalidJob = await db.createGenerationJob({ topic: 'Invalid dependency' });
      await db.saveGenerationCheckpoint(invalidJob.id, 'strategy', {
        status: 'completed', artifact: {}, completedAt: new Date().toISOString()
      });
      await db.saveGenerationCheckpoint(invalidJob.id, 'script', {
        status: 'completed', artifact: script, completedAt: new Date().toISOString()
      });
      await agent.recovery.run(invalidJob.id, 'strategy', 10, async () => ({ topic: 'Rebuilt dependency' }));
      if (await db.getGenerationCheckpoint(invalidJob.id, 'script')) {
        throw new Error('A stale downstream checkpoint survived invalid upstream artifact recovery');
      }
    } finally {
      await db.close();
      await fs.rm(directory, { recursive: true, force: true });
    }

    this.logger.info('Resumable generation checkpoints test completed successfully');
  }

  async testAPIValidationAndSecurity() {
    const { YouTubeAutomationAgent } = require('./index');
    const agent = new YouTubeAutomationAgent();

    if (typeof agent.validateGenerateRequestBody !== 'function') {
      throw new Error('validateGenerateRequestBody is not implemented');
    }
    if (typeof agent.requireAPIKey !== 'function') {
      throw new Error('requireAPIKey is not implemented');
    }

    const valid = agent.validateGenerateRequestBody({
      topic: 'Node automation',
      style: 'tutorial'
    });
    if (!valid.valid || valid.value.topic !== 'Node automation') {
      throw new Error('Valid generate request was rejected');
    }

    const invalidTopic = agent.validateGenerateRequestBody({ topic: 123 });
    if (invalidTopic.valid || invalidTopic.status !== 400) {
      throw new Error('Non-string topic was not rejected');
    }

    // The dashboard's "Generate Content Now" button sends an explicit null topic
    // to mean "pick a trending topic for me". null must be accepted, not rejected.
    const dashboardPayload = agent.validateGenerateRequestBody({ topic: null, style: 'story' });
    if (!dashboardPayload.valid) {
      throw new Error(`Dashboard generate payload was rejected: ${dashboardPayload.error}`);
    }
    if (dashboardPayload.value.topic !== null || dashboardPayload.value.style !== 'story') {
      throw new Error('Null topic was not normalised to an auto-selected topic');
    }

    const nullStyle = agent.validateGenerateRequestBody({ topic: 'Node automation', style: null });
    if (!nullStyle.valid || nullStyle.value.style !== null) {
      throw new Error('Null style was not accepted as "no style preference"');
    }

    const nullLength = agent.validateGenerateRequestBody({ topic: null, style: null, length: null });
    if (!nullLength.valid || nullLength.value.length !== 'short') {
      throw new Error('Null length did not fall back to the Horror Shorts default length');
    }

    const blankTopic = agent.validateGenerateRequestBody({ topic: '   ' });
    if (!blankTopic.valid || blankTopic.value.topic !== null) {
      throw new Error('Whitespace-only topic was not normalised to null');
    }

    const invalidStyle = agent.validateGenerateRequestBody({ style: 'x'.repeat(51) });
    if (invalidStyle.valid || invalidStyle.status !== 400) {
      throw new Error('Overlong style was not rejected');
    }

    const previousKey = process.env.API_KEY;
    process.env.API_KEY = 'test-secret';
    const middleware = agent.requireAPIKey();

    let rejectedNextCalled = false;
    const rejectedResponse = this.createMockResponse();
    middleware({ get: () => 'wrong-secret' }, rejectedResponse, () => {
      rejectedNextCalled = true;
    });

    if (rejectedNextCalled || rejectedResponse.statusCode !== 401) {
      throw new Error('Invalid API key was not rejected');
    }

    let acceptedNextCalled = false;
    const acceptedResponse = this.createMockResponse();
    middleware({ get: () => 'test-secret' }, acceptedResponse, () => {
      acceptedNextCalled = true;
    });

    if (!acceptedNextCalled || acceptedResponse.statusCode) {
      throw new Error('Valid API key was not accepted');
    }

    if (previousKey === undefined) {
      delete process.env.API_KEY;
    } else {
      process.env.API_KEY = previousKey;
    }

    this.logger.info('API validation and security test completed successfully');
  }

  createMockResponse() {
    return {
      statusCode: null,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      }
    };
  }

  async testUploadAuthorizationPolicy() {
    const { resolveControlState, publicationState, recordUploadAuthorization, PUBLICATION_STATES } = require('./utils/publishing-policy');
    const { YouTubeAutomationAgent } = require('./index');
    const { AutonomousChannelOperator } = require('./utils/autonomous-channel-operator');
    const keys = ['AUTONOMOUS_MODE', 'YOUTUBE_UPLOAD_ENABLED', 'APPROVAL_REQUIRED', 'AUTOMATION_PAUSED'];
    const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    const settings = new Map();
    const db = {
      getSetting: async key => (settings.has(key) ? settings.get(key) : null),
      setSetting: async (key, value) => { settings.set(key, String(value)); }
    };
    try {
      for (const key of keys) delete process.env[key];

      // Autonomy alone must never waive approval.
      process.env.AUTONOMOUS_MODE = 'true';
      settings.set('approval_required', 'true');
      let control = await resolveControlState(db);
      if (!control.autonomousMode || !control.approvalRequired || control.uploadEnabled || control.mode !== 'TEST_DEVELOPMENT') {
        throw new Error('AUTONOMOUS_MODE waived approval or enabled uploads on its own');
      }
      settings.delete('approval_required');
      if (!(await resolveControlState(db)).approvalRequired) throw new Error('Missing approval setting did not fail safe to required');

      // Environment wins over dashboard settings.
      settings.set('approval_required', 'false');
      process.env.APPROVAL_REQUIRED = 'true';
      control = await resolveControlState(db);
      if (!control.approvalRequired || control.sources.approvalRequired !== 'environment') {
        throw new Error('APPROVAL_REQUIRED in the environment did not override the dashboard setting');
      }
      process.env.AUTOMATION_PAUSED = 'true';
      if (!(await resolveControlState(db)).automationPaused) throw new Error('AUTOMATION_PAUSED in the environment was ignored');
      delete process.env.AUTOMATION_PAUSED;
      settings.set('automation_paused', 'true');
      if (!(await resolveControlState(db)).automationPaused) throw new Error('Dashboard pause was ignored');
      settings.set('automation_paused', 'false');

      // Mode 2 only with all four controls aligned.
      process.env.APPROVAL_REQUIRED = 'false';
      process.env.YOUTUBE_UPLOAD_ENABLED = 'true';
      control = await resolveControlState(db);
      if (control.mode !== 'AUTONOMOUS_PRODUCTION') throw new Error('Aligned production controls did not resolve to autonomous production');

      // Publication states.
      if (publicationState({ qaPassed: false, control }) !== PUBLICATION_STATES.NOT_READY) throw new Error('Failed QA was not NOT_READY');
      if (publicationState({ qaPassed: true, control }) !== PUBLICATION_STATES.UPLOAD_AUTHORIZED) throw new Error('Authorized QA pass was not UPLOAD_AUTHORIZED');
      if (publicationState({ qaPassed: true, control: { ...control, uploadEnabled: false } }) !== PUBLICATION_STATES.READY_FOR_PUBLISH) {
        throw new Error('Kill switch did not take precedence over autonomous mode');
      }
      if (publicationState({ qaPassed: true, control: { ...control, approvalRequired: true } }) !== PUBLICATION_STATES.READY_FOR_PUBLISH) {
        throw new Error('Approval-required pass was not READY_FOR_PUBLISH');
      }

      // Authorization transitions are recorded; the flag itself is never written.
      const first = await recordUploadAuthorization(db, control);
      const repeat = await recordUploadAuthorization(db, control);
      const killed = await recordUploadAuthorization(db, { ...control, uploadEnabled: false });
      if (!first.changed || repeat.changed || !killed.changed || killed.previous?.state !== 'enabled') {
        throw new Error('Upload authorization transitions were not recorded exactly once per change');
      }
      if (process.env.YOUTUBE_UPLOAD_ENABLED !== 'true') throw new Error('Recording authorization modified YOUTUBE_UPLOAD_ENABLED');

      // Running automated jobs stop at the next stage checkpoint; manual jobs continue.
      const jobs = { auto: { id: 'auto', source: 'scheduler' }, manual: { id: 'manual', source: 'manual' } };
      const agent = Object.create(YouTubeAutomationAgent.prototype);
      agent.db = { ...db, getGenerationJob: async id => jobs[id] || null };
      settings.set('automation_paused', 'true');
      let pausedCode = null;
      try { await agent.assertJobMayContinue('auto', 'production'); } catch (error) { pausedCode = error.code; }
      if (pausedCode !== 'AUTOMATION_PAUSED') throw new Error('A paused automated job did not stop at the stage checkpoint');
      await agent.assertJobMayContinue('manual', 'production');

      // The operator stops before new items and ends the run as resumable.
      const runs = new Map([['run-1', { id: 'run-1', status: 'running', plan: [], generatedJobs: [] }]]);
      const operator = new AutonomousChannelOperator({
        getOperatorRun: async id => runs.get(id),
        updateOperatorRun: async (id, changes) => { runs.set(id, { ...runs.get(id), ...changes }); return runs.get(id); },
        createContentIdea: async () => { throw new Error('No new item may start while paused'); }
      }, {
        researchAndPlan: async () => ({ research: {}, plan: [{ topic: 'A door that locks from the wrong side', format: 'story' }] }),
        startGenerationJob: async () => { throw new Error('No job may start while paused'); },
        isAutomationPaused: async () => true,
        requiresHumanApproval: async () => false
      });
      await operator.execute('run-1', { status: 'active' });
      const pausedRun = runs.get('run-1');
      if (pausedRun.status !== 'interrupted' || pausedRun.stage !== 'paused') {
        throw new Error('Paused operator run did not end as a resumable interrupted run');
      }
    } finally {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
    this.logger.info('Upload authorization policy test completed successfully');
  }

  async testHorrorLearningLoop() {
    const { ChannelLearningEngine } = require('./utils/channel-learning-engine');
    const { ContentStrategyAgent } = require('./agents/content-strategy-agent');
    const engine = new ChannelLearningEngine({});

    const attributes = engine.extractAttributes(
      { videoDetails: { title: 'Her phone buzzed from inside the locked bedroom', duration: 'PT41S' } },
      {
        contentFormat: 'short',
        strategy: { topic: 'The Text From Upstairs', storyEngine: 'impossible-message' },
        script: { hook: 'Her phone buzzed from inside the locked bedroom.' }
      }
    );
    if (attributes.storyEngine !== 'impossible_message' || attributes.hookStyle !== 'punchy' || attributes.runtimeBand !== '38_45s') {
      throw new Error(`Horror Shorts attributes were not captured for learning: ${JSON.stringify(attributes)}`);
    }

    const snapshot = (engine, retention, extra = {}) => ({
      contentAttributes: { surface: 'shorts', format: 'shorts', length: 'short', storyEngine: engine, ...extra },
      metrics: { retention }
    });
    const recommendations = engine.buildDimensionRecommendations([
      snapshot('wrong_reflection', 92), snapshot('wrong_reflection', 88),
      snapshot('impossible_sound', 61), snapshot('impossible_sound', 66)
    ]);
    const engineLearning = recommendations.find(item => item.proposedChange?.dimension === 'storyEngine');
    if (!engineLearning || engineLearning.proposedChange.prefer !== 'wrong_reflection' ||
      engineLearning.proposedChange.deprioritize !== 'impossible_sound' || engineLearning.proposedChange.target !== 'future_plans') {
      throw new Error('A real story-engine retention gap did not produce a planning recommendation');
    }
    if (!engine.canAutoApproveRecommendation(engineLearning)) {
      throw new Error('A two-sample-per-group story-engine learning was not eligible for autonomous approval');
    }
    const noise = engine.buildDimensionRecommendations([
      snapshot('wrong_reflection', 80), snapshot('wrong_reflection', 79),
      snapshot('impossible_sound', 77), snapshot('impossible_sound', 76)
    ]);
    if (noise.some(item => item.proposedChange?.dimension === 'storyEngine')) {
      throw new Error('A small retention difference was treated as a learning');
    }

    const strategy = Object.create(ContentStrategyAgent.prototype);
    const up = strategy.learnedPlanAdjustment({ storyEngine: 'wrong-reflection' }, [engineLearning]);
    const down = strategy.learnedPlanAdjustment({ storyEngine: 'impossible-sound' }, [engineLearning]);
    const neutral = strategy.learnedPlanAdjustment({ storyEngine: 'repetition-loop' }, [engineLearning]);
    if (!(up.delta > 0) || !(down.delta < 0) || neutral.delta !== 0 || Math.abs(up.delta) > 10) {
      throw new Error('Approved learnings did not apply a bounded preference to plan ranking');
    }
    const ignored = strategy.learnedPlanAdjustment({ storyEngine: 'wrong-reflection' }, [{
      ...engineLearning, proposedChange: { ...engineLearning.proposedChange, target: 'future_scripts' }
    }]);
    if (ignored.delta !== 0) throw new Error('A script-level learning changed topic planning');

    this.logger.info('Horror learning loop test completed successfully');
  }

  async testFinalVideoTechnicalGates() {
    const os = require('os');
    const fs = require('fs').promises;
    const { runFFmpeg, probeMediaStreams, detectBlackSegments, getAudioLevels } = require('./utils/ffmpeg');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'video-gates-'));
    try {
      const landscape = path.join(directory, 'landscape.mp4');
      await runFFmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=#1c2233:s=640x360:r=25:d=2', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono',
        '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', landscape]);
      const streams = await probeMediaStreams(landscape);
      if (streams.width !== 640 || streams.height !== 360 || streams.fps !== 25 || !streams.hasAudio) {
        throw new Error(`Stream probe misread the video: ${JSON.stringify(streams)}`);
      }

      const black = path.join(directory, 'black.mp4');
      await runFFmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=black:s=1080x1920:r=30:d=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', black]);
      const segments = await detectBlackSegments(black);
      if (!segments.length || segments[0].duration < 2.5) throw new Error('A fully black video was not detected');

      const dark = path.join(directory, 'dark.mp4');
      await runFFmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=#0b0e16:s=1080x1920:r=30:d=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', dark]);
      if ((await detectBlackSegments(dark)).length) throw new Error('The deliberately dark Dark Stickman palette was flagged as black video');

      const silent = path.join(directory, 'silent.mp3');
      await runFFmpeg(['-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '2', '-acodec', 'libmp3lame', silent]);
      const levels = await getAudioLevels(silent);
      if (levels.meanVolume > -80) throw new Error('Silent narration was not measured as silent');

      const { AIVideoGenerator } = require('./utils/ai-video-generator');
      const generator = Object.create(AIVideoGenerator.prototype);
      const beats = ['a.png', 'b.png', 'c.png', 'd.png'].map((file, index) => ({ path: file, duration: [8, 4, 4, 2][index] }));
      const timeline = generator.buildImageTimeline(beats, beats.map(beat => beat.path), 36);
      const total = timeline.reduce((sum, item) => sum + item.duration, 0);
      if (Math.abs(total - 36) > 0.01 || Math.abs(timeline[0].duration - 16) > 0.01 || Math.abs(timeline[3].duration - 4) > 0.01) {
        throw new Error('Still timeline did not follow narration-proportional beat durations');
      }
      if (timeline[0].motion !== 'push-in-fast' || timeline[3].motion !== 'creep-in' || timeline.some(item => !generator.stillMotionFilter(item.motion, item.duration))) {
        throw new Error('Still timeline beats lost their camera motion');
      }
      if (generator.buildImageTimeline(beats, ['a.png'], 36) !== null) {
        throw new Error('A timeline with missing images was not rejected');
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
    this.logger.info('Final video technical gates test completed successfully');
  }

  async testFreeLocalVoiceFallback() {
    const os = require('os');
    const fs = require('fs').promises;
    const { AIVideoGenerator } = require('./utils/ai-video-generator');
    const { getMediaDuration } = require('./utils/ffmpeg');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'local-voice-'));
    const previous = { cmd: process.env.LOCAL_TTS_COMMAND, label: process.env.LOCAL_TTS_LABEL, lock: process.env.NARRATOR_LOCK };
    try {
      // Stand-in local engine with Piper-style flags; writes a WAV sized to the text.
      const fake = path.join(directory, 'fake-tts.js');
      await fs.writeFile(fake, `
        const fs = require('fs');
        const { runFFmpeg } = require(${JSON.stringify(path.join(__dirname, 'utils', 'ffmpeg'))});
        const args = process.argv.slice(2);
        const text = fs.readFileSync(args[args.indexOf('--input-file') + 1], 'utf8');
        const seconds = Math.max(1, text.split(/\\s+/).filter(Boolean).length / 2.7).toFixed(2);
        runFFmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=160:sample_rate=22050', '-t', seconds, args[args.indexOf('-f') + 1]])
          .catch(error => { console.error(error.message); process.exit(1); });
      `);
      const generator = new AIVideoGenerator({});
      generator.gemini = {};
      generator.generateGeminiTTS = async () => {
        const error = new Error('RESOURCE_EXHAUSTED: free tier quota');
        error.status = 429;
        throw error;
      };
      const text = 'The knocking answered every step he took. '.repeat(14);
      const output = path.join(directory, 'narration.mp3');

      process.env.LOCAL_TTS_COMMAND = `${process.execPath} ${fake} --input-file {text} -f {wav}`;
      process.env.LOCAL_TTS_LABEL = 'piper:test-voice';

      // Default (narrator lock on): an exhausted primary voice must NOT hand over to another voice.
      delete process.env.NARRATOR_LOCK;
      let lockedFailedClosed = false;
      try { await generator.generateTTSAudio(text, output); } catch (_error) {
        lockedFailedClosed = generator.lastNarrationResult.status === 'failed' && generator.lastNarrationResult.provider === 'gemini';
      }
      if (!lockedFailedClosed) throw new Error(`Narrator lock let a fallback voice narrate: ${JSON.stringify(generator.lastNarrationResult)}`);

      // Explicit opt-out restores the free local voice chain.
      process.env.NARRATOR_LOCK = 'false';
      await generator.generateTTSAudio(text, output);
      const result = generator.lastNarrationResult;
      if (result.status !== 'ready' || result.provider !== 'local-tts' || result.fallbackFrom?.[0] !== 'gemini' ||
        result.cost.invoiceRequired !== false || !((await getMediaDuration(output)) > 20)) {
        throw new Error(`Exhausted Gemini narration did not fall back to the free local voice: ${JSON.stringify(result)}`);
      }

      delete process.env.LOCAL_TTS_COMMAND;
      let failedClosed = false;
      try { await generator.generateTTSAudio(text, output); } catch (_error) { failedClosed = generator.lastNarrationResult.status === 'failed'; }
      if (!failedClosed) throw new Error('Narration without any working voice did not fail closed');

      process.env.LOCAL_TTS_COMMAND = `${process.execPath} ${fake}`;
      let placeholderRejected = false;
      try { await generator.generateTTSAudio(text, output); } catch (error) { placeholderRejected = /placeholders/.test(error.message); }
      if (!placeholderRejected) throw new Error('A LOCAL_TTS_COMMAND without {text}/{wav} placeholders was accepted');
    } finally {
      if (previous.cmd === undefined) delete process.env.LOCAL_TTS_COMMAND; else process.env.LOCAL_TTS_COMMAND = previous.cmd;
      if (previous.label === undefined) delete process.env.LOCAL_TTS_LABEL; else process.env.LOCAL_TTS_LABEL = previous.label;
      if (previous.lock === undefined) delete process.env.NARRATOR_LOCK; else process.env.NARRATOR_LOCK = previous.lock;
      await fs.rm(directory, { recursive: true, force: true });
    }
    this.logger.info('Free local voice fallback test completed successfully');
  }

  async testPublishingSafety() {
    const previousUploadFlag = process.env.YOUTUBE_UPLOAD_ENABLED;
    process.env.YOUTUBE_UPLOAD_ENABLED = 'true'; // All YouTube clients in this fixture are in-memory mocks.
    try {
    const { PublishingSchedulingAgent } = require('./agents/publishing-scheduling-agent');
    const intentionalAudio = {
      intentionalSilence: true,
      silenceReason: 'This test fixture is intentionally silent.',
      silenceConfirmedAt: new Date().toISOString()
    };
    const approvedBundle = id => ({ id, reviewStatus: 'approved', provenance: { status: 'not_required' } });
    const passingQa = async () => ({ passed: true, score: 100, blockingFailures: [], checks: [] });
    const verifiedYouTube = (status = 'uploaded') => ({
      videos: { list: async ({ id }) => ({ data: { items: [{ id, status: { uploadStatus: status } }] } }) }
    });

    const agent = new PublishingSchedulingAgent({
      updateScheduleEntry: async () => {},
      getProductionBundle: async id => approvedBundle(id)
    }, {});
    agent.preUploadVerifier = passingQa;
    agent.youtube = verifiedYouTube();

    agent.publishQueue = [
      { productionId: 'prod-a', title: 'A', status: 'scheduled', metadata: { audio: intentionalAudio } },
      { productionId: 'prod-b', title: 'B', status: 'scheduled', metadata: { audio: intentionalAudio } }
    ];
    agent.uploadToYouTube = async () => ({ id: 'youtube-1' });

    const publishedA = await agent.publishContent('prod-a');

    if (agent.publishQueue.length !== 1 || agent.publishQueue[0].productionId !== 'prod-b') {
      throw new Error('publishContent removed the wrong publish queue entries');
    }
    if (publishedA.status !== 'published' || publishedA.youtubeId !== 'youtube-1' || publishedA.metadata?.preUploadQa?.passed !== true) {
      throw new Error('A verified upload was not recorded with its video ID and pre-upload QA evidence');
    }

    // Mandatory gates are re-run before every upload; a failing gate blocks before any network call.
    const blockedUploads = [];
    const qaBlocked = new PublishingSchedulingAgent({
      updateScheduleEntry: async () => {},
      getProductionBundle: async id => approvedBundle(id)
    }, {});
    qaBlocked.preUploadVerifier = async () => ({ passed: false, score: 60, blockingFailures: ['narration_audible'], checks: [] });
    qaBlocked.publishQueue = [{ productionId: 'prod-qa', title: 'QA', status: 'scheduled', metadata: { audio: intentionalAudio } }];
    qaBlocked.uploadToYouTube = async () => { blockedUploads.push('qa'); return { id: 'never' }; };
    let qaBlockCode = null;
    try { await qaBlocked.publishContent('prod-qa'); } catch (error) { qaBlockCode = error.code; }
    if (qaBlockCode !== 'PRE_UPLOAD_QA_FAILED' || blockedUploads.length || qaBlocked.publishQueue[0].status !== 'blocked') {
      throw new Error('A failing pre-upload QA gate did not block the upload');
    }

    const noVerifier = new PublishingSchedulingAgent({
      updateScheduleEntry: async () => {},
      getProductionBundle: async id => approvedBundle(id)
    }, {});
    noVerifier.publishQueue = [{ productionId: 'prod-nov', title: 'No verifier', status: 'scheduled', metadata: { audio: intentionalAudio } }];
    noVerifier.uploadToYouTube = async () => { blockedUploads.push('nov'); return { id: 'never' }; };
    let noVerifierCode = null;
    try { await noVerifier.publishContent('prod-nov'); } catch (error) { noVerifierCode = error.code; }
    if (noVerifierCode !== 'PRE_UPLOAD_QA_FAILED' || blockedUploads.length) {
      throw new Error('Publishing without a pre-upload QA verifier did not fail closed');
    }

    const rejected = new PublishingSchedulingAgent({
      updateScheduleEntry: async () => {},
      getProductionBundle: async id => approvedBundle(id)
    }, {});
    rejected.preUploadVerifier = passingQa;
    rejected.youtube = verifiedYouTube('rejected');
    rejected.publishQueue = [{ productionId: 'prod-rej', title: 'Rejected', status: 'scheduled', metadata: { audio: intentionalAudio } }];
    rejected.uploadToYouTube = async () => ({ id: 'youtube-rejected' });
    let rejectedCode = null;
    try { await rejected.publishContent('prod-rej'); } catch (error) { rejectedCode = error.code; }
    if (rejectedCode !== 'UPLOAD_REJECTED' || rejected.publishQueue[0].status !== 'failed') {
      throw new Error('A YouTube-rejected upload was recorded as published');
    }

    const transient = new PublishingSchedulingAgent({
      updateScheduleEntry: async () => {},
      getProductionBundle: async id => approvedBundle(id)
    }, {});
    transient.preUploadVerifier = passingQa;
    transient.publishQueue = [{ productionId: 'prod-429', title: 'Busy', status: 'scheduled', publishTime: new Date().toISOString(), metadata: { audio: intentionalAudio } }];
    transient.uploadToYouTube = async () => { const error = new Error('Too many requests'); error.status = 429; throw error; };
    let transientRetry = false;
    try { await transient.publishContent('prod-429'); } catch (error) { transientRetry = error.retryScheduled === true; }
    const retried = transient.publishQueue[0];
    if (!transientRetry || retried.status !== 'scheduled' || retried.metadata.publishRetries !== 1 ||
      new Date(retried.publishTime).getTime() <= Date.now()) {
      throw new Error('A transient publish failure was not rescheduled with backoff');
    }

    const missingNarration = new PublishingSchedulingAgent({ updateScheduleEntry: async () => {} }, {});
    missingNarration.publishQueue = [{ productionId: 'prod-no-audio', status: 'scheduled', metadata: {} }];
    missingNarration.uploadToYouTube = async () => { throw new Error('Upload must not start without narration'); };
    let narrationPublishBlocked = false;
    try {
      await missingNarration.publishContent('prod-no-audio');
    } catch (error) {
      narrationPublishBlocked = error.code === 'NARRATION_REQUIRED';
    }
    if (!narrationPublishBlocked) throw new Error('Publishing accepted a production without narration evidence');

    let missingFileRejected = false;
    try {
      await agent.getVideoStream(path.join(__dirname, 'data', 'missing-placeholder.mp4'));
    } catch (error) {
      missingFileRejected = /video file not found/.test(error.message);
    }

    if (!missingFileRejected) {
      throw new Error('getVideoStream did not reject a missing video file');
    }

    let uncertainUpdates = [];
    const uncertain = new PublishingSchedulingAgent({
      updateScheduleEntry: async entry => uncertainUpdates.push({ ...entry }),
      getProductionBundle: async id => approvedBundle(id)
    }, {});
    uncertain.preUploadVerifier = passingQa;
    uncertain.publishQueue = [
      { id: 'schedule-uncertain', productionId: 'prod-uncertain', title: 'Uncertain', status: 'scheduled', metadata: { audio: intentionalAudio } }
    ];
    let uploadAttempts = 0;
    uncertain.uploadToYouTube = async entry => {
      uploadAttempts++;
      entry.uploadAttempted = true;
      const error = new Error('socket closed during upload');
      error.code = 'ECONNRESET';
      throw error;
    };
    let uncertainBlocked = false;
    try {
      await uncertain.publishContent('prod-uncertain');
    } catch (error) {
      uncertainBlocked = error.code === 'UPLOAD_OUTCOME_UNKNOWN';
    }
    try {
      await uncertain.publishContent('prod-uncertain');
    } catch (error) {
      uncertainBlocked = uncertainBlocked && error.code === 'UPLOAD_OUTCOME_UNKNOWN';
    }
    if (!uncertainBlocked || uploadAttempts !== 1 || uncertainUpdates.at(-1)?.status !== 'reconciliation_required') {
      throw new Error('An uncertain upload outcome was retried or failed to require reconciliation');
    }

    let reconciliationCalls = 0;
    const recorded = {
      id: 'schedule-recorded', productionId: 'prod-recorded', title: 'Recorded', status: 'uploaded',
      youtubeId: 'youtube-existing', metadata: { audio: intentionalAudio }
    };
    const reconcile = new PublishingSchedulingAgent({
      getLatestScheduleEntry: async () => recorded,
      updateScheduleEntry: async () => {}
    }, {});
    reconcile.youtube = {
      videos: {
        list: async () => {
          reconciliationCalls++;
          return { data: { items: [{ id: 'youtube-existing' }] } };
        }
      }
    };
    reconcile.uploadToYouTube = async () => {
      throw new Error('A recorded upload must never be uploaded again');
    };
    const reconciled = await reconcile.publishContent('prod-recorded');
    if (reconciled.status !== 'published' || reconciliationCalls !== 1) {
      throw new Error('A recorded YouTube upload was not reconciled idempotently');
    }

    let deletedScheduleId = null;
    const scheduleActions = new PublishingSchedulingAgent({
      updateScheduleEntry: async () => {},
      deleteScheduleEntry: async id => { deletedScheduleId = id; }
    }, {});
    scheduleActions.publishQueue = [{
      id: 'schedule-actions', productionId: 'prod-actions', title: 'Actions', status: 'scheduled',
      publishTime: new Date(Date.now() + 3600000).toISOString(), metadata: { audio: intentionalAudio }
    }];
    const future = new Date(Date.now() + 7200000).toISOString();
    const rescheduled = await scheduleActions.rescheduleContent('prod-actions', future);
    if (rescheduled.publishTime !== future || rescheduled.status !== 'scheduled') {
      throw new Error('Scheduled content could not be rescheduled');
    }
    await scheduleActions.deleteScheduledContent('prod-actions');
    if (deletedScheduleId !== 'schedule-actions' || scheduleActions.publishQueue.length) {
      throw new Error('Deleting a schedule did not preserve content while removing the queue entry');
    }

    let uploadMetadata = null;
    const immediate = new PublishingSchedulingAgent({ updateScheduleEntry: async () => {} }, {});
    immediate.youtube = {
      videos: { insert: async request => { uploadMetadata = request.requestBody; return { data: { id: 'youtube-now' } }; } },
      thumbnails: { set: async () => {} }, captions: { insert: async () => {} }
    };
    immediate.getVideoStream = async () => ({ fixture: true });
    await immediate.uploadToYouTube({
      id: 'schedule-now', publishTime: new Date().toISOString(),
      metadata: { seo: { title: 'Publish now', description: 'Immediate upload.', tags: ['test'] }, video: { path: 'fixture.mp4' }, privacyStatus: 'public' }
    }, { publishNow: true });
    if (uploadMetadata?.status?.privacyStatus !== 'public' || uploadMetadata?.status?.publishAt !== undefined) {
      throw new Error('Publish now still sent a stale scheduled publishAt value');
    }

    this.logger.info('Publishing safety test completed successfully');
    } finally {
      if (previousUploadFlag === undefined) delete process.env.YOUTUBE_UPLOAD_ENABLED;
      else process.env.YOUTUBE_UPLOAD_ENABLED = previousUploadFlag;
    }
  }
  async testCredentialValidation() {
    const { TEXT_PROVIDER_ENV_KEYS } = require('./utils/ai-text-service');
    const manager = new CredentialManager();

    // Isolate the test from any API keys set in the environment
    const envKeys = TEXT_PROVIDER_ENV_KEYS;
    const savedEnv = {};
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }

    try {
      manager.credentials = { youtube: { client_id: 'x' }, gemini: { apiKey: 'gm-test' } };
      if (manager.getMissingCredentials().length !== 0) {
        throw new Error('Gemini-only configuration was incorrectly reported as missing credentials');
      }

      manager.credentials = { youtube: { client_id: 'x' }, aiProvider: { provider: 'openrouter', apiKey: 'sk-or-test' } };
      if (manager.getMissingCredentials().length !== 0) {
        throw new Error('OpenRouter configuration was incorrectly reported as missing credentials');
      }

      manager.credentials = { youtube: { client_id: 'x' } };
      const missingProvider = manager.getMissingCredentials();
      if (missingProvider.length !== 1 || !/AI provider/.test(missingProvider[0])) {
        throw new Error('Missing AI provider was not detected');
      }

      manager.credentials = { openai: { apiKey: 'sk-test' } };
      const missingYouTube = manager.getMissingCredentials();
      if (missingYouTube.length !== 1 || missingYouTube[0] !== 'youtube') {
        throw new Error('Missing YouTube credentials were not detected');
      }
    } finally {
      for (const key of envKeys) {
        if (savedEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = savedEnv[key];
        }
      }
    }

    this.logger.info('Credential validation test completed successfully');
  }

  async testAITextServiceTokenParams() {
    const { AITextService, TEXT_PROVIDER_ENV_KEYS } = require('./utils/ai-text-service');

    // An empty response now moves on to any other configured provider, so every
    // provider key must be cleared or this test would call a live API.
    const savedEnv = Object.fromEntries(TEXT_PROVIDER_ENV_KEYS.map(key => [key, process.env[key]]));
    for (const key of TEXT_PROVIDER_ENV_KEYS) delete process.env[key];
    try {
      const service = new AITextService({
        aiProvider: { provider: 'openai', apiKey: 'test-key', model: 'gpt-5.6' }
      });

      // Newer OpenAI models (gpt-5.x) reject max_tokens — the request must use
      // max_completion_tokens, never the legacy spelling.
      const calls = [];
      service.client.chat.completions.create = async (params) => {
        calls.push(params);
        return { choices: [{ message: { content: '{"ok":true}' } }] };
      };

      const result = await service.generateText('test prompt', { maxTokens: 512 });
      if (result !== '{"ok":true}') throw new Error('generateText did not return the model content');
      if (calls[0].max_completion_tokens !== 512) {
        throw new Error('Modern models must receive max_completion_tokens, not max_tokens');
      }
      if (calls[0].max_tokens !== undefined) {
        throw new Error('Legacy max_tokens must not be sent to modern models');
      }
      if (calls[0].temperature !== undefined) {
        throw new Error('GPT-5.6 must use the provider default temperature');
      }

      // Legacy models reject max_completion_tokens with a 400 — the service must
      // retry the identical request using max_tokens.
      let attempt = 0;
      service.client.chat.completions.create = async (_params) => {
        attempt++;
        if (attempt === 1) {
          const err = new Error("Unsupported parameter: 'max_completion_tokens' is not supported with this model.");
          err.status = 400;
          throw err;
        }
        return { choices: [{ message: { content: 'legacy-ok' } }] };
      };
      const legacyResult = await service.generateText('legacy prompt');
      if (legacyResult !== 'legacy-ok') throw new Error('Legacy fallback did not return content');
      if (attempt !== 2) throw new Error('Expected exactly one retry with max_tokens');

      // An empty model body must surface as a descriptive error, not the cryptic
      // "Unexpected end of JSON input" the agents used to log.
      service.client.chat.completions.create = async () => ({ choices: [{ message: { content: '' } }] });
      let emptyRejected = false;
      try {
        await service.generateText('empty prompt');
      } catch (error) {
        emptyRejected = /empty response/i.test(error.message);
      }
      if (!emptyRejected) {
        throw new Error('Empty response was not rejected with a descriptive error');
      }

      // Gemini 3.5+ rejects/deprecates sampling parameters. Keep the latest
      // Gemini default on the parameter-safe request path.
      const geminiCalls = [];
      const geminiService = Object.create(AITextService.prototype);
      geminiService.gemini = {
        models: {
          generateContent: async (params) => {
            geminiCalls.push(params);
            return { text: 'gemini-ok' };
          }
        }
      };
      geminiService.client = null;
      geminiService.model = 'gemini-3.7-flash';
      geminiService.providerName = 'Google Gemini';

      const geminiResult = await geminiService.generateText('gemini prompt', { temperature: 0.2 });
      if (geminiResult !== 'gemini-ok') throw new Error('Gemini generation did not return content');
      if (geminiCalls[0].config.temperature !== undefined) {
        throw new Error('Gemini 3.7 must not receive the deprecated temperature parameter');
      }
    } finally {
      for (const key of TEXT_PROVIDER_ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
    }

    this.logger.info('AI text service token parameter test completed successfully');
  }

  async testAITextProviderFailover() {
    const { AITextService, TEXT_PROVIDER_ENV_KEYS } = require('./utils/ai-text-service');
    const envKeys = TEXT_PROVIDER_ENV_KEYS;
    const saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
    for (const key of envKeys) delete process.env[key];

    try {
      const service = new AITextService({});
      const transient = new Error('model is currently experiencing high demand');
      transient.status = 503;
      service.client = {
        chat: {
          completions: {
            create: async () => { throw transient; }
          }
        }
      };
      service.model = 'primary-model';
      service.providerName = 'Primary Mock';
      service.fallbacks = [{
        type: 'openai-compatible',
        name: 'OpenRouter',
        model: 'fallback-model',
        client: {
          chat: {
            completions: {
              create: async () => ({ choices: [{ message: { content: 'FALLBACK_OK' } }] })
            }
          }
        }
      }];

      const response = await service.generateText('test', { maxTokens: 20, temperature: 0 });
      if (response !== 'FALLBACK_OK') throw new Error('Transient primary failure did not route to the fallback provider');

      const authError = new Error('unauthorized');
      authError.status = 401;
      if (service.shouldFallback(authError)) throw new Error('Authentication failures must not silently fail over');
    } finally {
      for (const key of envKeys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  }

  // Runs fn with every text-provider env var cleared and only `overrides` set.
  async withTextProviderEnv(overrides, fn) {
    const { TEXT_PROVIDER_ENV_KEYS } = require('./utils/ai-text-service');
    const keys = [
      ...TEXT_PROVIDER_ENV_KEYS,
      'FREE_LLM_ONLY', 'FREE_LLM_PROVIDER_ORDER', 'FREE_LLM_DISABLE', 'FREE_LLM_TIMEOUT_MS',
      'MISTRAL_MODEL_QUALITY', 'MISTRAL_MODEL_BALANCED', 'MISTRAL_MODEL_FAST', 'GEMINI_TEXT_MODEL'
    ];
    const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, overrides);
    try {
      return await fn();
    } finally {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  }

  async testFreeLLMCatalogIntegrity() {
    const fs = require('fs').promises;
    const path = require('path');
    const catalog = require('./utils/free-llm-catalog');
    const { FREE_PROVIDERS, BLOCKED_MODELS, TIERS } = catalog;

    for (const id of ['groq', 'nvidia', 'mistral', 'openrouter']) {
      if (!FREE_PROVIDERS[id]) throw new Error(`Free catalog is missing provider "${id}"`);
    }
    if (FREE_PROVIDERS.gemini) throw new Error('Gemini must stay on the native path, not in the free catalog');

    for (const retiredNvidia of ['openai/gpt-oss-120b', 'minimaxai/minimax-m3']) {
      if (!(BLOCKED_MODELS.nvidia || []).includes(retiredNvidia)) throw new Error(`Retired NVIDIA model ${retiredNvidia} is not blocklisted`);
    }
    for (const retired of ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant']) {
      if (!BLOCKED_MODELS.groq.includes(retired)) throw new Error(`Retired Groq model ${retired} is not blocklisted`);
    }

    for (const [id, provider] of Object.entries(FREE_PROVIDERS)) {
      if (!/^https:\/\//.test(provider.baseURL) || !/^[A-Z_]+_API_KEY$/.test(provider.envKey)) {
        throw new Error(`Free provider "${id}" has an invalid baseURL or envKey`);
      }
      if (!['max_tokens', 'max_completion_tokens'].includes(provider.tokenParam)) {
        throw new Error(`Free provider "${id}" has no valid token parameter`);
      }
      for (const tier of TIERS) {
        const models = provider.tiers[tier];
        if (!Array.isArray(models) || !models.length) throw new Error(`Free provider "${id}" has no ${tier} models`);
        for (const model of models) {
          if ((BLOCKED_MODELS[id] || []).includes(model.id)) throw new Error(`Blocked model ${model.id} is listed under ${id}`);
          if (id === 'openrouter' && !model.id.endsWith(':free')) {
            throw new Error(`OpenRouter model ${model.id} is not a ":free" model`);
          }
          if (model.maxOutput !== null && !(model.maxOutput > 0)) {
            throw new Error(`Model ${model.id} has an invalid maxOutput`);
          }
        }
      }
    }
    if (FREE_PROVIDERS.groq.tokenParam !== 'max_completion_tokens') throw new Error('Groq must use max_completion_tokens');
    for (const id of ['mistral', 'nvidia', 'openrouter']) {
      if (FREE_PROVIDERS[id].tokenParam !== 'max_tokens') throw new Error(`${id} must use max_tokens`);
    }
    if (FREE_PROVIDERS.groq.dataPolicy !== 'unspecified' ||
      FREE_PROVIDERS.nvidia.dataPolicy !== 'logged/trial-only' ||
      FREE_PROVIDERS.mistral.dataPolicy !== 'may-train/log' ||
      FREE_PROVIDERS.openrouter.dataPolicy !== 'may-train/log') {
      throw new Error('Free provider data policies drifted from the documented conditions');
    }

    const source = await fs.readFile(path.join(__dirname, 'utils', 'free-llm-catalog.js'), 'utf8');
    if (/(sk-[A-Za-z0-9_-]{12,}|gsk_[A-Za-z0-9]{12,}|nvapi-[A-Za-z0-9_-]{12,}|apiKey\s*:|Bearer\s+[A-Za-z0-9])/.test(source)) {
      throw new Error('Free LLM catalog must not contain API keys');
    }

    const tiers = { script: 'quality', ideation: 'quality', packaging: 'balanced', 'comment-analysis': 'balanced', 'reply-draft': 'balanced', probe: 'fast' };
    for (const [task, tier] of Object.entries(tiers)) {
      if (catalog.tierForTask(task) !== tier) throw new Error(`Task "${task}" is not routed to the ${tier} tier`);
    }

    // A model whose documented output cap is below the request is skipped.
    const small = catalog.getCandidates({ task: 'packaging', maxTokens: 1200, providerIds: ['nvidia'], env: {} });
    const large = catalog.getCandidates({ task: 'packaging', maxTokens: 140000, providerIds: ['nvidia'], env: {} });
    if (!small.some(item => item.model === 'openai/gpt-oss-20b') || large.some(item => item.model === 'openai/gpt-oss-20b')) {
      throw new Error('maxOutput is not enforced against the requested maxTokens');
    }

    // Env overrides are honoured for Mistral but can never bypass the guards.
    const mistral = catalog.getTierModels('mistral', 'fast', { MISTRAL_MODEL_FAST: 'custom-a, custom-b' });
    if (mistral.map(item => item.id).join() !== 'custom-a,custom-b') throw new Error('Mistral model ids are not configurable via env');
    if (catalog.isModelAllowed('groq', 'llama-3.3-70b-versatile') || catalog.isModelAllowed('openrouter', 'openai/gpt-5.6-sol') || catalog.isModelAllowed('openrouter', 'openrouter/free')) {
      throw new Error('Blocked or paid model ids pass the catalog guard');
    }

    if (catalog.getProviderOrder({}).join() !== 'groq,nvidia,mistral,openrouter') throw new Error('Default free provider order changed');
    if (catalog.getProviderOrder({ FREE_LLM_PROVIDER_ORDER: 'mistral,bogus,groq', FREE_LLM_DISABLE: 'groq' }).join() !== 'mistral') {
      throw new Error('FREE_LLM_PROVIDER_ORDER / FREE_LLM_DISABLE are not applied');
    }

    this.logger.info('Free LLM catalog integrity test completed successfully');
  }

  async testLLMCooldownTracker() {
    const { CooldownTracker } = require('./utils/llm-cooldown');
    // 2026-10-01T10:00:00Z: 14h before UTC midnight, so the daily cap of 6h applies.
    let now = Date.UTC(2026, 9, 1, 10, 0, 0);
    const tracker = new CooldownTracker({ now: () => now });
    const fail = (status, message, headers) => Object.assign(new Error(message || `HTTP ${status}`), { status, headers });

    const retry = tracker.recordFailure('groq', 'm1', fail(429, 'rate limit', { 'Retry-After': '30' }));
    if (retry.ms !== 30000 || tracker.isAvailable('groq', 'm1')) throw new Error('Retry-After was not applied as the cooldown');
    if (!tracker.isAvailable('groq', 'm2')) throw new Error('Cooldown must be scoped to provider:model');
    now += 30001;
    if (!tracker.isAvailable('groq', 'm1')) throw new Error('Cooldown did not expire after Retry-After');

    const headerObject = tracker.recordFailure('groq', 'm1', fail(429, 'rate limit', { get: name => (name === 'retry-after' ? '7' : null) }));
    if (headerObject.ms !== 7000) throw new Error('Retry-After was not read from a Headers object');

    const daily = tracker.recordFailure('openrouter', 'x:free', fail(429, 'Rate limit exceeded: free-models-per-day'));
    if (daily.action !== 'daily-quota' || daily.ms !== 6 * 60 * 60 * 1000) throw new Error('Daily quota cooldown is not capped at 6h');
    now = Date.UTC(2026, 9, 1, 23, 0, 0);
    const lateDaily = tracker.recordFailure('openrouter', 'y:free', fail(429, 'requests per day limit reached'));
    if (lateDaily.ms !== 60 * 60 * 1000) throw new Error('Daily quota cooldown must end at UTC midnight when that is sooner');
    if (tracker.recordFailure('groq', 'm3', fail(429, 'slow down')).ms !== 60000) throw new Error('Plain 429 must use the default cooldown');

    const steps = [1, 2, 3, 4].map(() => tracker.recordFailure('nvidia', 'm', fail(503, 'upstream error')).ms);
    if (steps.join() !== '20000,60000,300000,300000') throw new Error(`Transient backoff is ${steps.join()}`);
    const timeout = tracker.recordFailure('mistral', 'm', Object.assign(new Error('Request timed out.'), { code: 'ETIMEDOUT' }));
    if (timeout.action !== 'transient' || timeout.ms !== 20000) throw new Error('Timeouts must use the transient backoff');
    tracker.recordSuccess('nvidia', 'm');
    if (!tracker.isAvailable('nvidia', 'm') || tracker.recordFailure('nvidia', 'm', fail(500)).ms !== 20000) {
      throw new Error('A success must reset the transient backoff');
    }

    if (tracker.recordFailure('mistral', 'gone', fail(404, 'model not found')).action !== 'model-disabled' || tracker.isAvailable('mistral', 'gone')) {
      throw new Error('A 404 must disable the model');
    }
    if (!tracker.isAvailable('mistral', 'other')) throw new Error('A 404 must not disable the whole provider');

    if (tracker.recordFailure('groq', 'm9', fail(401, 'bad key'), { isPrimary: true }).action !== 'auth-error' || !tracker.isAvailable('groq', 'm9')) {
      throw new Error('A primary auth failure must be reported, not silently disabled');
    }
    if (tracker.recordFailure('openrouter', 'z:free', fail(403, 'forbidden')).action !== 'provider-disabled' || tracker.isAvailable('openrouter', 'other:free')) {
      throw new Error('A 401/403 on a fallback provider must disable that provider');
    }
    if (tracker.recordFailure('groq', 'm4', fail(400, 'bad request')).action !== 'none' || !tracker.isAvailable('groq', 'm4')) {
      throw new Error('A 400 must not start a cooldown');
    }

    this.logger.info('LLM cooldown tracker test completed successfully');
  }

  async testFreeLLMSensitiveRouting() {
    const { AITextService } = require('./utils/ai-text-service');
    const catalog = require('./utils/free-llm-catalog');
    const all = ['nvidia', 'mistral', 'openrouter', 'groq'];

    for (const task of ['comment-analysis', 'reply-draft']) {
      const providers = [...new Set(catalog.getCandidates({ task, providerIds: all, env: {} }).map(item => item.providerId))];
      if (providers.join() !== 'groq') throw new Error(`Task "${task}" can reach ${providers.join()} with viewer comments`);
    }
    const open = new Set(catalog.getCandidates({ task: 'script', providerIds: all, env: {} }).map(item => item.providerId));
    if (open.size !== 4) throw new Error('Non-sensitive tasks must be able to use every free provider');

    const ok = text => async () => ({ choices: [{ message: { content: text } }] });
    const stub = (service, calls) => {
      for (const id of Object.keys(service.freeClients)) {
        service.freeClients[id] = { chat: { completions: { create: async params => { calls.push(id); return ok(`from-${id}`)(params); } } } };
      }
      if (service.freePrimaryId) service.client = service.freeClients[service.freePrimaryId];
    };

    await this.withTextProviderEnv({
      NVIDIA_API_KEY: 'test-nvidia', MISTRAL_API_KEY: 'test-mistral', OPENROUTER_API_KEY: 'test-openrouter', GROQ_API_KEY: 'test-groq',
      FREE_LLM_PROVIDER_ORDER: 'nvidia,mistral,openrouter,groq'
    }, async () => {
      const service = new AITextService({});
      const calls = [];
      stub(service, calls);
      if (await service.generateText('viewer comments', { task: 'reply-draft' }) !== 'from-groq' || calls.join() !== 'groq') {
        throw new Error(`Viewer comments were routed to ${calls.join()}`);
      }
      calls.length = 0;
      if (await service.generateText('script', { task: 'script' }) !== 'from-nvidia') throw new Error('Non-sensitive task ignored the provider order');
    });

    await this.withTextProviderEnv({ NVIDIA_API_KEY: 'test-nvidia', OPENROUTER_API_KEY: 'test-openrouter' }, async () => {
      const service = new AITextService({});
      const calls = [];
      stub(service, calls);
      let rejected = false;
      try {
        await service.generateText('viewer comments', { task: 'comment-analysis' });
      } catch (error) {
        rejected = /viewer comments/.test(error.message);
      }
      if (!rejected || calls.length) throw new Error('Viewer comments must not reach a logging/training free provider');
    });

    this.logger.info('Free LLM sensitive routing test completed successfully');
  }

  async testFreeOnlyPrimarySelection() {
    const { AITextService } = require('./utils/ai-text-service');
    const reply = content => ({ choices: [{ message: { content } }] });

    // Free-only is the default: a paid env key is ignored and never becomes primary.
    await this.withTextProviderEnv({ OPENAI_API_KEY: 'test-paid', OPENROUTER_API_KEY: 'test-openrouter', GROQ_API_KEY: 'test-groq' }, async () => {
      const service = new AITextService({});
      if (service.providerName !== 'Groq' || service.freePrimaryId !== 'groq') throw new Error(`Free-only primary is ${service.providerName}`);
      if (service.ignoredPaidEnvKeys.join() !== 'OPENAI_API_KEY') throw new Error('Ignored paid key was not recorded for the warning');
      if (service.fallbacks.some(item => item.name === 'OpenRouter')) throw new Error('Paid OpenRouter fallback was added in free-only mode');

      const chain = service.describeChain();
      const serialized = JSON.stringify(chain);
      if (/test-paid|test-openrouter|test-groq/.test(serialized)) throw new Error('describeChain leaked a secret');
      for (const [task, entry] of Object.entries(chain.tasks)) {
        if (!entry.chain.length) throw new Error(`describeChain has no chain for ${task}`);
        if (entry.chain.some(item => /OpenRouter/.test(item.provider) && !item.model.endsWith(':free'))) {
          throw new Error('A paid OpenRouter model is in the free-only chain');
        }
      }
      if (chain.tasks['reply-draft'].chain.some(item => item.provider !== 'Groq')) throw new Error('describeChain shows a sensitive task leaving Groq');

      // Per-model failover with Retry-After, reasoning headroom, and <think> stripping.
      const calls = [];
      service.client.chat.completions.create = async params => {
        calls.push(params);
        if (params.model === 'openai/gpt-oss-120b') {
          throw Object.assign(new Error('Rate limit reached'), { status: 429, headers: { 'retry-after': '120' } });
        }
        return reply('<think>plan</think>\n{"ok":true}');
      };
      const first = await service.generateText('write', { task: 'script', maxTokens: 2200 });
      if (first !== '{"ok":true}') throw new Error('<think> block was not stripped from a free provider response');
      if (calls.map(item => item.model).join() !== 'openai/gpt-oss-120b,qwen/qwen3.8-27b') throw new Error(`Unexpected model order: ${calls.map(item => item.model).join()}`);
      if (calls[1].max_completion_tokens !== 2200 + 2048 || calls[1].max_tokens !== undefined) {
        throw new Error('Groq reasoning models must get max_completion_tokens with headroom');
      }
      calls.length = 0;
      await service.generateText('write', { task: 'script', maxTokens: 2200 });
      if (calls.length !== 1 || calls[0].model !== 'qwen/qwen3.8-27b') throw new Error('A cooling model was retried before its Retry-After elapsed');

      // OpenRouter free fallback uses max_tokens and only ":free" ids.
      const openRouterCalls = [];
      service.client.chat.completions.create = async () => { throw Object.assign(new Error('unavailable'), { status: 503 }); };
      service.freeClients.openrouter = { chat: { completions: { create: async params => { openRouterCalls.push(params); return reply('PACKAGED'); } } } };
      if (await service.generateText('package', { task: 'packaging', maxTokens: 1200 }) !== 'PACKAGED') throw new Error('Free primary did not fail over to OpenRouter free');
      if (!openRouterCalls[0].model.endsWith(':free') || openRouterCalls[0].max_tokens !== 1200 || openRouterCalls[0].max_completion_tokens !== undefined) {
        throw new Error('OpenRouter free must receive a ":free" model with max_tokens');
      }
    });

    // A rejected key on the primary must surface, never fail over silently.
    await this.withTextProviderEnv({ GROQ_API_KEY: 'test-groq', MISTRAL_API_KEY: 'test-mistral' }, async () => {
      const service = new AITextService({});
      let mistralCalls = 0;
      service.client.chat.completions.create = async () => { throw Object.assign(new Error('Invalid API Key'), { status: 401 }); };
      service.freeClients.mistral = { chat: { completions: { create: async () => { mistralCalls += 1; return reply('LEAK'); } } } };
      let status = 0;
      try {
        await service.generateText('probe', { task: 'probe' });
      } catch (error) {
        status = error.status;
      }
      if (status !== 401 || mistralCalls) throw new Error('A 401 on the primary provider silently failed over');
    });

    // A rejected key on a fallback provider disables it and the chain continues.
    await this.withTextProviderEnv({ GROQ_API_KEY: 'test-groq', MISTRAL_API_KEY: 'test-mistral', OPENROUTER_API_KEY: 'test-openrouter', FREE_LLM_DISABLE: 'nvidia' }, async () => {
      const service = new AITextService({});
      let mistralCalls = 0;
      service.client.chat.completions.create = async () => { throw Object.assign(new Error('unavailable'), { status: 503 }); };
      service.freeClients.mistral = { chat: { completions: { create: async params => {
        mistralCalls += 1;
        if (params.max_tokens === undefined || params.max_completion_tokens !== undefined) throw new Error('Mistral must receive max_tokens only');
        throw Object.assign(new Error('Unauthorized'), { status: 401 });
      } } } };
      service.freeClients.openrouter = { chat: { completions: { create: async () => reply('READY') } } };
      if (await service.generateText('probe', { task: 'probe' }) !== 'READY') throw new Error('Chain did not continue past a rejected fallback key');
      if (mistralCalls !== 1 || service.cooldowns.isAvailable('mistral', 'mistral-small-latest')) throw new Error('Rejected fallback provider was not disabled');
    });

    // Gemini stays ahead of the free providers; paid env discovery needs FREE_LLM_ONLY=false.
    await this.withTextProviderEnv({ GEMINI_API_KEY: 'test-gemini', GROQ_API_KEY: 'test-groq', OPENAI_API_KEY: 'test-paid' }, async () => {
      const service = new AITextService({});
      if (service.providerName !== 'Google Gemini' || service.freePrimaryId) throw new Error('Gemini must be primary ahead of free providers');
      if (service.freeProviders.join() !== 'groq') throw new Error('Free providers were not registered as fallbacks behind Gemini');
    });
    await this.withTextProviderEnv({ FREE_LLM_ONLY: 'false', OPENAI_API_KEY: 'test-paid', OPENROUTER_API_KEY: 'test-openrouter', GROQ_API_KEY: 'test-groq' }, async () => {
      const service = new AITextService({});
      if (service.providerName !== 'OpenAI') throw new Error('FREE_LLM_ONLY=false must restore paid env discovery');
      if (!service.fallbacks.some(item => item.name === 'OpenRouter')) throw new Error('FREE_LLM_ONLY=false must restore the OpenRouter fallback');
    });

    // An explicit aiProvider is honoured in free-only mode and uses this.client.
    await this.withTextProviderEnv({ GROQ_API_KEY: 'test-groq' }, async () => {
      const service = new AITextService({ aiProvider: { provider: 'openai', apiKey: 'test-key', model: 'gpt-5.6' } });
      if (service.providerName !== 'OpenAI' || service.model !== 'gpt-5.6' || service.freePrimaryId) {
        throw new Error('Explicit aiProvider openai was not honoured in free-only mode');
      }
      const calls = [];
      service.client.chat.completions.create = async params => { calls.push(params); return reply('EXPLICIT_OK'); };
      let groqCalls = 0;
      service.freeClients.groq = { chat: { completions: { create: async () => { groqCalls += 1; return reply('GROQ_OK'); } } } };
      if (await service.generateText('write', { task: 'script', maxTokens: 300 }) !== 'EXPLICIT_OK') throw new Error('Explicit openai primary did not answer');
      if (calls[0].model !== 'gpt-5.6' || calls[0].max_completion_tokens !== 300 || groqCalls) throw new Error('Explicit openai primary was bypassed');

      // An empty primary response moves on only because a fallback exists.
      service.client.chat.completions.create = async () => reply('');
      if (await service.generateText('write', { task: 'script' }) !== 'GROQ_OK') throw new Error('Empty primary response did not move to the next provider');
      const empty = Object.assign(new Error('empty'), { code: 'AI_EMPTY_RESPONSE' });
      if (service.shouldFallback(empty)) throw new Error('shouldFallback() must keep rejecting empty responses');

      // A 401 on the explicit primary still surfaces.
      service.client.chat.completions.create = async () => { throw Object.assign(new Error('unauthorized'), { status: 401 }); };
      groqCalls = 0;
      let status = 0;
      try {
        await service.generateText('write', { task: 'script' });
      } catch (error) {
        status = error.status;
      }
      if (status !== 401 || groqCalls) throw new Error('A 401 on the explicit primary silently failed over');
    });

    // Prototype-only instances (no constructor) must stay safe and inert.
    const bare = Object.create(AITextService.prototype);
    if (bare.isAvailable() || bare.describeChain().freeProviders.length) throw new Error('A bare instance must not look configured');

    this.logger.info('Free-only text provider selection test completed successfully');
  }

  async testEvidenceAwareVisualHandoff() {
    const ScriptWriterAgent = require('./agents/script-writer-agent').ScriptWriterAgent;

    const writer = Object.create(ScriptWriterAgent.prototype);
    const sections = writer.normalizeAISections([{
      title: 'Pressure chamber',
      content: ['A large underground chamber slows floodwater before pumping.'],
      duration: 60,
      visualQuery: 'underground flood pressure chamber concrete pillars',
      visualRequiredAny: ['underground', 'concrete', 'pillar'],
      visualForbiddenAny: ['subway', 'train']
    }], { topic: 'Flood defense system' });

    if (sections[0].visualQuery !== 'underground flood pressure chamber concrete pillars') {
      throw new Error('Script agent visualQuery was not preserved');
    }
  }

  async testAgentCommunicationContracts() {
    const { AgentContractService } = require('./utils/agent-contract-service');
    const contracts = new AgentContractService();

    contracts.validateAgentRegistry({
      strategy: { generateContentStrategy() {} },
      scriptWriter: { generateScript() {} },
      thumbnailDesigner: { generateThumbnail() {} },
      seoOptimizer: { optimize() {} },
      production: { processContent() {} },
      publishing: { scheduleContent() {} },
      analytics: { getRecentAnalytics() {} }
    });

    const strategy = contracts.handoff('strategy', {
      topic: 'A real engineering system',
      contentType: 'Explainer',
      angle: 'How the physical mechanism solves the constraint.',
      researchSources: [{
        url: 'https://example.test/source',
        title: 'Source',
        status: 'verified'
      }],
      researchContext: [{
        url: 'https://example.test/source',
        excerpt: 'Evidence'
      }]
    }, { productionMode: true });

    const script = contracts.handoff('script', {
      title: 'How the System Works',
      hook: { text: 'A visible result hides a larger mechanism.' },
      mainContent: {
        sections: [{
          title: 'The mechanism',
          content: ['The mechanism redirects water through a concrete chamber.'],
          duration: 60,
          visualQuery: 'concrete water chamber infrastructure',
          visualRequiredAny: ['concrete', 'water'],
          visualForbiddenAny: ['subway']
        }]
      },
      claims: [],
      metadata: {
        generationSource: 'ai',
        strategy
      }
    }, { strategy });

    contracts.handoff('thumbnail', {
      path: 'data/assets/thumb.jpg',
      fileSize: 1000
    }, { strategy, script });

    contracts.handoff('seo', {
      title: 'How the System Works',
      description: 'A detailed documentary description of the system.',
      tags: ['engineering', 'infrastructure']
    }, { strategy, script });

    contracts.handoff('production', {
      id: 'prod-contract-test',
      strategy,
      script,
      assets: {
        video: {
          scenePlan: [{
            index: 0,
            label: 'The mechanism',
            narration: 'The mechanism redirects water through a concrete chamber.',
            assetPath: 'data/videos/scene.mp4',
            simulated: false
          }]
        },
        audio: { path: 'data/audio/narration.mp3', simulated: false },
        finalVideo: { path: 'data/videos/final.mp4', simulated: false }
      }
    }, { strategy, script });

    let missingResearchBlocked = false;
    try {
      contracts.handoff('strategy', {
        topic: 'Unresearched story',
        contentType: 'Explainer',
        angle: 'An angle',
        researchSources: [],
        researchContext: []
      }, { productionMode: true });
    } catch (error) {
      missingResearchBlocked = error.code === 'AGENT_CONTRACT_VIOLATION';
    }
    if (!missingResearchBlocked) throw new Error('Production strategy without research was not blocked');

    let unverifiedResearchBlocked = false;
    try {
      contracts.handoff('strategy', {
        topic: 'Story with an unverified trend lead',
        contentType: 'Story',
        angle: 'An angle',
        researchSources: [{
          url: 'https://example.test/trend-lead',
          title: 'Unverified trend lead'
        }],
        researchContext: []
      }, { productionMode: true });
    } catch (error) {
      unverifiedResearchBlocked = error.code === 'AGENT_CONTRACT_VIOLATION';
    }
    if (!unverifiedResearchBlocked) {
      throw new Error('Production strategy accepted an unverified trend lead as research evidence');
    }

    let driftBlocked = false;
    try {
      contracts.handoff('production', {
        id: 'prod-drift',
        strategy: { ...strategy, topic: 'Different topic' },
        script,
        assets: {
          video: { scenePlan: [{ index: 0, label: 'Scene', narration: 'Narration' }] },
          audio: {},
          finalVideo: {}
        }
      }, { strategy, script });
    } catch (error) {
      driftBlocked = error.code === 'AGENT_CONTRACT_VIOLATION';
    }
    if (!driftBlocked) throw new Error('Cross-agent topic drift was not blocked');

    const { YouTubeAutomationAgent } = require('./index');
    const validation = YouTubeAutomationAgent.prototype.validateGenerateRequestBody.call({}, {
      topic: 'Research handoff test',
      style: 'explainer',
      length: 'medium',
      strategyContext: {
        angle: 'Test angle',
        researchSources: [{
          url: 'https://example.test/evidence',
          title: 'Evidence title',
          publisher: 'Evidence publisher',
          sourceType: 'article'
        }]
      }
    });
    if (!validation.valid || validation.value.strategyContext.researchSources?.[0]?.url !== 'https://example.test/evidence') {
      throw new Error('Generation request validation dropped the autonomous research-source handoff');
    }
  }

  async testPlaceholderSchedulingGuard() {
    const { PublishingSchedulingAgent } = require('./agents/publishing-scheduling-agent');
    const agent = new PublishingSchedulingAgent({
      saveScheduleEntry: async () => {}
    }, {});

    const simulated = await agent.scheduleContent({
      id: 'prod-simulated',
      script: { title: 'Simulated' },
      assets: { finalVideo: { path: 'video.mp4.assembly.json', simulated: true } }
    });
    if (simulated !== null) {
      throw new Error('Simulated production was scheduled for publishing');
    }

    const missingVideo = await agent.scheduleContent({
      id: 'prod-missing',
      script: { title: 'Missing' },
      assets: {}
    });
    if (missingVideo !== null) {
      throw new Error('Production without a final video was scheduled for publishing');
    }

    const missingNarration = await agent.scheduleContent({
      id: 'prod-no-narration', script: { title: 'No narration' }, priority: 50,
      scheduledPublishTime: new Date().toISOString(),
      assets: { finalVideo: { path: 'video.mp4' } }, seo: {}
    });
    if (missingNarration !== null) throw new Error('Production without narration was scheduled for publishing');

    const real = await agent.scheduleContent({
      id: 'prod-real',
      script: { title: 'Real' },
      priority: 50,
      scheduledPublishTime: new Date().toISOString(),
      assets: {
        finalVideo: { path: 'video.mp4' }, thumbnail: {}, captions: {},
        audio: {
          intentionalSilence: true,
          silenceReason: 'This fixture intentionally uses a silent timeline.',
          silenceConfirmedAt: new Date().toISOString()
        }
      },
      seo: {}
    });
    if (!real || agent.publishQueue.length !== 1) {
      throw new Error('Real production was not scheduled for publishing');
    }

    this.logger.info('Placeholder scheduling guard test completed successfully');
  }

  async testFFmpegResolution() {
    const fs = require('fs').promises;
    const os = require('os');
    const { getFFmpegPath, getMediaDuration, checkFFmpeg, runFFmpeg, ffmpegInstallHint } = require('./utils/ffmpeg');

    const ffmpegPath = getFFmpegPath();
    if (typeof ffmpegPath !== 'string' || ffmpegPath.length === 0) {
      throw new Error('getFFmpegPath did not return a usable path');
    }

    const available = await checkFFmpeg();
    if (typeof available !== 'boolean') {
      throw new Error('checkFFmpeg did not return a boolean');
    }

    if (!/FFmpeg/i.test(ffmpegInstallHint())) {
      throw new Error('ffmpegInstallHint did not return install guidance');
    }

    if (available) {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-duration-'));
      try {
        const audioPath = path.join(directory, 'duration.m4a');
        await runFFmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac', audioPath]);
        const duration = await getMediaDuration(audioPath);
        if (duration < 0.9 || duration > 1.2) throw new Error(`Media duration probe returned ${duration}`);
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    }

    this.logger.info(`FFmpeg resolution test completed (binary: ${ffmpegPath}, available: ${available})`);
  }

  async testGeminiMediaProvider() {
    const { AIVideoGenerator } = require('./utils/ai-video-generator');
    const fs = require('fs').promises;
    const os = require('os');
    const sharp = require('sharp');

    const envKeys = ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'REPLICATE_API_KEY', 'ELEVENLABS_API_KEY'];
    const savedEnv = {};
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-gemini-image-'));
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }

    try {
      const previousFreeOnly = process.env.FREE_MEDIA_ONLY;
      process.env.FREE_MEDIA_ONLY = 'true';
      const freeOnly = new AIVideoGenerator({
        openai: { apiKey: 'paid-openai' }, elevenLabs: { apiKey: 'paid-eleven', voiceId: 'v' },
        replicate: { apiKey: 'paid-replicate' }, gemini: { apiKey: 'free-gemini' }
      });
      if (previousFreeOnly === undefined) delete process.env.FREE_MEDIA_ONLY; else process.env.FREE_MEDIA_ONLY = previousFreeOnly;
      if (freeOnly.openai || freeOnly.replicate || freeOnly.elevenLabsApiKey || !freeOnly.gemini) {
        throw new Error('FREE_MEDIA_ONLY did not keep paid media providers out of narration, images and video');
      }
      const geminiOnly = new AIVideoGenerator({ gemini: { apiKey: 'test-key' } });
      if (!geminiOnly.gemini) {
        throw new Error('Gemini media service was not initialized from gemini credentials');
      }
      if (geminiOnly.openai) {
        throw new Error('OpenAI client initialized without a key');
      }

      const thoughtImage = await sharp({
        create: { width: 64, height: 64, channels: 3, background: '#ff0000' }
      }).jpeg().toBuffer();
      const finalImage = await sharp({
        create: { width: 180, height: 320, channels: 3, background: '#0066ff' }
      }).webp().toBuffer();
      let imageRequest = null;
      geminiOnly.gemini.models.generateContent = async request => {
        imageRequest = request;
        return {
          candidates: [{
            content: {
              parts: [
                { thought: true, inlineData: { mimeType: 'image/jpeg', data: thoughtImage.toString('base64') } },
                { text: 'Rendering the final image.' },
                { inlineData: { mimeType: 'image/webp', data: finalImage.toString('base64') } }
              ]
            }
          }]
        };
      };

      const outputPath = path.join(directory, 'gemini-output.png');
      await geminiOnly.generateGeminiImage('Create a blue vertical Dark Stickman test image', outputPath);
      const metadata = await sharp(outputPath).metadata();
      if (metadata.format !== 'png' || metadata.width !== 180 || metadata.height !== 320) {
        throw new Error('Gemini final image was not selected and normalized to the requested file format');
      }
      if (
        imageRequest?.config?.responseModalities?.[0] !== 'IMAGE' ||
        imageRequest?.config?.imageConfig?.aspectRatio !== '9:16'
      ) {
        throw new Error('Gemini image request did not require the vertical Shorts image response');
      }

      const none = new AIVideoGenerator({});
      if (none.gemini || none.openai) {
        throw new Error('External media services initialized without any credentials');
      }
      const localPath = path.join(directory, 'local-stickman.png');
      await none.generateImage(
        'minimal dark stickman psychological horror, figure beside a locked door holding a phone, vertical 9:16, no text, no gore',
        localPath
      );
      const localMetadata = await sharp(localPath).metadata();
      if (
        localMetadata.width !== 1080 ||
        localMetadata.height !== 1920 ||
        none.lastImageResult?.provider !== 'local-stickman' ||
        none.lastImageResult?.simulated === true
      ) {
        throw new Error('Built-in Dark Stickman renderer did not produce a real 1080x1920 production asset');
      }
    } finally {
      for (const key of envKeys) {
        if (savedEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = savedEnv[key];
        }
      }
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    }

    this.logger.info('Gemini media provider selection test completed successfully');
  }

  async testSlideshowRenderer() {
    const { AIVideoGenerator } = require('./utils/ai-video-generator');
    const { ProductionManagementAgent } = require('./agents/production-management-agent');
    const { checkFFmpeg } = require('./utils/ffmpeg');
    const fs = require('fs').promises;
    const os = require('os');
    const { runFFmpeg, getMediaDuration } = require('./utils/ffmpeg');

    if (!(await checkFFmpeg())) {
      this.logger.warn('FFmpeg unavailable — skipping slideshow renderer test');
      return;
    }

    const sharp = require('sharp');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-slides-'));

    try {
      const stills = [];
      for (let i = 0; i < 3; i++) {
        const stillPath = path.join(dir, `slide_${i}.png`);
        await sharp({
          create: { width: 320, height: 180, channels: 3, background: { r: 60 * i, g: 80, b: 160 } }
        }).png().toFile(stillPath);
        stills.push(stillPath);
      }

      const generator = new AIVideoGenerator({});
      if (generator.parseDurationSeconds('2:05') !== 125 || generator.parseDurationSeconds('1:02:03') !== 3723) {
        throw new Error('Human-readable production durations are not converted to timeline seconds');
      }

      const embeddedAssets = await generator.filterImageAssets(stills);
      if (embeddedAssets.length !== stills.length || embeddedAssets.some(asset => !asset.startsWith('data:image/png;base64,'))) {
        throw new Error('Slideshow image assets were not embedded as browser-safe image data');
      }
      const { chromium } = require('playwright');
      let browser = null;
      try {
        browser = await chromium.launch();
      } catch (error) {
        if (!/Executable doesn't exist|playwright install/i.test(error.message)) throw error;
        this.logger.warn('Chromium is not installed — verified browser-safe image embedding without the live browser assertion');
      }
      if (browser) {
        try {
          const page = await browser.newPage();
          await page.setContent(generator.createSlideshowHTML({ title: 'Image loading test' }, embeddedAssets));
          const imageState = await page.$$eval('.background-image', images => images.map(image => ({
            complete: image.complete,
            width: image.naturalWidth,
            height: image.naturalHeight
          })));
          if (!imageState.length || imageState.some(image => !image.complete || !image.width || !image.height)) {
            throw new Error('Embedded slideshow images did not load in Chromium');
          }
        } finally {
          await browser.close();
        }
      }

      const videoPath = path.join(dir, 'out.mp4');
      await generator.renderSlidesToVideo(stills, 6, videoPath);

      const stats = await fs.stat(videoPath);
      if (!stats.size) {
        throw new Error('Rendered slideshow video is empty');
      }

      // Missing narration must fail closed unless the operator explicitly confirmed silence.
      const finalPath = path.join(dir, 'final.mp4');
      let missingNarrationBlocked = false;
      try {
        await generator.addAudioToVideo(videoPath, path.join(dir, 'missing.mp3'), finalPath);
      } catch (error) {
        missingNarrationBlocked = error.code === 'NARRATION_REQUIRED';
      }
      if (!missingNarrationBlocked) throw new Error('Missing narration silently produced a final video');
      await generator.addAudioToVideo(videoPath, path.join(dir, 'missing.mp3'), finalPath, { allowSilent: true });
      const finalStats = await fs.stat(finalPath);
      if (!finalStats.size) {
        throw new Error('Explicit intentional-silence assembly did not produce a video');
      }

      const shortLoopVideo = path.join(dir, 'short-loop-source.mp4');
      await generator.renderSlidesToVideo([stills[0]], 1, shortLoopVideo);
      const tonePath = path.join(dir, 'tone.wav');
      await runFFmpeg([
        '-y',
        '-f', 'lavfi',
        '-i', 'sine=frequency=440:duration=3',
        '-c:a', 'pcm_s16le',
        tonePath
      ], { timeoutMs: 10000 });
      const boundedMuxPath = path.join(dir, 'bounded-loop-mux.mp4');
      await generator.addAudioToVideo(shortLoopVideo, tonePath, boundedMuxPath, {
        loopVideo: true,
        maxDurationSeconds: 3.25
      });
      const boundedDuration = await getMediaDuration(boundedMuxPath);
      const boundedStats = await fs.stat(boundedMuxPath);
      if (boundedDuration < 2.5 || boundedDuration > 3.5 || boundedStats.size > 20 * 1024 * 1024) {
        throw new Error(`Looped audio/video mux escaped its duration/size bound: ${boundedDuration}s, ${boundedStats.size} bytes`);
      }

      const longNarrationPath = path.join(dir, 'long-horror-narration.mp3');
      await runFFmpeg([
        '-y',
        '-f', 'lavfi',
        '-i', 'sine=frequency=180:duration=48',
        '-c:a', 'libmp3lame',
        '-q:a', '4',
        longNarrationPath
      ], { timeoutMs: 10000 });
      const productionAgent = new ProductionManagementAgent({}, {});
      const beforeNormalize = await getMediaDuration(longNarrationPath);
      const afterNormalize = await productionAgent.normalizeHorrorNarrationDuration(
        longNarrationPath,
        beforeNormalize
      );
      const measuredNormalized = await getMediaDuration(longNarrationPath);
      if (
        beforeNormalize < 47 ||
        afterNormalize < 42.5 ||
        afterNormalize > 44.5 ||
        measuredNormalized > 44.5
      ) {
        throw new Error(
          `Horror narration runtime normalization failed: before=${beforeNormalize}, after=${afterNormalize}, measured=${measuredNormalized}`
        );
      }

      const hybridPath = path.join(dir, 'hybrid.mp4');
      await generator.renderMediaTimeline([
        { type: 'video', path: videoPath, duration: 1 },
        { type: 'image', path: stills[0], duration: 1 }
      ], hybridPath);
      const hybridStats = await fs.stat(hybridPath);
      if (!hybridStats.size) throw new Error('Hybrid provider/still timeline did not produce a video');
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }

    this.logger.info('Slideshow renderer test completed successfully');
  }

  async testEvergreenTopics() {
    const { ContentStrategyAgent } = require('./agents/content-strategy-agent');
    const agent = new ContentStrategyAgent(null, {});
    agent.historicalPerformance = [];

    // Single scraped keywords must never become video topics
    agent.trendingTopics = [{ topic: 'crown', score: 5 }, { topic: 'official', score: 3 }];
    const fallback = agent.selectOptimalTopic();
    if (!fallback.topic.includes(' ') || fallback.topic.length < 8) {
      throw new Error(`Template mode produced a junk topic: "${fallback.topic}"`);
    }

    // Readability alone is no longer enough: generic/off-identity trends must not become channel topics.
    agent.trendingTopics = [{ topic: 'artificial intelligence explained', score: 50 }];
    const generic = agent.selectOptimalTopic();
    if (generic.topic === 'artificial intelligence explained') {
      throw new Error('Generic readable trend bypassed the cinematic-curiosity identity gate');
    }

    // A readable, identity-aligned Horror story signal should still be usable.
    agent.trendingTopics = [{ topic: 'She Heard Knocking From Inside the Apartment Wall', score: 5 }];
    const aligned = agent.selectOptimalTopic();
    if (aligned.topic !== 'She Heard Knocking From Inside the Apartment Wall') {
      throw new Error(`Identity-aligned Horror story signal was not selected: "${aligned.topic}"`);
    }

    // Near-duplicates must be rejected even when they score well.
    agent.historicalPerformance = [{
      topic: 'She Heard Knocking From Inside the Apartment Wall',
      createdAt: new Date().toISOString()
    }];
    agent.trendingTopics = [{ topic: 'She Heard Tapping From Inside Her Apartment Wall', score: 100 }];
    const duplicateGuard = agent.selectOptimalTopic();
    if (/inside (the|her) apartment wall/i.test(duplicateGuard.topic)) {
      throw new Error('Near-duplicate Horror premise bypassed the repetition guard');
    }

    this.logger.info('Horror Stickman evergreen topic test completed successfully');
  }

  async testThumbnailCreativeDirection() {
    const { ThumbnailDesignerAgent } = require('./agents/thumbnail-designer-agent');
    const { ProductionManagementAgent } = require('./agents/production-management-agent');

    const agent = new ThumbnailDesignerAgent({ saveThumbnail: async () => {} }, {});
    const script = {
      title: 'She Got a Text From Her Own Bedroom',
      hook: { text: 'Her phone buzzed from inside the locked bedroom.' },
      conclusion: { finalThought: '' },
      metadata: {
        fictional: true,
        strategy: {
          topic: 'She Got a Text From Her Own Bedroom While She Was Alone',
          contentType: 'Story',
          storyEngine: 'impossible-message',
          payoff: 'The last message comes from her own number and says the person outside the bedroom is not her.',
          scrollStopMoment: 'A dark stickman stares at a glowing phone beside a locked bedroom door.',
          curiosityAngle: 'Who is texting from the locked room?',
          fictional: true
        }
      }
    };

    const concept = await agent.generateConcept(script);
    if (!Array.isArray(concept.candidates) || concept.candidates.length !== 3) {
      throw new Error('Thumbnail creative director did not produce exactly three distinct concepts');
    }

    const archetypes = new Set(concept.candidates.map(item => item.archetype));
    if (archetypes.size !== 3) {
      throw new Error('Thumbnail variants collapsed into duplicate creative ideas');
    }

    if (!concept.score || !concept.scoring || !concept.rationale) {
      throw new Error('Selected thumbnail concept is missing transparent scoring evidence');
    }

    const serialized = JSON.stringify(concept);
    if (/MUST WATCH|YOU WON'T BELIEVE|HONEST REVIEW|STEP BY STEP/i.test(serialized)) {
      throw new Error('Generic clickbait thumbnail text leaked into Horror Stickman creative direction');
    }

    const prompt = await agent.createPrompt(concept, script);
    if (
      !/FICTION BOUNDARY:/i.test(prompt) ||
      !/immediate mobile readability/i.test(prompt) ||
      !/one dominant fear cue/i.test(prompt) ||
      !/same Dark Stickman brand grammar/i.test(prompt)
    ) {
      throw new Error('Thumbnail prompt is missing fiction-safety, mobile-readability, or Dark Stickman consistency constraints');
    }
    if (/ethereal, dreamy|floating particles|reaction faces/i.test(prompt)) {
      throw new Error('Legacy generic visual styling leaked into the Horror Stickman thumbnail prompt');
    }

    agent.createThumbnail = async (_concept, suffix) => `base-${suffix}.png`;
    agent.addTextOverlay = async (path) => path;
    agent.optimizeForYouTube = async (_path, suffix) => `optimized-${suffix}.jpg`;
    const variants = await agent.generateABVariants(concept);
    if (variants.length !== 3 || new Set(variants.map(item => item.concept.archetype)).size !== 3) {
      throw new Error('A/B packaging did not preserve three materially different thumbnail concepts');
    }

    const production = new ProductionManagementAgent({}, {});
    let syntheticThumbnailCalled = false;
    production.aiVideoGenerator.generateThumbnail = async () => {
      syntheticThumbnailCalled = true;
      return { path: 'generated-thumbnail.png', dimensions: { width: 1280, height: 720 }, fileSize: 1234 };
    };
    const processed = await production.processThumbnail({ path: 'draft.jpg', concept, prompt }, script);
    if (
      syntheticThumbnailCalled ||
      processed.generatedWith !== 'creative-direction-draft' ||
      processed.productionReady !== false ||
      processed.prompt !== prompt ||
      processed.concept?.archetype !== concept.archetype
    ) {
      throw new Error('Free-only production did not preserve the selected thumbnail brief as non-synthetic creative direction');
    }

    this.logger.info('Thumbnail creative direction test completed successfully');
  }

  async testDocumentaryPackagingStrategy() {
    const { SEOOptimizerAgent } = require('./agents/seo-optimizer-agent');

    let saved = null;
    const db = {
      saveSEOData: async data => { saved = data; },
      getKeywordHistory: async () => []
    };
    const agent = new SEOOptimizerAgent(db, {});
    agent.aiTextService.isAvailable = () => false;

    const strategy = {
      topic: 'Why Engineers Build Airports on Artificial Islands',
      angle: 'The hidden ground-engineering problem beneath offshore airports',
      contentType: 'Story',
      targetAudience: 'Global curiosity-driven viewers',
      keywords: ['artificial island airport', 'airport engineering', 'land reclamation'],
      researchSources: [
        { url: 'https://example.com/engineering-source', title: 'Engineering source' }
      ]
    };
    const script = {
      title: 'Why Engineers Build Airports on Artificial Islands',
      hook: { text: 'Some airports exist only because engineers first had to create the ground beneath them.', duration: 20 },
      mainContent: {
        sections: [
          { title: 'Creating the Ground', duration: 80 },
          { title: 'The Settlement Problem', duration: 90 },
          { title: 'Holding Back the Sea', duration: 90 },
          { title: 'Why It Can Work', duration: 70 }
        ]
      },
      conclusion: { finalThought: 'The runway works only because the engineered ground beneath it keeps changing in controlled ways.' },
      metadata: { strategy }
    };
    const thumbnail = {
      concept: {
        archetype: 'impossible-context',
        primarySubject: 'an offshore airport',
        visualIdea: 'One offshore airport surrounded by open water, with the engineered island clearly readable.',
        truthBoundary: 'Do not invent scale, damage, weather, or structures.'
      }
    };

    const result = await agent.optimize(script, strategy, { thumbnail });
    if (!saved || saved.title !== result.title) {
      throw new Error('Documentary packaging result was not persisted');
    }
    if (!Array.isArray(result.titleCandidates) || result.titleCandidates.length !== 3) {
      throw new Error('SEO packaging did not produce exactly three title candidates');
    }
    if (new Set(result.titleCandidates.map(item => item.title)).size !== 3) {
      throw new Error('SEO packaging title candidates collapsed into duplicates');
    }
    const serializedTitles = result.titleCandidates.map(item => item.title).join(' | ');
    if (/SHOCKING|INSANE|YOU WON'T BELIEVE|SECRET NOBODY|ULTIMATE|\(2026\)/i.test(serializedTitles)) {
      throw new Error('Legacy clickbait or year stuffing leaked into documentary titles');
    }
    if (!Array.isArray(result.packagingVariants) || result.packagingVariants.length !== 3 ||
        result.packagingVariants.some(item => item.thumbnailArchetype !== 'impossible-context')) {
      throw new Error('SEO packaging did not preserve title-thumbnail complementarity');
    }
    if (/WHAT YOU'LL LEARN|USEFUL LINKS|RELATED VIDEOS|comprehensive guide|Perfect for|#youtube|#viral/i.test(result.description)) {
      throw new Error('Legacy template or keyword-dump copy leaked into the description');
    }
    if (result.tags.some(tag => /^(youtube|viral|trending|new|video)$/i.test(tag)) || result.tags.length > 12) {
      throw new Error('Generic tag stuffing leaked into documentary metadata');
    }
    if (result.sources.length !== 1 || result.sources[0].url !== 'https://example.com/engineering-source') {
      throw new Error('Supplied research provenance was not preserved');
    }
    if (result.chapters.length < 3 || result.chapters[0].time !== '00:00') {
      throw new Error('Useful long-form chapters were not generated correctly');
    }
    if (!result.packagingScore || result.packagingScore.thumbnailComplementarity < 70) {
      throw new Error('Packaging score is missing title-thumbnail complementarity');
    }

    const previousAutonomousMode = process.env.AUTONOMOUS_MODE;
    process.env.AUTONOMOUS_MODE = 'true';
    try {
      const horrorAgent = new SEOOptimizerAgent({
        saveSEOData: async () => {},
        getKeywordHistory: async () => []
      }, {});
      horrorAgent.generatePackagingWithAI = async () => ({
        titleCandidates: [
          { title: 'Something Was Wrong With the Camera', mode: 'curiosity', rationale: 'AI candidate intentionally too generic for this regression.' },
          { title: 'The Screen Showed Something Impossible', mode: 'fear', rationale: 'AI candidate intentionally too generic for this regression.' },
          { title: 'He Should Not Have Checked Again', mode: 'hybrid', rationale: 'AI candidate intentionally too generic for this regression.' }
        ],
        description: 'A night guard sees something impossible on the monitor while working alone.',
        discoveryTerms: ['night guard horror', 'security camera horror'],
        tags: ['horror', 'security camera horror']
      });
      const horrorStrategy = {
        topic: "A night guard discovers tomorrow's date stamp on a live security monitor showing himself already dead at his desk.",
        contentType: 'Story',
        everydayAnchor: 'A night guard watches security monitors alone at work',
        fearMechanism: 'one live camera is timestamped tomorrow and shows his own desk',
        payoff: 'The camera feed shows the chair turning toward him before he reaches the room.',
        brandFit: 10,
        nicheFit: 10,
        retentionPotential: 10,
        payoffStrength: 10,
        twistScore: 10,
        keywords: ['night guard horror', 'security camera horror', 'stickman horror']
      };
      const horrorScript = {
        title: "The Security Monitor Showing Tomorrow's Date",
        hook: { text: 'The security monitor was dated tomorrow.' },
        mainContent: { sections: [] },
        keywords: ['horror', 'security camera']
      };
      const horrorThumbnail = {
        concept: {
          score: 97,
          archetype: 'impossible-presence',
          visualIdea: 'Dark stickman night guard staring at a monitor stamped tomorrow.'
        }
      };
      const repaired = await horrorAgent.optimize(horrorScript, horrorStrategy, { thumbnail: horrorThumbnail });
      if (
        repaired.titleCandidates[0]?.scoring?.specificity < 82 ||
        repaired.titleCandidates[0]?.score < 88 ||
        repaired.packagingScore?.overall < 86
      ) {
        throw new Error('Deterministic Horror packaging retry did not recover from a weak AI title set');
      }
    } finally {
      if (previousAutonomousMode === undefined) delete process.env.AUTONOMOUS_MODE;
      else process.env.AUTONOMOUS_MODE = previousAutonomousMode;
    }

    this.logger.info('Documentary packaging strategy test completed successfully');
  }

  async testDocumentaryProductionDirection() {
    const { ProductionManagementAgent } = require('./agents/production-management-agent');
    const { AIVideoGenerator } = require('./utils/ai-video-generator');

    const agent = new ProductionManagementAgent({
      getChannelProfile: async () => ({ visual_style: 'dark stickman psychological horror' })
    }, {});
    const strategy = {
      topic: 'She Got a Text From Her Own Bedroom While She Was Alone',
      fictional: true,
      requestedLengthKey: 'short',
      storyEngine: 'impossible-message',
      scrollStopMoment: 'A dark stickman stares at a glowing phone beside a locked bedroom door.',
      visualVariety: ['phone buzzes', 'locked door', 'message changes', 'shadow under door'],
      payoff: 'The final message comes from her own number and says the person outside the room is not her.'
    };
    const script = {
      title: 'She Got a Text From Her Own Bedroom',
      hook: { text: 'Her phone buzzed from inside the locked bedroom.', duration: '0:00-0:02' },
      introduction: { topicIntro: '', valueProposition: '', credibility: '', duration: '0 seconds' },
      mainContent: {
        sections: [
          { title: 'Buzz', content: ['She lived alone, but the message said: do not open the bedroom door.'], duration: 7, visualQuery: 'dark stickman in hallway holding glowing phone beside locked bedroom', visualRequiredAny: ['stickman','phone'], visualForbiddenAny: ['bright','comedy','gore'] },
          { title: 'Closer', content: ['She stepped closer. Another text appeared: I can hear you breathing.'], duration: 7, visualQuery: 'stickman approaching dark locked bedroom door while phone glows', visualRequiredAny: ['stickman','door'], visualForbiddenAny: ['bright','comedy','gore'] },
          { title: 'Handle', content: ['The handle moved once. Then her own contact name appeared as the sender.'], duration: 7, visualQuery: 'close dark stickman view of moving door handle and glowing phone', visualRequiredAny: ['stickman','door handle'], visualForbiddenAny: ['bright','comedy','gore'] },
          { title: 'Twist', content: ['The last text said: the person outside the bedroom is not you.'], duration: 7, visualQuery: 'dark stickman frozen outside door while second shadow appears behind figure', visualRequiredAny: ['stickman','shadow'], visualForbiddenAny: ['bright','comedy','gore'] }
        ]
      },
      conclusion: { recap: [], finalThought: '', duration: '0 seconds' },
      callToAction: { subscribe: '', like: '', comment: '' },
      metadata: { strategy, fictional: true, spokenWordCount: 100 }
    };

    const tts = agent.formatScriptForTTS(script);
    if (/Welcome back|Section 1|Section 2|Like this video|Comment below/i.test(tts)) {
      throw new Error('Presenter/template language leaked into Horror Stickman narration');
    }

    const scenes = agent.createHorrorStickmanScenePlan(script, strategy, 32);
    if (
      scenes.length !== 4 ||
      scenes[0].role !== 'hook' ||
      scenes[3].role !== 'twist' ||
      scenes.some(scene => !/vertical 9:16/i.test(scene.prompt)) ||
      scenes.some(scene => !/same recurring adult stickman/i.test(scene.prompt)) ||
      scenes.some(scene => !/no gore/i.test(scene.prompt))
    ) {
      throw new Error('Horror Stickman scene plan lost vertical, character-consistency, hook/twist, or safety constraints');
    }

    const generator = new AIVideoGenerator({}, {});
    const enhanced = generator.enhanceVisualPrompt('stickman beside a locked bedroom door', 'dark stickman psychological horror');
    if (
      !/vertical 9:16/i.test(enhanced) ||
      !/dark stickman/i.test(enhanced) ||
      !/no gore/i.test(enhanced) ||
      /ethereal|floating particles|vibrant colors/i.test(enhanced)
    ) {
      throw new Error('Horror Stickman visual handoff lost the locked vertical dark visual style');
    }

    const captions = await agent.createSRTCaptions({ script, strategy, estimatedDuration: 32 });
    if (!/^1\n00:00:00,000 --> /m.test(captions) || /Welcome back|Section 1/.test(captions)) {
      throw new Error('Caption generation is not aligned with clean Horror Shorts narration');
    }

    if (agent.calculatePublishTime({}) !== null || agent.calculatePriority({ estimatedViews: 999999 }) !== 50) {
      throw new Error('Production agent is inventing scheduling or predicted-view priority');
    }

    this.logger.info('Horror Stickman production direction test completed successfully');
  }

  async testEvidenceBasedPublishingStrategy() {
    const previousUploadFlag = process.env.YOUTUBE_UPLOAD_ENABLED;
    process.env.YOUTUBE_UPLOAD_ENABLED = 'true'; // All YouTube clients in this fixture are in-memory mocks.
    try {
    const { PublishingSchedulingAgent } = require('./agents/publishing-scheduling-agent');

    const saved = [];
    const db = {
      saveScheduleEntry: async entry => { const stored = { id: 'schedule-evidence', ...entry }; saved.push(stored); return stored; },
      getLatestScheduleEntry: async () => null,
      getSetting: async () => null,
      updateScheduleEntry: async () => {}
    };
    const agent = new PublishingSchedulingAgent(db, {});
    agent.isNarrationReady = async () => true;

    const baseProduction = {
      id: 'prod-evidence',
      script: { title: 'Evidence-Based Schedule' },
      priority: 50,
      assets: {
        finalVideo: { path: 'video.mp4', simulated: false },
        audio: { path: 'narration.mp3', simulated: false },
        thumbnail: {},
        captions: {}
      },
      seo: { title: 'Evidence-Based Schedule', description: 'A documentary.', tags: [] }
    };

    const unscheduled = await agent.scheduleContent({ ...baseProduction, scheduledPublishTime: null });
    if (unscheduled !== null || saved.length !== 0 || agent.publishQueue.length !== 0) {
      throw new Error('Publishing agent invented a schedule without an explicit publish time');
    }

    const future = new Date(Date.now() + 7200000).toISOString();
    const scheduled = await agent.scheduleContent({ ...baseProduction, scheduledPublishTime: future });
    if (!scheduled || scheduled.publishTime !== future || scheduled.metadata.privacyStatus !== 'private') {
      throw new Error('Explicit private-first scheduled publishing was not preserved');
    }

    const before = scheduled.publishTime;
    const optimization = await agent.optimizePublishTimes();
    if (optimization.status !== 'insufficient_evidence' || optimization.changed !== 0 || scheduled.publishTime !== before) {
      throw new Error('Publishing optimization mutated schedules without real audience timing evidence');
    }

    db.getSetting = async key => key === 'youtube_audience_timing'
      ? JSON.stringify({
          source: 'youtube_studio_audience_report',
          measuredAt: new Date().toISOString(),
          windows: [{ day: 'Saturday', startHour: 18, endHour: 21 }]
        })
      : null;
    const advisory = await agent.optimizePublishTimes();
    if (advisory.status !== 'advisory_only' || advisory.changed !== 0 || scheduled.publishTime !== before) {
      throw new Error('Audience timing evidence triggered an unapproved automatic reschedule');
    }

    let uploadMetadata = null;
    agent.youtube = {
      videos: {
        insert: async request => {
          uploadMetadata = request.requestBody;
          return { data: { id: 'scheduled-youtube-video' } };
        }
      },
      thumbnails: { set: async () => {} },
      captions: { insert: async () => {} }
    };
    agent.getVideoStream = async () => ({ fixture: true });
    await agent.uploadToYouTube(scheduled);
    if (
      uploadMetadata?.status?.privacyStatus !== 'private' ||
      uploadMetadata?.status?.publishAt !== future
    ) {
      throw new Error('Future scheduled upload did not remain private with an explicit publishAt');
    }

    this.logger.info('Evidence-based publishing strategy test completed successfully');
    } finally {
      if (previousUploadFlag === undefined) delete process.env.YOUTUBE_UPLOAD_ENABLED;
      else process.env.YOUTUBE_UPLOAD_ENABLED = previousUploadFlag;
    }
  }
  async testContextualAnalyticsInterpretation() {
    const { AnalyticsOptimizationAgent } = require('./agents/analytics-optimization-agent');

    const db = {
      saveAnalyticsReport: async () => {},
      getPublishedContentContext: async () => ({}),
      getChannelStrategy: async () => null
    };
    const agent = new AnalyticsOptimizationAgent(db, { getYouTubeAuth: () => ({}) });

    agent.youtubeAnalytics = {
      reports: {
        query: async () => { throw new Error('analytics unavailable'); }
      }
    };

    const unavailable = await agent.getVideoAnalytics('video-unavailable', {
      startDate: '2026-09-01',
      endDate: '2026-09-07'
    });
    if (
      unavailable.available !== false ||
      unavailable.simulated !== false ||
      unavailable.views.totalViews !== 0 ||
      unavailable.demographics.primaryAudience !== null
    ) {
      throw new Error('Analytics failure was converted into fabricated or simulated audience data');
    }

    const performance = agent.calculatePerformanceScore({
      available: true,
      views: { totalViews: 500000, totalImpressions: 5000000, averageCTR: 12 },
      watchTime: { averageViewPercentage: 70, averageViewDuration: 400 },
      engagement: { engagementRate: 9 }
    });
    if (performance.score !== null || performance.grade !== 'context_required') {
      throw new Error('Analytics agent still emits universal absolute performance grades');
    }

    const insights = await agent.generateInsights(
      { title: 'Documentary fixture' },
      {
        available: true,
        views: { totalViews: 10000, totalImpressions: 200000, averageCTR: 5 },
        watchTime: { averageViewPercentage: 42, averageViewDuration: 260 },
        engagement: { engagementRate: 3 }
      },
      { impressions: 200000, clickThroughRate: 5 },
      { searchPerformance: { searchPercentage: 18 } }
    );
    const serialized = JSON.stringify(insights);
    if (
      /excellent|poor|below expected|above average|needs improvement/i.test(serialized) ||
      !/traffic source|similar length|comparable channel videos/i.test(serialized)
    ) {
      throw new Error('Analytics insights still apply context-free good/bad thresholds');
    }

    const seo = await agent.analyzeSEOPerformance(
      { title: 'How Offshore Airports Stay Above the Sea', description: 'A factual documentary description.', tags: ['airport engineering'] },
      { trafficSources: { sources: [{ source: 'YOUTUBE_SEARCH', percentage: '17.5' }] } }
    );
    if (
      seo.overallSEOScore !== null ||
      seo.titleScore !== null ||
      seo.tagScore !== null ||
      seo.searchPerformance.searchQuality !== 'context_required'
    ) {
      throw new Error('Legacy keyword-era SEO scoring remains in analytics');
    }

    const thumbnailAdvice = agent.generateThumbnailRecommendations(2);
    if (/poor|brighter colors|increase text contrast/i.test(thumbnailAdvice.join(' '))) {
      throw new Error('Thumbnail analytics still recommends generic design changes from CTR alone');
    }

    this.logger.info('Contextual analytics interpretation test completed successfully');
  }

  async testWalkthroughModule() {
    const { SetupWalkthrough, AI_PROVIDER_GUIDE, VIDEO_PROVIDER_GUIDE } = require('./walkthrough');
    const { PROVIDERS, GEMINI_MODELS, GEMINI_DEFAULT_MODEL, TEXT_PROVIDER_ENV_KEYS } = require('./utils/ai-text-service');

    const walkthrough = new SetupWalkthrough();
    if (typeof walkthrough.run !== 'function') {
      throw new Error('SetupWalkthrough.run is not implemented');
    }

    // Every guided provider must be complete and coherent
    for (const [id, guide] of Object.entries(AI_PROVIDER_GUIDE)) {
      for (const field of ['label', 'keyUrl', 'instructions', 'models', 'defaultModel', 'save', 'validationCreds']) {
        if (!guide[field]) {
          throw new Error(`Provider guide "${id}" is missing "${field}"`);
        }
      }
      if (!guide.models.includes(guide.defaultModel)) {
        throw new Error(`Provider guide "${id}" default model is not in its model list`);
      }

      // save() must produce credentials that pass validation
      const credentials = {};
      guide.save(credentials, 'test-key', guide.defaultModel);
      const manager = new CredentialManager();
      manager.credentials = { youtube: { client_id: 'x' }, ...credentials };

      const envKeys = TEXT_PROVIDER_ENV_KEYS;
      const savedEnv = {};
      for (const key of envKeys) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }
      try {
        if (manager.getMissingCredentials().length !== 0) {
          throw new Error(`Provider guide "${id}" save() output fails credential validation`);
        }
      } finally {
        for (const key of envKeys) {
          if (savedEnv[key] === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = savedEnv[key];
          }
        }
      }
    }

    if (
      JSON.stringify(AI_PROVIDER_GUIDE.gemini.models) !== JSON.stringify(GEMINI_MODELS) ||
      AI_PROVIDER_GUIDE.gemini.defaultModel !== GEMINI_DEFAULT_MODEL
    ) {
      throw new Error('Walkthrough Gemini models drifted from the runtime catalog');
    }

    for (const id of Object.keys(PROVIDERS)) {
      if (JSON.stringify(AI_PROVIDER_GUIDE[id].models) !== JSON.stringify(PROVIDERS[id].models)) {
        throw new Error(`Walkthrough provider "${id}" models drifted from the runtime catalog`);
      }
    }

    for (const id of ['slideshow', 'seedance', 'minimax_h3', 'google_omni', 'kling', 'wan']) {
      const guide = VIDEO_PROVIDER_GUIDE[id];
      if (!guide?.label) throw new Error(`Walkthrough is missing video provider "${id}"`);
      if (id !== 'slideshow') {
        const credentials = {};
        guide.save(credentials, 'test-key', 'test-secret');
        if (!Object.keys(credentials).length || !guide.keyUrl || !guide.credentialName) {
          throw new Error(`Video provider guide "${id}" cannot save its credentials`);
        }
      }
    }

    const currentOpenRouterModels = [
      'openai/gpt-5.6-sol',
      'anthropic/claude-fable-5',
      'google/gemini-3.7-flash',
      'moonshotai/kimi-k3',
      'z-ai/glm-5.3'
    ];
    if (JSON.stringify(PROVIDERS.openrouter.models) !== JSON.stringify(currentOpenRouterModels)) {
      throw new Error('OpenRouter curated models are not the verified current catalog');
    }

    this.logger.info('Walkthrough module test completed successfully');
  }

  async testLogger() {
    const testLogger = new Logger('TestLogger');
    
    testLogger.info('Test info message');
    testLogger.warn('Test warning message');
    testLogger.success('Test success message');
    
    // Test timer
    const timer = testLogger.startTimer('Test Operation');
    await new Promise(resolve => setTimeout(resolve, 100));
    timer.end();
    
    this.logger.info('Logger test completed successfully');
  }

  async testDirectories() {
    const fs = require('fs').promises;
    
    const requiredDirs = [
      'config',
      'logs', 
      'data',
      'agents',
      'database',
      'utils',
      'schedules'
    ];

    for (const dir of requiredDirs) {
      const dirPath = path.join(__dirname, dir);
      await fs.access(dirPath);
    }

    this.logger.info('Directory structure test completed successfully');
  }

  async testAgentLoading() {
    // Test that agent files can be loaded
    const agentFiles = [
      './agents/content-strategy-agent',
      './agents/script-writer-agent',
      './agents/thumbnail-designer-agent',
      './agents/seo-optimizer-agent',
      './agents/production-management-agent',
      './agents/publishing-scheduling-agent',
      './agents/analytics-optimization-agent',
      './utils/discoverability-service',
      './utils/discoverability-adapters/darkzseo'
    ];

    for (const agentFile of agentFiles) {
      try {
        require(agentFile);
      } catch (error) {
        throw new Error(`Failed to load ${agentFile}: ${error.message}`);
      }
    }

    this.logger.info('Agent loading test completed successfully');
  }

  async testYouTubeScopeDetection() {
    const manager = new CredentialManager();
    const forceSsl = 'https://www.googleapis.com/auth/youtube.force-ssl';
    manager.tokens = { youtube: { scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube' } };
    if (manager.hasYouTubeScope(forceSsl)) throw new Error('force-ssl must not be reported before consent');
    if (!manager.hasYouTubeScope('https://www.googleapis.com/auth/youtube')) throw new Error('Granted scopes must be detected');
    manager.tokens.youtube.scope += ` ${forceSsl}`;
    if (!manager.hasYouTubeScope(forceSsl)) throw new Error('force-ssl must be detected after consent');
    manager.tokens = {};
    if (manager.hasYouTubeScope('https://www.googleapis.com/auth/youtube')) throw new Error('Missing tokens must report no scopes');
  }

  async testReplyDraftStore() {
    const db = new Database();
    await db.initialize();
    const commentId = `rc_test_${Date.now()}`;
    const videoId = `vid_reply_${Date.now()}`;
    try {
      const draft = await db.saveReplyDraft({ commentId, videoId, draftText: 'Thanks! The cache works per scene.', rationale: 'Direct question' });
      if (!draft || draft.status !== 'proposed') throw new Error('saveReplyDraft did not create a proposed draft');

      const edited = await db.updateReplyDraft(draft.id, { editedText: 'Thanks! Each scene caches separately.' });
      if (edited.editedText !== 'Thanks! Each scene caches separately.') throw new Error('editedText was not persisted');

      const replaced = await db.saveReplyDraft({ commentId, videoId, draftText: 'New draft text' });
      if (replaced.id !== draft.id) throw new Error('Re-drafting must reuse the comment row');
      if (replaced.editedText !== null || replaced.status !== 'proposed') throw new Error('Re-drafting must reset the lifecycle');

      const postedAt = new Date().toISOString();
      await db.updateReplyDraft(draft.id, { status: 'posted', postedCommentId: 'yt_reply_1', postedAt });
      const posted = await db.getReplyDraft(draft.id);
      if (posted.status !== 'posted' || posted.postedCommentId !== 'yt_reply_1') throw new Error('Posting evidence was not stored');

      let blocked = false;
      try {
        await db.saveReplyDraft({ commentId, videoId, draftText: 'Should not overwrite' });
      } catch (error) {
        blocked = error.status === 409;
      }
      if (!blocked) throw new Error('A posted reply draft must never be replaced');

      const postedCount = await db.countReplyDraftsPostedSince(new Date(Date.now() - 60000).toISOString());
      if (postedCount < 1) throw new Error('countReplyDraftsPostedSince missed the posted draft');

      const listed = await db.listReplyDrafts({ videoId, status: 'posted' });
      if (listed.length !== 1) throw new Error('listReplyDrafts filter failed');
    } finally {
      await db.executeQuery('DELETE FROM reply_drafts WHERE video_id = ?', [videoId]);
      await db.close();
    }
  }

  async testEngagementInsightStore() {
    const db = new Database();
    await db.initialize();
    const videoId = `vid_insight_${Date.now()}`;
    try {
      const synced = await db.saveEngagementInsight({
        videoId, title: 'Test video', commentCount: 4,
        lastSyncedAt: '2026-08-23T10:00:00.000Z',
        newestCommentAt: '2026-08-23T09:00:00.000Z'
      });
      if (!synced || synced.videoId !== videoId) throw new Error('saveEngagementInsight did not store the row');

      const analyzed = await db.saveEngagementInsight({
        videoId, analyzedCount: 4,
        sentiment: { method: 'ai', positive: 3, neutral: 1, negative: 0 },
        themes: [{ title: 'Render cache questions', summary: 'Viewers ask how caching works', kind: 'question', count: 3, commentIds: ['a', 'b', 'c'] }],
        attentionFlags: [{ commentId: 'x', categories: ['scam'], permalink: 'https://www.youtube.com/watch?v=1&lc=x' }],
        analysisMethod: 'ai', analyzedAt: '2026-08-23T10:05:00.000Z'
      });
      if (analyzed.id !== synced.id) throw new Error('Insight upsert must reuse the video row, not duplicate');
      if (analyzed.lastSyncedAt !== '2026-08-23T10:00:00.000Z') throw new Error('Merge lost the sync watermark');
      if (analyzed.themes[0]?.count !== 3 || analyzed.sentiment.positive !== 3) throw new Error('JSON columns did not round-trip');
      if (analyzed.attentionFlags.length !== 1) throw new Error('attention_flags did not round-trip');

      const listed = await db.listEngagementInsights({ limit: 5 });
      if (!listed.some(item => item.videoId === videoId)) throw new Error('listEngagementInsights missed the row');
    } finally {
      await db.executeQuery('DELETE FROM engagement_insights WHERE video_id = ?', [videoId]);
      await db.close();
    }
  }

  async testAudienceCommentStore() {
    const db = new Database();
    await db.initialize();
    const commentId = `ac_test_${Date.now()}`;
    const videoId = `vid_test_${Date.now()}`;
    try {
      const first = await db.upsertAudienceComment({
        commentId, videoId,
        text: 'How does the render cache work?',
        authorName: 'Viewer One', authorChannelId: 'UC_viewer_1',
        likeCount: 3, replyCount: 0,
        publishedAt: new Date().toISOString()
      });
      if (!first || first.commentId !== commentId) throw new Error('upsertAudienceComment did not store the comment');
      if (first.isChannelOwner !== false || first.repliedByAgent !== false) throw new Error('Boolean parsing is wrong');

      const second = await db.upsertAudienceComment({
        commentId, videoId, text: 'How does the render cache work? (edited)', likeCount: 5
      });
      if (second.id !== first.id) throw new Error('Re-syncing the same comment must upsert, not duplicate');
      if (second.likeCount !== 5 || !second.text.includes('(edited)')) throw new Error('Upsert did not refresh mutable fields');

      const flagged = await db.setAudienceCommentAnalysis(commentId, ['question']);
      if (flagged.analysisState !== 'analyzed' || !flagged.flags.includes('question')) throw new Error('Analysis flags were not persisted');

      const listed = await db.listAudienceComments({ videoId, topLevelOnly: true });
      if (listed.length !== 1) throw new Error('listAudienceComments missed the top-level comment');

      const counts = await db.countAudienceComments(videoId);
      if (counts.total !== 1 || counts.topLevel !== 1) throw new Error('countAudienceComments returned wrong counts');

      const replied = await db.markAudienceCommentReplied(commentId);
      if (!replied.repliedByAgent) throw new Error('markAudienceCommentReplied did not persist');
    } finally {
      await db.executeQuery('DELETE FROM audience_comments WHERE video_id = ?', [videoId]);
      await db.close();
    }
  }

  async testConfiguration() {
    const fs = require('fs').promises;
    
    // Check package.json
    const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8'));
    if (!packageJson.name || !packageJson.dependencies) {
      throw new Error('Invalid package.json');
    }

    // Check if main index file exists
    await fs.access('./index.js');

    // The startup banner must report the real version. It was hardcoded to "v2.0"
    // through v2.4.0, so bug reports pasted a version that was four releases stale.
    const indexSource = await fs.readFile('index.js', 'utf8');
    const hardcodedBanner = indexSource.match(/YouTube Automation Agent v[\d.]/);
    if (hardcodedBanner) {
      throw new Error(
        `Startup banner hardcodes a version ("${hardcodedBanner[0]}") — interpolate package.json's version instead`
      );
    }
    if (!indexSource.includes('YouTube Automation Agent v${version}')) {
      throw new Error('Startup banner does not report the package.json version');
    }

    // If a package-lock exists in this checkout, keep it aligned. The repository
    // itself does not require a tracked lockfile, so clean checkouts without one are valid.
    try {
      const lockJson = JSON.parse(await fs.readFile('package-lock.json', 'utf8'));
      if (lockJson.version !== packageJson.version) {
        throw new Error(
          `package-lock.json version (${lockJson.version}) does not match package.json (${packageJson.version})`
        );
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    this.logger.info('Configuration test completed successfully');
  }

  async testAudienceCommentSync() {
    const db = new Database();
    await db.initialize();
    const videoId = `vid_sync_${Date.now()}`;
    const iso = offsetMinutes => new Date(Date.now() - offsetMinutes * 60000).toISOString();
    const thread = (id, publishedAt, replies = []) => ({
      id,
      snippet: {
        totalReplyCount: replies.length,
        topLevelComment: { id, snippet: {
          textOriginal: `Comment ${id}`, authorDisplayName: 'Viewer',
          authorChannelId: { value: 'UC_viewer' }, likeCount: 1, publishedAt, updatedAt: publishedAt
        } }
      },
      replies: { comments: replies }
    });
    try {
      const pages = [
        { items: [thread(`${videoId}_c2`, iso(5)), thread(`${videoId}_c1`, iso(60), [{
            id: `${videoId}_c1_r1`, snippet: {
              textOriginal: 'A reply', authorDisplayName: 'Owner',
              authorChannelId: { value: 'UC_channel_owner' }, likeCount: 0, publishedAt: iso(30), updatedAt: iso(30)
            }
          }]) ] }
      ];
      const service = new AudienceEngagementService(db, null, null, {
        listCommentThreads: async () => pages[0],
        getChannelId: async () => 'UC_channel_owner'
      });

      const first = await service.syncVideoComments(videoId, { title: 'Sync test' });
      if (first.fetched !== 3) throw new Error(`Expected 3 stored comments, got ${first.fetched}`);
      if (!first.insight?.newestCommentAt) throw new Error('Sync did not record the watermark');
      const ownerReply = await db.getAudienceComment(`${videoId}_c1_r1`);
      if (!ownerReply.isChannelOwner || ownerReply.parentCommentId !== `${videoId}_c1`) throw new Error('Reply mapping is wrong');

      const second = await service.syncVideoComments(videoId, {});
      if (second.fetched !== 0) throw new Error('Watermark must stop re-ingesting known comments');

      // Refusal policy: API failure stores nothing and rethrows
      const failing = new AudienceEngagementService(db, null, null, {
        listCommentThreads: async () => { throw new Error('quota exceeded'); },
        getChannelId: async () => 'UC_channel_owner'
      });
      let threw = false;
      try { await failing.syncVideoComments(`${videoId}_other`, {}); } catch (_error) { threw = true; }
      if (!threw) throw new Error('API failure must throw');
      if (await db.getEngagementInsight(`${videoId}_other`)) throw new Error('A failed sync must store nothing');

      // Disabled comments are not an error
      const disabledError = new Error('disabled');
      disabledError.errors = [{ reason: 'commentsDisabled' }];
      const disabledService = new AudienceEngagementService(db, null, null, {
        listCommentThreads: async () => { throw disabledError; },
        getChannelId: async () => 'UC_channel_owner'
      });
      const disabled = await disabledService.syncVideoComments(`${videoId}_disabled`, {});
      if (!disabled.disabled || disabled.fetched !== 0) throw new Error('commentsDisabled must be recorded, not thrown');

      // Taper
      if (service.isSyncDue(null, iso(0))) { /* never-synced is due */ } else throw new Error('Never-synced video must be due');
      const fresh = { lastSyncedAt: iso(60) };
      if (service.isSyncDue(fresh, iso(24 * 60))) throw new Error('A 1h-stale sync of a 1-day-old video is not due (4h taper)');
      if (!service.isSyncDue({ lastSyncedAt: iso(5 * 60) }, iso(24 * 60))) throw new Error('A 5h-stale sync of a 1-day-old video is due');
      if (service.isSyncDue({ lastSyncedAt: iso(13 * 60) }, iso(40 * 24 * 60))) throw new Error('Videos older than 30 days are never auto-due');
    } finally {
      await db.executeQuery("DELETE FROM audience_comments WHERE video_id LIKE ?", [`${videoId}%`]);
      await db.executeQuery("DELETE FROM engagement_insights WHERE video_id LIKE ?", [`${videoId}%`]);
      await db.close();
    }
  }

  async testAudienceCommentAnalysis() {
    const db = new Database();
    await db.initialize();
    const videoId = `vid_analysis_${Date.now()}`;
    const seed = async (suffix, text, likeCount = 0) => db.upsertAudienceComment({
      commentId: `${videoId}_${suffix}`, videoId, text, likeCount,
      publishedAt: new Date().toISOString()
    });
    try {
      await seed('q1', 'How do I configure the render cache?', 4);
      await seed('q2', 'Can you explain the cache setup?', 2);
      await seed('q3', 'What cache settings do you use?', 1);
      await seed('scam1', 'Congratulations! Message me on telegram to claim your prize');
      const aiResponse = JSON.stringify({
        comments: [
          { commentId: `${videoId}_q1`, sentiment: 'positive', flags: ['question'] },
          { commentId: `${videoId}_q2`, sentiment: 'neutral', flags: ['question'] },
          { commentId: `${videoId}_q3`, sentiment: 'neutral', flags: ['question'] },
          { commentId: `${videoId}_scam1`, sentiment: 'neutral', flags: ['scam'] },
          { commentId: 'not_a_real_comment', sentiment: 'negative', flags: ['toxic'] }
        ],
        themes: [
          { title: 'Render cache setup', summary: 'Viewers want a cache configuration walkthrough', kind: 'question',
            commentIds: [`${videoId}_q1`, `${videoId}_q2`, `${videoId}_q3`, `${videoId}_scam1`, 'not_a_real_comment'] },
          { title: 'Bad theme', summary: 'Only one supporter', kind: 'feedback', commentIds: [`${videoId}_q1`] }
        ]
      });
      const service = new AudienceEngagementService(db, null, {
        isAvailable: () => true,
        generateText: async () => aiResponse
      }, {});

      const insight = await service.analyzeVideo(videoId);
      if (insight.analysisMethod !== 'ai') throw new Error('AI analysis was not recorded as ai');
      if (insight.sentiment.positive !== 1 || insight.sentiment.neutral !== 3) throw new Error('Sentiment counts are wrong');
      if (insight.themes.length !== 1) throw new Error('Theme normalization must drop single-comment themes');
      if (insight.themes[0].count !== 3) throw new Error('Quarantined and unknown comment ids must not count toward themes');
      if (insight.attentionFlags.length !== 1 || insight.attentionFlags[0].commentId !== `${videoId}_scam1`) {
        throw new Error('Scam comment must land in attentionFlags');
      }
      const scam = await db.getAudienceComment(`${videoId}_scam1`);
      if (!scam.flags.includes('scam')) throw new Error('Per-comment flags were not stored');

      // parseAIJsonResponse handles fenced, embedded, and malformed output
      if (service.parseAIJsonResponse('```json\n{"a":1}\n```')?.a !== 1) throw new Error('Fenced JSON must parse');
      if (service.parseAIJsonResponse('noise before [1,2] noise after')?.[0] !== 1) throw new Error('Embedded arrays must parse');
      if (service.parseAIJsonResponse('not json at all') !== null) throw new Error('Garbage must return null');

      // Fallback: mechanical facts only, no themes
      const fallbackVideo = `${videoId}_fb`;
      await db.upsertAudienceComment({ commentId: `${fallbackVideo}_c1`, videoId: fallbackVideo, text: 'Is this real?', publishedAt: new Date().toISOString() });
      const fallbackService = new AudienceEngagementService(db, null, { isAvailable: () => false }, {});
      const fallback = await fallbackService.analyzeVideo(fallbackVideo);
      if (fallback.analysisMethod !== 'fallback') throw new Error('Fallback method was not recorded');
      if (fallback.themes.length !== 0) throw new Error('Fallback must never invent themes');
      if (fallback.sentiment.method !== 'fallback' || 'positive' in fallback.sentiment) throw new Error('Fallback must not claim sentiment');
      const fallbackComment = await db.getAudienceComment(`${fallbackVideo}_c1`);
      if (!fallbackComment.flags.includes('question')) throw new Error('Fallback question detection failed');

      // syncDueVideos delegates and analyzes only after a fetching sync
      let analyzeCalls = 0;
      const dueService = new AudienceEngagementService(db, null, { isAvailable: () => false }, {
        listCommentThreads: async () => ({ items: [] })
      });
      dueService.analyzeVideo = async () => { analyzeCalls++; };
      const results = await dueService.syncDueVideos([
        { youtubeId: `${videoId}_due`, title: 'Due', publishedAt: new Date().toISOString(), productionId: null },
        { youtubeId: null }
      ]);
      if (results.synced !== 1 || results.skipped !== 1) throw new Error(`syncDueVideos counters are wrong: ${JSON.stringify(results)}`);
      if (analyzeCalls !== 0) throw new Error('A sync that fetched nothing must not trigger analysis');
    } finally {
      await db.executeQuery("DELETE FROM learning_recommendations WHERE category = 'audience_demand' AND evidence LIKE ?", [`%${videoId}%`]);
      await db.executeQuery('DELETE FROM audience_comments WHERE video_id LIKE ?', [`${videoId}%`]);
      await db.executeQuery('DELETE FROM engagement_insights WHERE video_id LIKE ?', [`${videoId}%`]);
      await db.close();
    }
  }

  async testAudienceIdeaMining() {
    const db = new Database();
    await db.initialize();
    const videoId = `vid_mining_${Date.now()}`;
    try {
      for (const suffix of ['m1', 'm2', 'm3']) {
        await db.upsertAudienceComment({
          commentId: `${videoId}_${suffix}`, videoId,
          text: `Please cover local caching next (${suffix})`, publishedAt: new Date().toISOString()
        });
      }
      const service = new AudienceEngagementService(db, null, null, {});
      const insight = {
        videoId, title: 'Mining test', analysisMethod: 'ai',
        themes: [
          { title: 'Cover local caching', summary: 'Repeated requests for a caching deep-dive', kind: 'request',
            count: 3, commentIds: [`${videoId}_m1`, `${videoId}_m2`, `${videoId}_m3`] },
          { title: 'Too few asks', summary: 'Only two', kind: 'request', count: 2, commentIds: [`${videoId}_m1`, `${videoId}_m2`] },
          { title: 'Praise cluster', summary: 'Nice video', kind: 'praise', count: 5, commentIds: [`${videoId}_m1`, `${videoId}_m2`, `${videoId}_m3`] }
        ]
      };
      const saved = await service.refreshAudienceRecommendations(videoId, insight);
      if (saved.length !== 1) throw new Error(`Only the >=3 request/question theme may mine an idea; got ${saved.length}`);
      const recommendation = saved[0];
      if (recommendation.category !== 'audience_demand') throw new Error('Category must be audience_demand');
      if (recommendation.status !== 'pending') throw new Error('Mined ideas must be pending until reviewed');
      if (recommendation.confidence !== 'low') throw new Error('Ask-count 3 maps to low confidence');
      const evidence = recommendation.evidence; // parseLearningRecommendation returns it already parsed
      if (evidence.askCount !== 3 || evidence.sampleComments.length !== 3) throw new Error('Evidence is incomplete');
      if (!evidence.sampleComments[0].permalink.includes('&lc=')) throw new Error('Evidence must carry comment permalinks');
      if (recommendation.proposedChange.autoEditPublishedContent !== false) throw new Error('autoEditPublishedContent must be false');

      const again = await service.refreshAudienceRecommendations(videoId, insight);
      if (again[0].id !== recommendation.id) throw new Error('Re-analysis must dedupe by fingerprint, not duplicate');

      const nonAI = await service.refreshAudienceRecommendations(videoId, { ...insight, analysisMethod: 'fallback' });
      if (nonAI.length !== 0) throw new Error('Fallback analysis must never mine ideas');
    } finally {
      await db.executeQuery("DELETE FROM learning_recommendations WHERE category = 'audience_demand' AND evidence LIKE ?", [`%${videoId}%`]);
      await db.executeQuery('DELETE FROM audience_comments WHERE video_id = ?', [videoId]);
      await db.close();
    }
  }

  async testReplyDrafting() {
    const db = new Database();
    await db.initialize();
    const videoId = `vid_draft_${Date.now()}`;
    const seed = (suffix, text, flags, extra = {}) => db.upsertAudienceComment({
      commentId: `${videoId}_${suffix}`, videoId, text,
      publishedAt: new Date().toISOString(), ...extra
    }).then(() => db.setAudienceCommentAnalysis(`${videoId}_${suffix}`, flags));
    try {
      await seed('q1', 'How long does a render take?', ['question']);
      await seed('praise1', 'Great video!', ['praise']);
      await seed('scam1', 'Claim your prize now', ['scam']);
      await seed('own1', 'Thanks all!', [], { isChannelOwner: true });
      await db.upsertAudienceComment({
        commentId: `${videoId}_nested`, videoId, parentCommentId: `${videoId}_q1`,
        text: 'Also curious?', publishedAt: new Date().toISOString()
      });
      await db.saveEngagementInsight({ videoId, title: 'Draft test', analysisMethod: 'ai', analyzedAt: new Date().toISOString() });

      let promptSeen = '';
      const service = new AudienceEngagementService(db, null, {
        isAvailable: () => true,
        generateText: async prompt => {
          promptSeen = prompt;
          return JSON.stringify([
            { commentId: `${videoId}_q1`, reply: 'About two minutes per scene on default settings.', rationale: 'Direct question' },
            { commentId: `${videoId}_praise1`, reply: 'Visit http://spam.example now', rationale: 'Link should be dropped' },
            { commentId: `${videoId}_scam1`, reply: 'Should never appear', rationale: 'Quarantined' }
          ]);
        }
      }, {});

      const drafts = await service.draftReplies(videoId);
      if (drafts.length !== 1) throw new Error(`Expected 1 usable draft (link + quarantined dropped), got ${drafts.length}`);
      if (drafts[0].commentId !== `${videoId}_q1` || drafts[0].status !== 'proposed') throw new Error('Draft shape is wrong');
      if (promptSeen.includes(`${videoId}_scam1`) || promptSeen.includes(`${videoId}_own1`) || promptSeen.includes(`${videoId}_nested`)) {
        throw new Error('Quarantined, owner, and nested comments must never reach the draft prompt');
      }

      const noAI = new AudienceEngagementService(db, null, { isAvailable: () => false }, {});
      let status = 0;
      try { await noAI.draftReplies(videoId); } catch (error) { status = error.status; }
      if (status !== 503) throw new Error('Drafting without AI must throw 503');

      await db.saveEngagementInsight({ videoId: `${videoId}_fb`, analysisMethod: 'fallback' });
      status = 0;
      try { await service.draftReplies(`${videoId}_fb`); } catch (error) { status = error.status; }
      if (status !== 409) throw new Error('Drafting without an AI analysis must throw 409');
    } finally {
      await db.executeQuery('DELETE FROM audience_comments WHERE video_id = ?', [videoId]);
      await db.executeQuery('DELETE FROM engagement_insights WHERE video_id LIKE ?', [`${videoId}%`]);
      await db.executeQuery('DELETE FROM reply_drafts WHERE video_id = ?', [videoId]);
      await db.close();
    }
  }

  async testReplyApprovalAndPosting() {
    const db = new Database();
    await db.initialize();
    const videoId = `vid_post_${Date.now()}`;
    const commentId = `${videoId}_target`;
    const scopedCredentials = { hasYouTubeScope: scope => scope === 'https://www.googleapis.com/auth/youtube.force-ssl' };
    try {
      await db.upsertAudienceComment({ commentId, videoId, text: 'Question?', publishedAt: new Date().toISOString() });
      const makeDraft = () => db.saveReplyDraft({ commentId, videoId, draftText: 'Answer text' });

      let draft = await makeDraft();
      const posts = [];
      const service = new AudienceEngagementService(db, scopedCredentials, null, {
        insertComment: async ({ parentId, text }) => { posts.push({ parentId, text }); return { id: 'yt_posted_1' }; }
      });

      let code = null;
      try { await service.approveReplyDraft(draft.id, {}); } catch (error) { code = error.code; }
      if (code !== 'REPLY_APPROVAL_REQUIRED') throw new Error('Approval must require confirmed: true');

      const unscoped = new AudienceEngagementService(db, { hasYouTubeScope: () => false }, null, {});
      code = null;
      try { await unscoped.approveReplyDraft(draft.id, { confirmed: true }); } catch (error) { code = error.code; }
      if (code !== 'REPLY_SCOPE_REQUIRED') throw new Error('Missing force-ssl scope must block posting');
      const gate = unscoped.postingEnabled();
      if (gate.enabled || gate.reason !== 'missing_scope') {
        throw new Error('postingEnabled must report missing_scope');
      }

      const posted = await service.approveReplyDraft(draft.id, { confirmed: true, editedText: 'Edited answer' });
      if (posted.status !== 'posted' || posted.postedCommentId !== 'yt_posted_1') throw new Error('Posting evidence missing');
      if (posts[0].parentId !== commentId || posts[0].text !== 'Edited answer') throw new Error('The edited text must be what posts');
      if (!(await db.getAudienceComment(commentId)).repliedByAgent) throw new Error('Source comment must be marked replied');

      let status = null;
      try { await service.approveReplyDraft(draft.id, { confirmed: true }); } catch (error) { status = error.status; }
      if (status !== 409) throw new Error('A posted draft must not post twice');

      // Failure path: failed + reason, manual retry allowed
      const failingComment = `${videoId}_fail`;
      await db.upsertAudienceComment({ commentId: failingComment, videoId, text: 'Other?', publishedAt: new Date().toISOString() });
      const failDraft = await db.saveReplyDraft({ commentId: failingComment, videoId, draftText: 'Will fail' });
      const failing = new AudienceEngagementService(db, scopedCredentials, null, {
        insertComment: async () => { throw new Error('commentThreadNotFound'); }
      });
      status = null;
      try { await failing.approveReplyDraft(failDraft.id, { confirmed: true }); } catch (error) { status = error.status; }
      if (status !== 502) throw new Error('A failed post must throw 502');
      const failed = await db.getReplyDraft(failDraft.id);
      if (failed.status !== 'failed' || !failed.failureReason.includes('commentThreadNotFound')) throw new Error('Failure evidence missing');

      // Daily cap
      const capped = new AudienceEngagementService(db, scopedCredentials, null, { dailyReplyCap: 1, insertComment: async () => ({ id: 'x' }) });
      status = null;
      try { await capped.approveReplyDraft(failDraft.id, { confirmed: true }); } catch (error) { status = error.status; }
      if (status !== 429) throw new Error('The daily reply cap must block further posts');

      // updateReplyDraft rules
      const edited = await service.updateReplyDraft(failDraft.id, { editedText: 'Retry text' });
      if (edited.status !== 'proposed' || edited.editedText !== 'Retry text') throw new Error('Editing must re-open a failed draft');
      const discarded = await service.updateReplyDraft(failDraft.id, { discard: true });
      if (discarded.status !== 'discarded') throw new Error('Discard failed');

      // Summary
      const summary = await service.getSummary();
      if (summary.postedToday < 1) throw new Error('getSummary missed postedToday');
      if (summary.postingEnabled !== true) throw new Error('getSummary posting flag is wrong');
      if (!summary.evidencePolicy.includes('operator approval')) throw new Error('evidencePolicy text missing');
    } finally {
      await db.executeQuery('DELETE FROM audience_comments WHERE video_id = ?', [videoId]);
      await db.executeQuery('DELETE FROM reply_drafts WHERE video_id = ?', [videoId]);
      await db.executeQuery('DELETE FROM engagement_insights WHERE video_id = ?', [videoId]);
      await db.close();
    }
  }

  async testEngagementAIProviderWiring() {
    const { AITextService, TEXT_PROVIDER_ENV_KEYS } = require('./utils/ai-text-service');

    // Regression: index.js must hand AITextService the unwrapped credentials object
    // (manager.credentials), the shape the walkthrough writes to credentials.json.
    // Passing the CredentialManager itself leaves the engagement studio permanently
    // in fallback mode on installs with no provider environment variables.
    //
    // This test must isolate every provider environment variable. Otherwise a real
    // GEMINI_API_KEY (or another configured provider) makes the intentionally wrapped
    // credentials object appear available and produces a false failure.
    const providerEnvKeys = TEXT_PROVIDER_ENV_KEYS;
    const savedEnv = Object.fromEntries(providerEnvKeys.map(key => [key, process.env[key]]));
    for (const key of providerEnvKeys) delete process.env[key];

    try {
      const configured = new AITextService({
        aiProvider: { provider: 'openai', apiKey: 'test-key', model: 'gpt-5.6' }
      });
      if (!configured.isAvailable()) {
        throw new Error('AITextService must initialize from a credentials-file aiProvider config');
      }

      const wrapped = new AITextService({
        credentials: { aiProvider: { provider: 'openai', apiKey: 'test-key', model: 'gpt-5.6' } }
      });
      if (wrapped.isAvailable()) {
        throw new Error('A CredentialManager-shaped argument must not look configured; index.js has to unwrap it');
      }
    } finally {
      for (const key of providerEnvKeys) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
    }
  }

  async testEngagementSyncSchedule() {
    let captured = null;
    const events = [];
    const fakeDb = {
      getAllRows: async () => [
        { youtube_id: 'vid_sched_1', title: 'Scheduled video', published_at: '2026-08-22T00:00:00.000Z', production_id: 'prod_1' }
      ],
      executeQuery: async () => ({}),
      generateId: prefix => `${prefix}_test`
    };
    const scheduler = new DailyAutomation({}, fakeDb, {
      generateContent: async () => {},
      engagement: {
        syncDueVideos: async videos => {
          captured = videos;
          return { synced: 1, skipped: 0, failed: 0, analyzed: 1 };
        }
      }
    });
    scheduler.logAutomationEvent = async (type, status, data) => { events.push({ type, status, data }); };
    await scheduler.collectAudienceEngagement();
    if (!captured || captured[0].youtubeId !== 'vid_sched_1') throw new Error('The scheduler did not map youtube_id');
    if (captured[0].productionId !== 'prod_1' || captured[0].publishedAt !== '2026-08-22T00:00:00.000Z') {
      throw new Error('The scheduler did not map production/publish fields');
    }
    if (!events.some(event => event.type === 'audience_engagement_sync' && event.status === 'success')) {
      throw new Error('The engagement sweep must log an automation event');
    }
    const noService = new DailyAutomation({}, fakeDb, { generateContent: async () => {} });
    await noService.collectAudienceEngagement(); // must be a silent no-op, not a crash
  }

  async testGrowthExperimentRefreshSchedule() {
    const events = [];
    let refreshes = 0;
    const scheduler = new DailyAutomation({}, {}, {
      experiments: {
        refreshDue: async () => {
          refreshes++;
          return { running: 2, refreshed: 1, failed: 0 };
        }
      }
    });
    scheduler.logAutomationEvent = async (type, status, data) => events.push({ type, status, data });
    await scheduler.refreshGrowthExperiments();
    if (refreshes !== 1 || !events.some(event =>
      event.type === 'growth_experiment_refresh' && event.status === 'success' && event.data.refreshed === 1
    )) {
      throw new Error('The scheduler did not refresh and record due controlled experiments');
    }
    const noService = new DailyAutomation({}, {}, {});
    await noService.refreshGrowthExperiments();
  }
}

// Run tests if called directly
if (require.main === module) {
  const tester = new SystemTest();
  tester.runAllTests()
    .then(success => process.exit(success ? 0 : 1))
    .catch(error => {
      console.error(chalk.red('Test runner failed:'), error);
      process.exit(1);
    });
}

module.exports = { SystemTest };
