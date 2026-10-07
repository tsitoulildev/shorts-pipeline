const cron = require('node-cron');
const { Logger } = require('../utils/logger');
const channelIdentity = require('../utils/channel-identity');
const { isLive, pruneOutput, sustainableCadence } = require('../utils/dark-history/live');
const { StoryPool } = require('../utils/dark-history/story-pool');

class DailyAutomation {
  constructor(agents, database, options = {}) {
    this.agents = agents;
    this.db = database;
    this.logger = new Logger('DailyAutomation');
    this.scheduledTasks = new Map();
    this.isEnabled = true;
    this.healthCheckInterval = null;
    this.lastHealthCheck = null;
    this.generateContent = options.generateContent || null;
    this.engagement = options.engagement || null;
    this.experiments = options.experiments || null;
    this.readiness = options.readiness || null;
    // Alert channel (OperatorService.notify: dashboard + Telegram, with dedupe). Optional; never blocks work.
    this.notify = options.notify || null;
    this.lastSkipReason = null;
    this.lastReadinessSelfHealAt = 0;
  }

  async initialize() {
    this.logger.info('Initializing daily automation scheduler...');
    
    await this.setupScheduledTasks();
    
    // Start monitoring loop
    this.startMonitoringLoop();
    
    this.logger.success('Daily automation initialized successfully');
    return true;
  }

  async setupScheduledTasks() {
    // Check the quality-gated Horror Shorts cadence every two hours.
    // The pacing gate (channel-identity target per day x 7, 21/week = 3/day), not cron frequency, decides whether a new Short is due.
    this.scheduledTasks.set('cadence-content-generation',
      cron.schedule('0 */2 * * *', async () => {
        if (this.isEnabled) {
          await this.runDailyContentGeneration();
        }
      }, { scheduled: false })
    );

    // Publishing queue processing every 15 minutes
    this.scheduledTasks.set('publish-queue-processing',
      cron.schedule('*/15 * * * *', async () => {
        if (this.isEnabled) {
          await this.processPublishQueue();
        }
      }, { scheduled: false })
    );

    // Analytics collection at 9:00 AM daily
    this.scheduledTasks.set('daily-analytics',
      cron.schedule('0 9 * * *', async () => {
        if (this.isEnabled) {
          await this.collectDailyAnalytics();
        }
      }, { scheduled: false })
    );

    // Weekly strategy review on Sundays at 8:00 AM
    this.scheduledTasks.set('weekly-strategy-review',
      cron.schedule('0 8 * * 0', async () => {
        if (this.isEnabled) {
          await this.weeklyStrategyReview();
        }
      }, { scheduled: false })
    );

    // Optimization tasks daily at 10:00 PM
    this.scheduledTasks.set('daily-optimization',
      cron.schedule('0 22 * * *', async () => {
        if (this.isEnabled) {
          await this.runDailyOptimization();
        }
      }, { scheduled: false })
    );

    // Daily database snapshot (not gated by isEnabled: a paused channel still needs its backup).
    this.scheduledTasks.set('database-backup',
      cron.schedule('20 3 * * *', async () => {
        await this.databaseBackup();
      }, { scheduled: false })
    );

    // Database maintenance weekly on Saturdays at 3:00 AM
    this.scheduledTasks.set('database-maintenance',
      cron.schedule('0 3 * * 6', async () => {
        if (this.isEnabled) {
          await this.databaseMaintenance();
        }
      }, { scheduled: false })
    );

    // Audience comment sync every 4 hours; the service's own taper decides which videos are due
    this.scheduledTasks.set('audience-engagement-sync',
      cron.schedule('0 */4 * * *', async () => {
        if (this.isEnabled) {
          await this.collectAudienceEngagement();
        }
      }, { scheduled: false })
    );

    // Collect controlled experiment evidence and advance only pre-approved arms.
    this.scheduledTasks.set('growth-experiment-refresh',
      cron.schedule('30 */4 * * *', async () => {
        if (this.isEnabled) {
          await this.refreshGrowthExperiments();
        }
      }, { scheduled: false })
    );

    // Refresh production readiness twice daily so the 24-hour publish gate
    // remains current without manual intervention.
    this.scheduledTasks.set('production-readiness-refresh',
      cron.schedule('15 */12 * * *', async () => {
        if (this.isEnabled) {
          await this.refreshProductionReadiness();
        }
      }, { scheduled: false })
    );

    // Start all scheduled tasks
    // Dark History story pool (off unless DARK_HISTORY_POOL_ENABLED=true; nothing in the fiction path reads it).
    // (Dark History live implies the refill: without it the pool would run dry.)
    if (process.env.DARK_HISTORY_POOL_ENABLED === 'true' || isLive()) {
      this.scheduledTasks.set('story-pool-refill',
        cron.schedule('15 */3 * * *', async () => {
          if (this.isEnabled) await this.refillStoryPool();
        }, { scheduled: false })
      );
    }

    this.scheduledTasks.forEach((task, name) => {
      task.start();
      this.logger.info(`Started scheduled task: ${name}`);
    });

    // A restart must not leave the data without a snapshot for a day.
    this.ensureRecentBackup().catch(() => {});
  }

  async runDailyContentGeneration() {
    try {
      this.logger.info('Starting daily content generation...');
      
      const timer = this.logger.startTimer('Daily Content Generation');
      
      // Check if we should generate content today
      const shouldGenerate = await this.shouldGenerateContentToday();
      
      if (!shouldGenerate) {
        this.logger.info(`Skipping content generation - ${this.lastSkipReason || 'not due yet'}`);
        return;
      }

      if (!this.generateContent) {
        const error = new Error('The scheduler is not connected to the canonical generation orchestrator; refusing to bypass agent contracts');
        error.code = 'ORCHESTRATOR_NOT_CONNECTED';
        throw error;
      }

      let job;
      try {
        job = await this.generateContent({ source: 'scheduler' });
      } catch (error) {
        // A readiness block is often stale data (a re-authorization fixed the login, but the stored result
        // still says invalid_grant). Re-run the check once (rate limited) and retry before alerting.
        if (error.code !== 'READINESS_BLOCKED' || !(await this.selfHealReadiness())) throw error;
        this.logger.info('Production readiness was blocked; the refreshed check passed, retrying generation');
        job = await this.generateContent({ source: 'scheduler' });
      }
      timer.end();
      this.logger.success(`Daily content generation queued: ${job.id}`);
      await this.logAutomationEvent('daily_content_generation', 'queued', { jobId: job.id });
    } catch (error) {
      this.logger.error('Daily content generation failed:', error);
      
      await this.logAutomationEvent('daily_content_generation', 'error', {
        error: error.message
      });

      // Send notification about failure
      await this.sendFailureNotification('Daily Content Generation', error);
    }
  }

  /**
   * Re-runs the production readiness check when the scheduler finds it blocked, at most once per
   * READINESS_SELF_HEAL_HOURS (default 6; each run makes a text and a narration probe call).
   * Returns true only when the refreshed result is usable.
   */
  async selfHealReadiness() {
    if (!this.readiness) return false;
    const minHours = Math.max(0, Number(process.env.READINESS_SELF_HEAL_HOURS || 6));
    if (this.lastReadinessSelfHealAt && Date.now() - this.lastReadinessSelfHealAt < minHours * 3600000) return false;
    this.lastReadinessSelfHealAt = Date.now();
    const result = await this.refreshProductionReadiness();
    return Boolean(result) && ['passed', 'warning'].includes(result.status) && !(result.blockingFailures || []).length;
  }

  /**
   * Safety net for any silent stall: the scheduler is on, a strategy is active, nothing is running, yet no
   * Short has reached review/approval for much longer than the pacing allows. Alerts once per 12 h.
   */
  async checkProductionStall() {
    if (!this.isEnabled || typeof this.notify !== 'function' || !this.db.getChannelStrategy) return null;
    const strategy = await this.db.getChannelStrategy();
    if (strategy?.status !== 'active') return null;
    const last = await this.db.getSetting('last_content_generation');
    if (!last) return null;
    const target = Math.max(1, Math.min(35, Number(strategy.cadence_per_week || ((channelIdentity.publishingCadence?.shortsPerDay?.target || 3) * 7))));
    const limitHours = Math.max(Number(process.env.PRODUCTION_STALL_HOURS || 16), 2 * (7 * 24) / target);
    const hours = (Date.now() - new Date(last).getTime()) / 3600000;
    if (!(hours >= limitHours)) return null;
    const busy = await this.db.getAllRows("SELECT 1 AS busy FROM generation_jobs WHERE status IN ('queued', 'running') LIMIT 1");
    if (busy.length) return null;
    await this.notify({
      type: 'production_stalled',
      level: 'warning',
      title: `No new Short for ${Math.floor(hours)} hours`,
      message: `The scheduler is on and a strategy is active, but no Short has reached review or approval for ${Math.floor(hours)} hours (alert limit ${Math.round(limitHours)} h) and nothing is running. Check /api/readiness and the journal (journalctl -u youtube-agent).`,
      data: { hours: Math.floor(hours), limitHours: Math.round(limitHours) },
      dedupeKey: 'production_stalled',
      dedupeMinutes: 720
    });
    return { hours, limitHours };
  }

  async shouldGenerateContentToday() {
    this.lastSkipReason = null;
    const channelStrategy = this.db.getChannelStrategy ? await this.db.getChannelStrategy() : null;
    if (channelStrategy?.status === 'active') {
      let target = Math.max(1, Math.min(35, Number(channelStrategy.cadence_per_week || ((channelIdentity.publishingCadence?.shortsPerDay?.target || 3) * 7))));
      if (isLive()) {
        // Dark History: the cadence never outruns the story pool. The ready stories are spread over 14 days; an empty pool makes nothing.
        this.storyPool = this.storyPool || new StoryPool(this.db);
        const sustainable = await sustainableCadence(this.storyPool, target);
        if (sustainable.perWeek < 1) {
          this.lastSkipReason = 'the Dark History story pool is empty (0 stories ready); the refill job is researching more';
          return false;
        }
        target = sustainable.perWeek;
      }
      const weeklyRows = await this.db.getAllRows(
        `SELECT details FROM generation_jobs
         WHERE status = 'completed'
         AND created_at >= datetime('now', '-7 days')`
      );
      const completed = weeklyRows.filter(row => {
        try {
          const details = typeof row.details === 'string' ? JSON.parse(row.details || '{}') : (row.details || {});
          return ['needs_review', 'approved'].includes(details.reviewStatus);
        } catch (_error) {
          return false;
        }
      }).length;
      if (completed >= target) {
        this.lastSkipReason = `weekly target reached (${completed}/${target} Shorts in the last 7 days)`;
        return false;
      }

      const lastGeneration = await this.db.getSetting('last_content_generation');
      if (!lastGeneration) return true;

      const elapsedHours = (Date.now() - new Date(lastGeneration).getTime()) / 3600000;
      const pacingHours = (7 * 24) / target;
      if (elapsedHours < pacingHours) {
        this.lastSkipReason = `pacing: next Short is due in ${(pacingHours - elapsedHours).toFixed(1)} h (one every ${pacingHours.toFixed(1)} h)`;
        return false;
      }
      return true;
    }

    // Scheduled autonomous generation is fail-closed unless the operator has
    // explicitly activated a channel strategy. Manual generation remains
    // available through the protected API, but the scheduler must never fall
    // back to an implicit one-video-per-day mode.
    this.lastSkipReason = `the channel strategy is not active (status: ${channelStrategy?.status || 'none'})`;
    return false;
  }

  async processPublishQueue() {
    try {
      const published = await this.agents.publishing.processPublishQueue();
      
      if (published > 0) {
        this.logger.info(`Published ${published} videos from queue`);
        
        await this.logAutomationEvent('queue_processing', 'success', {
          publishedCount: published
        });
      }
    } catch (error) {
      this.logger.error('Failed to process publish queue:', error);
      
      await this.logAutomationEvent('queue_processing', 'error', {
        error: error.message
      });
      await this.sendFailureNotification('Publishing Queue', error);
    }
  }

  async refreshProductionReadiness() {
    if (!this.readiness) return null;
    try {
      const result = await this.readiness.run({
        includePaidMedia: false,
        includePaidVideo: false
      });
      const blocked = !['passed', 'warning'].includes(result.status) || (result.blockingFailures || []).length > 0;
      await this.logAutomationEvent('production_readiness_refresh', blocked ? 'warning' : 'success', {
        readinessStatus: result.status,
        blockingFailures: result.blockingFailures || []
      });
      if (blocked) {
        this.logger.warn(`Production readiness refresh is blocking: ${(result.blockingFailures || []).join(', ') || result.status}`);
      }
      return result;
    } catch (error) {
      this.logger.error('Production readiness refresh failed:', error);
      await this.logAutomationEvent('production_readiness_refresh', 'error', { error: error.message });
      return null;
    }
  }

  async collectDailyAnalytics() {
    try {
      this.logger.info('Starting daily analytics collection...');
      
      // Keep a 30-day catch-up window so new installs can backfill 24-hour and 7-day evidence.
      const recentVideos = await this.getRecentlyPublishedVideos(30);
      
      let processedCount = 0;
      let unavailableCount = 0;
      let lastUnavailableReason = null;
      
      for (const video of recentVideos) {
        try {
          const windows = await this.agents.analytics.getDueMeasurementWindows(video);
          for (const measurementWindow of windows) {
            const report = await this.agents.analytics.analyzeVideoPerformance(video.youtube_id, { measurementWindow });
            // "Unavailable" (revoked login, missing scope, 403) used to be counted as captured evidence and logged
            // as success, so the learning loop could stay empty for weeks behind a green status.
            if (report?.analytics?.available === false) {
              unavailableCount++;
              lastUnavailableReason = report.analytics.error || lastUnavailableReason;
              this.logger.warn(`No analytics data for ${video.title} (${measurementWindow}): ${report.analytics.error || 'unavailable'}`);
              continue;
            }
            processedCount++;
            this.logger.info(`Captured ${measurementWindow} learning evidence for: ${video.title}`);

            // Small delay to avoid API rate limits
            await this.sleep(2000);
          }
        } catch (error) {
          this.logger.error(`Failed to analyze video ${video.youtube_id}:`, error);
        }
      }

      if (unavailableCount > 0 && processedCount === 0) {
        // Nothing was learned: say so (log event, owner alert once per cause) instead of "completed".
        const error = new Error(`YouTube Analytics returned no data for ${unavailableCount} measurement(s): ${lastUnavailableReason || 'unavailable'}`);
        this.logger.error(error.message);
        await this.logAutomationEvent('analytics_collection', 'error', { error: error.message, unavailable: unavailableCount });
        await this.sendFailureNotification('Analytics Collection', error);
        return;
      }

      this.logger.success(`Analytics collection completed. Processed ${processedCount} videos${unavailableCount ? `, ${unavailableCount} without data` : ''}`);
      
      await this.logAutomationEvent('analytics_collection', 'success', {
        videosProcessed: processedCount,
        unavailable: unavailableCount
      });

    } catch (error) {
      this.logger.error('Daily analytics collection failed:', error);
      
      await this.logAutomationEvent('analytics_collection', 'error', {
        error: error.message
      });
      await this.sendFailureNotification('Analytics Collection', error);
    }
  }

  async collectAudienceEngagement() {
    if (!this.engagement) return;
    try {
      this.logger.info('Starting audience comment sync...');
      const recentVideos = await this.getRecentlyPublishedVideos(30);
      const results = await this.engagement.syncDueVideos(recentVideos.map(video => ({
        youtubeId: video.youtube_id,
        title: video.title,
        publishedAt: video.published_at,
        productionId: video.production_id || null
      })));
      this.logger.success(`Audience engagement sync completed: ${results.synced} synced, ${results.skipped} skipped, ${results.failed} failed`);
      await this.logAutomationEvent('audience_engagement_sync', 'success', results);
    } catch (error) {
      this.logger.error('Audience engagement sync failed:', error);
      await this.logAutomationEvent('audience_engagement_sync', 'error', { error: error.message });
    }
  }

  async refreshGrowthExperiments() {
    if (!this.experiments) return;
    try {
      const result = await this.experiments.refreshDue();
      if (result.refreshed || result.failed) {
        await this.logAutomationEvent('growth_experiment_refresh', result.failed ? 'warning' : 'success', result);
      }
    } catch (error) {
      this.logger.error('Growth experiment refresh failed:', error);
      await this.logAutomationEvent('growth_experiment_refresh', 'error', { error: error.message });
    }
  }

  async weeklyStrategyReview() {
    try {
      this.logger.info('Starting weekly strategy review...');
      
      // Analyze performance of last week's content
      const weeklyAnalytics = await this.agents.analytics.getRecentAnalytics(7);
      
      // Update content strategy based on performance
      if (weeklyAnalytics.topPerformers.length > 0) {
        const bestPerformingTopics = weeklyAnalytics.topPerformers
          .map(video => video.videoDetails.title)
          .slice(0, 3);
        
        this.logger.info(`Top performing topics: ${bestPerformingTopics.join(', ')}`);
      }

      // Optimize publishing times
      await this.agents.publishing.optimizePublishTimes();
      
      // Generate strategy insights
      const insights = await this.generateWeeklyInsights(weeklyAnalytics);
      
      this.logger.success('Weekly strategy review completed');
      
      await this.logAutomationEvent('weekly_strategy_review', 'success', {
        insights
      });

    } catch (error) {
      this.logger.error('Weekly strategy review failed:', error);
      
      await this.logAutomationEvent('weekly_strategy_review', 'error', {
        error: error.message
      });
    }
  }

  async runDailyOptimization() {
    try {
      this.logger.info('Starting daily maintenance tasks...');
      await this.cleanupOldFiles();
      this.logger.success('Daily maintenance completed');
      await this.logAutomationEvent('daily_optimization', 'success', {
        policy: 'No automatic SEO rewrites, keyword tuning, or low-score content mutation.'
      });
    } catch (error) {
      this.logger.error('Daily maintenance failed:', error);
      await this.logAutomationEvent('daily_optimization', 'error', { error: error.message });
    }
  }

  /** Researches Dark History stories until the pool holds 14 days of content; alerts (Telegram) when it is low. */
  async refillStoryPool() {
    try {
      const { StoryPool } = require('../utils/dark-history/story-pool');
      const { refillPool } = require('../utils/dark-history/pool-refill');
      const { makeLlmJudge } = require('../utils/dark-history/relevance-judge');
      const path = require('path');
      const strategy = (this.db.getChannelStrategy ? await this.db.getChannelStrategy() : null) || {};
      const perWeek = Math.max(1, Math.min(35, Number(strategy.cadence_per_week || ((channelIdentity.publishingCadence?.shortsPerDay?.target || 3) * 7))));
      this.storyPool = this.storyPool || new StoryPool(this.db);
      const llm = this.agents.strategy?.aiTextService;
      const result = await refillPool({
        pool: this.storyPool, judge: llm ? makeLlmJudge(llm) : null, notify: this.notify, perWeek,
        imageDir: path.join(__dirname, '..', 'data', 'story-pool'), logger: this.logger
      });
      this.logger.info(`Story pool: ${result.ready} ready (${result.days.toFixed(1)} days), researched ${result.researched}`);
      return result;
    } catch (error) {
      this.logger.error(`Story pool refill failed: ${error.message}`);
      return null;
    }
  }

  async databaseBackup() {
    try {
      const backupPath = await this.db.backup();
      await this.logAutomationEvent('database_backup', 'success', { backupPath });
      return backupPath;
    } catch (error) {
      this.logger.error('Daily database backup failed:', error);
      await this.logAutomationEvent('database_backup', 'error', { error: error.message });
      try { await this.sendFailureNotification('Database Backup', error); } catch (notifyError) { /* alert is best effort */ }
      return null;
    }
  }

  async ensureRecentBackup() {
    const age = await this.db.latestBackupAgeMs();
    if (age === null || age > 24 * 60 * 60 * 1000) return this.databaseBackup();
    return null;
  }

  async databaseMaintenance() {
    try {
      this.logger.info('Starting database maintenance...');
      
      // Create backup
      const backupPath = await this.db.backup();
      this.logger.info(`Database backed up to: ${backupPath}`);
      
      // Get database stats
      const stats = await this.db.getStats();
      this.logger.info(`Database stats: ${JSON.stringify(stats)}`);
      
      // Clean old analytics data (older than 90 days)
      await this.cleanOldAnalytics();
      
      this.logger.success('Database maintenance completed');
      
      await this.logAutomationEvent('database_maintenance', 'success', {
        backupPath,
        stats
      });

    } catch (error) {
      this.logger.error('Database maintenance failed:', error);
      
      await this.logAutomationEvent('database_maintenance', 'error', {
        error: error.message
      });
    }
  }

  // Helper methods
  async getRecentlyPublishedVideos(days) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    
    const rows = await this.db.getAllRows(
      `SELECT * FROM publish_schedule 
       WHERE status = 'published' AND published_at > ?
       ORDER BY published_at DESC`,
      [cutoffDate.toISOString()]
    );
    
    return rows;
  }

  async generateWeeklyInsights(analytics) {
    const insights = [];
    const totalVideos = Number(analytics.totalVideos || 0);
    if (!totalVideos) {
      insights.push('No real analytics reports are available yet; keep the current strategy unchanged.');
      return insights;
    }
    insights.push(`${totalVideos} recent video analytics report(s) are available for evidence-based comparison.`);
    if (Array.isArray(analytics.insights)) insights.push(...analytics.insights);
    return insights;
  }

  async updateKeywordPerformance() {
    this.logger.info('Automatic keyword-performance tuning is disabled; discovery learning uses real traffic-source evidence.');
    return [];
  }

  async cleanupOldFiles() {
    // Clean up temporary files older than 7 days
    const path = require('path');
    
    const tempDir = path.join(__dirname, '..', 'temp');
    const uploadsDir = path.join(__dirname, '..', 'uploads');
    
    try {
      await this.cleanDirectoryOldFiles(tempDir, 7);
      await this.cleanDirectoryOldFiles(uploadsDir, 30);
      const removed = pruneOutput();
      if (removed) this.logger.info(`Removed ${removed} old Dark History output folder(s)`);
      this.logger.info('Old files cleaned up');
    } catch (error) {
      this.logger.error('Failed to clean up old files:', error);
    }
  }

  async cleanDirectoryOldFiles(directory, days) {
    const fs = require('fs').promises;
    const path = require('path');
    
    try {
      const files = await fs.readdir(directory);
      const cutoffTime = Date.now() - (days * 24 * 60 * 60 * 1000);
      
      for (const file of files) {
        const filePath = path.join(directory, file);
        const stats = await fs.stat(filePath);
        
        if (stats.mtime.getTime() < cutoffTime) {
          await fs.unlink(filePath);
        }
      }
    } catch (error) {
      // Directory might not exist, which is fine
    }
  }

  async cleanOldAnalytics() {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 90);
    
    await this.db.executeQuery(
      'DELETE FROM analytics_reports WHERE analyzed_at < ?',
      [cutoffDate.toISOString()]
    );
  }

  async logAutomationEvent(eventType, status, data = {}) {
    await this.db.executeQuery(
      'INSERT INTO automation_events (event_type, status, data, created_at) VALUES (?, ?, ?, datetime("now"))',
      [eventType, status, JSON.stringify(data)]
    );
  }

  async sendFailureNotification(taskName, error) {
    this.logger.error(`AUTOMATION FAILURE - ${taskName}: ${error.message}`);
    // Through OperatorService.notify so the owner is reached on Telegram (a bare createNotification never was).
    // A failure that repeats on every scheduler tick alerts once per cause per 6 h.
    const notification = {
      type: 'automation_failure',
      level: 'error',
      title: `${taskName} failed`,
      message: error.message,
      dedupeKey: `automation_failure:${taskName}:${String(error.code || error.message).slice(0, 60)}`,
      dedupeMinutes: 360
    };
    try {
      if (typeof this.notify === 'function') await this.notify(notification);
      else if (this.db.createNotification) await this.db.createNotification(notification);
    } catch (notifyError) {
      this.logger.warn(`Failure alert could not be delivered: ${notifyError.message}`);
    }
  }

  startMonitoringLoop() {
    // Monitor system health every hour
    this.healthCheckInterval = setInterval(async () => {
      try {
        await this.performHealthCheck();
      } catch (error) {
        this.logger.error('Health check failed:', error);
      }
    }, 60 * 60 * 1000); // 1 hour
  }

  async performHealthCheck() {
    this.lastHealthCheck = new Date();

    const health = {
      timestamp: new Date().toISOString(),
      database: false,
      agents: {},
      scheduledTasks: {},
      systemResources: {}
    };

    // Check database
    try {
      await this.db.getAllRows('SELECT 1');
      health.database = true;
    } catch (error) {
      health.database = false;
    }

    // Check scheduled tasks
    this.scheduledTasks.forEach((task, name) => {
      health.scheduledTasks[name] = task.running;
    });

    // Get system resources (simplified)
    health.systemResources = {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      nodeVersion: process.version
    };

    // Silent-stall watchdog; it must never break the health check itself.
    try {
      health.productionStall = await this.checkProductionStall();
    } catch (error) {
      this.logger.warn(`Production stall check failed: ${error.message}`);
    }

    // Log health status
    const healthScore = this.calculateHealthScore(health);
    
    if (healthScore < 80) {
      this.logger.warn(`System health score: ${healthScore}/100`, health);
    } else {
      this.logger.info(`System health check passed: ${healthScore}/100`);
    }
    
    return health;
  }

  calculateHealthScore(health) {
    let score = 100;
    
    if (!health.database) score -= 30;
    
    const tasksRunning = Object.values(health.scheduledTasks).filter(Boolean).length;
    const totalTasks = Object.keys(health.scheduledTasks).length;
    
    if (totalTasks > 0 && tasksRunning < totalTasks) {
      score -= ((totalTasks - tasksRunning) / totalTasks) * 20;
    }
    
    return Math.max(0, Math.round(score));
  }

  // Control methods
  async pauseAutomation() {
    this.isEnabled = false;
    this.logger.info('Automation paused');
  }

  async resumeAutomation() {
    this.isEnabled = true;
    this.logger.info('Automation resumed');
  }

  async stopAutomation() {
    this.scheduledTasks.forEach((task, name) => {
      task.stop();
      this.logger.info(`Stopped scheduled task: ${name}`);
    });
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    this.isEnabled = false;
    this.logger.info('All automation tasks stopped');
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

}

module.exports = { DailyAutomation };
