const { google } = require('googleapis');
const { Logger } = require('../utils/logger');
const { ChannelLearningEngine } = require('../utils/channel-learning-engine');

class AnalyticsOptimizationAgent {
  constructor(db, credentials) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('AnalyticsOptimization');
    this.youtubeAnalytics = null;
    this.youtube = null;
    this.performanceData = new Map();
    this.learning = new ChannelLearningEngine(db);
  }

  async initialize() {
    this.logger.info('Initializing Analytics & Optimization Agent...');
    await this.setupAnalyticsAPI();
    await this.loadHistoricalData();
    return true;
  }

  async setupAnalyticsAPI() {
    try {
      const auth = this.credentials.getYouTubeAuth();
      this.youtubeAnalytics = google.youtubeAnalytics({ version: 'v2', auth });
      this.youtube = google.youtube({ version: 'v3', auth });
      this.logger.info('YouTube Analytics API initialized');
    } catch (error) {
      this.logger.error('Failed to initialize Analytics API:', error);
      throw error;
    }
  }

  async loadHistoricalData() {
    try {
      const history = await this.db.getAnalyticsHistory();
      history.forEach(record => {
        const normalized = {
          ...record,
          videoId: record.videoId || record.video_id,
          analyzedAt: record.analyzedAt || record.analyzed_at,
          performance: record.performance || {
            score: record.performance_score || 0,
            grade: record.performance_grade || 'N/A'
          }
        };
        this.performanceData.set(normalized.videoId, normalized);
      });
      this.logger.info(`Loaded ${this.performanceData.size} historical records`);
    } catch (error) {
      this.logger.warn('No historical analytics data found');
    }
  }

  async analyzeVideoPerformance(videoId, options = {}) {
    try {
      this.logger.info(`Analyzing performance for video: ${videoId}`);
      
      // Get video details
      const videoDetails = await this.getVideoDetails(videoId);
      
      const measurementWindow = options.measurementWindow || 'rolling';
      const period = this.learning.measurementPeriod(videoDetails.publishedAt, measurementWindow);

      // Get analytics data
      const channelStrategy = this.db.getChannelStrategy ? await this.db.getChannelStrategy() : null;
      const analytics = await this.getVideoAnalytics(videoId, period, {
        currency: channelStrategy?.outcome_currency || 'USD'
      });
      const context = await this.db.getPublishedContentContext(videoId);

      // Fetch the granular retention curve separately so its absence never
      // converts otherwise-real channel analytics into simulated data.
      const retention = analytics.available === false || analytics.simulated
        ? { available: false, simulated: false, reason: 'base_analytics_unavailable', points: [] }
        : await this.getAudienceRetention(videoId, period, videoDetails.duration);
      
      // Analyze thumbnail performance
      const thumbnailMetrics = await this.analyzeThumbnailPerformance(videoId, period);
      
      // Analyze title and SEO performance
      const seoMetrics = await this.analyzeSEOPerformance(videoDetails, analytics);
      
      // Generate insights and recommendations
      const insights = await this.generateInsights(videoDetails, analytics, thumbnailMetrics, seoMetrics);
      
      const performanceReport = {
        videoId,
        videoDetails,
        analytics,
        retention,
        thumbnailMetrics,
        seoMetrics,
        insights,
        performance: this.calculatePerformanceScore(analytics),
        measurementWindow,
        analyzedAt: new Date().toISOString()
      };
      
      // Store in performance data
      this.performanceData.set(videoId, performanceReport);
      
      // Save to database
      await this.db.saveAnalyticsReport(performanceReport);
      performanceReport.learningSnapshot = analytics.available === false
        ? null
        : await this.learning.capture(performanceReport, context, measurementWindow);
      if (analytics.available !== false && retention.available) {
        performanceReport.retentionSnapshot = await this.learning.captureRetention(
          {
            ...retention,
            videoId,
            title: videoDetails.title,
            publishedAt: videoDetails.publishedAt
          },
          context,
          measurementWindow,
          {
            views: analytics.views?.totalViews,
            impressions: analytics.views?.totalImpressions
          }
        );
      }
      
      this.logger.info(
        performanceReport.performance.score === null
          ? 'Analysis complete. Metrics stored without an absolute performance grade.'
          : `Analysis complete. Performance score: ${performanceReport.performance.score}/100`
      );
      return performanceReport;
    } catch (error) {
      this.logger.error(`Failed to analyze video ${videoId}:`, error);
      throw error;
    }
  }

  async getVideoDetails(videoId) {
    const response = await this.youtube.videos.list({
      part: 'snippet,statistics,contentDetails',
      id: videoId
    });
    
    if (!response.data.items.length) {
      throw new Error(`Video not found: ${videoId}`);
    }
    
    const video = response.data.items[0];
    return {
      id: videoId,
      title: video.snippet.title,
      description: video.snippet.description,
      tags: video.snippet.tags || [],
      publishedAt: video.snippet.publishedAt,
      duration: video.contentDetails.duration,
      statistics: {
        viewCount: parseInt(video.statistics.viewCount) || 0,
        likeCount: parseInt(video.statistics.likeCount) || 0,
        commentCount: parseInt(video.statistics.commentCount) || 0
      }
    };
  }

  async getVideoAnalytics(videoId, period = null, options = {}) {
    const endDate = period?.endDate || new Date().toISOString().split('T')[0];
    const startDate = period?.startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    
    try {
      // Get various analytics metrics
      const [
        viewsData,
        watchTimeData,
        demographicsData,
        trafficSourcesData,
        deviceData,
        outcomeData
      ] = await Promise.all([
        this.getViewsAnalytics(videoId, startDate, endDate),
        this.getWatchTimeAnalytics(videoId, startDate, endDate),
        this.getDemographicsAnalytics(videoId, startDate, endDate),
        this.getTrafficSourcesAnalytics(videoId, startDate, endDate),
        this.getDeviceAnalytics(videoId, startDate, endDate),
        this.getOutcomeAnalytics(videoId, startDate, endDate, options.currency || 'USD')
      ]);
      
      return {
        available: true,
        simulated: false,
        period: { startDate, endDate },
        views: viewsData,
        watchTime: watchTimeData,
        demographics: demographicsData,
        trafficSources: trafficSourcesData,
        devices: deviceData,
        outcomes: outcomeData,
        engagement: await this.calculateEngagementMetrics(videoId)
      };
    } catch (error) {
      this.logger.warn(`Analytics unavailable for ${videoId}: ${error.message}`);
      return this.getUnavailableAnalytics(videoId, error);
    }
  }

  async getViewsAnalytics(videoId, startDate, endDate) {
    const response = await this.youtubeAnalytics.reports.query({
      ids: 'channel==MINE',
      startDate,
      endDate,
      metrics: 'views,impressions,impressionClickThroughRate',
      dimensions: 'day',
      filters: `video==${videoId}`
    });
    
    return {
      totalViews: response.data.rows?.reduce((sum, row) => sum + row[1], 0) || 0,
      totalImpressions: response.data.rows?.reduce((sum, row) => sum + row[2], 0) || 0,
      averageCTR: this.calculateAverage(response.data.rows?.map(row => row[3]) || []),
      dailyData: response.data.rows || []
    };
  }

  async getWatchTimeAnalytics(videoId, startDate, endDate) {
    const response = await this.youtubeAnalytics.reports.query({
      ids: 'channel==MINE',
      startDate,
      endDate,
      metrics: 'estimatedMinutesWatched,averageViewDuration,averageViewPercentage',
      filters: `video==${videoId}`
    });
    
    const data = response.data.rows?.[0] || [0, 0, 0];
    
    return {
      totalWatchTime: data[0] || 0,
      averageViewDuration: data[1] || 0,
      averageViewPercentage: data[2] || 0,
      retentionQuality: this.assessRetentionQuality(data[2])
    };
  }

  async getDemographicsAnalytics(videoId, startDate, endDate) {
    try {
      const [ageResponse, genderResponse] = await Promise.all([
        this.youtubeAnalytics.reports.query({
          ids: 'channel==MINE',
          startDate,
          endDate,
          metrics: 'viewerPercentage',
          dimensions: 'ageGroup',
          filters: `video==${videoId}`
        }),
        this.youtubeAnalytics.reports.query({
          ids: 'channel==MINE',
          startDate,
          endDate,
          metrics: 'viewerPercentage',
          dimensions: 'gender',
          filters: `video==${videoId}`
        })
      ]);
      
      return {
        ageGroups: ageResponse.data.rows || [],
        gender: genderResponse.data.rows || [],
        primaryAudience: this.identifyPrimaryAudience(ageResponse.data.rows, genderResponse.data.rows)
      };
    } catch (error) {
      return this.getUnavailableDemographics(error);
    }
  }

  async getTrafficSourcesAnalytics(videoId, startDate, endDate) {
    const response = await this.youtubeAnalytics.reports.query({
      ids: 'channel==MINE',
      startDate,
      endDate,
      metrics: 'views',
      dimensions: 'insightTrafficSourceType',
      filters: `video==${videoId}`
    });
    
    const sources = response.data.rows || [];
    const totalViews = sources.reduce((sum, row) => sum + row[1], 0);
    
    return {
      sources: sources.map(row => ({
        source: row[0],
        views: row[1],
        percentage: ((row[1] / totalViews) * 100).toFixed(1)
      })),
      topSource: sources.length > 0 ? sources[0][0] : 'unknown',
      organicPercentage: this.calculateOrganicPercentage(sources)
    };
  }

  async getDeviceAnalytics(videoId, startDate, endDate) {
    const response = await this.youtubeAnalytics.reports.query({
      ids: 'channel==MINE',
      startDate,
      endDate,
      metrics: 'views',
      dimensions: 'deviceType',
      filters: `video==${videoId}`
    });
    
    const devices = response.data.rows || [];
    const totalViews = devices.reduce((sum, row) => sum + row[1], 0);
    
    return {
      devices: devices.map(row => ({
        device: row[0],
        views: row[1],
        percentage: ((row[1] / totalViews) * 100).toFixed(1)
      })),
      mobilePercentage: this.calculateMobilePercentage(devices)
    };
  }

  async getOutcomeAnalytics(videoId, startDate, endDate, currency = 'USD') {
    const query = (metrics, includeCurrency = false) => this.youtubeAnalytics.reports.query({
      ids: 'channel==MINE',
      startDate,
      endDate,
      metrics,
      filters: `video==${videoId}`,
      ...(includeCurrency ? { currency } : {})
    });
    const [subscriberResult, revenueResult] = await Promise.allSettled([
      query('subscribersGained,subscribersLost'),
      query('estimatedRevenue,monetizedPlaybacks,playbackBasedCpm', true)
    ]);
    const subscribers = subscriberResult.status === 'fulfilled'
      ? subscriberResult.value.data.rows?.[0] || [0, 0]
      : null;
    const revenue = revenueResult.status === 'fulfilled'
      ? revenueResult.value.data.rows?.[0] || [0, 0, 0]
      : null;
    if (!subscribers) this.logger.warn(`Subscriber outcomes unavailable for ${videoId}: ${subscriberResult.reason?.message || 'unknown error'}`);
    if (!revenue) this.logger.info(`Revenue outcomes unavailable for ${videoId}; monetization data will remain unavailable`);
    return {
      subscribersAvailable: Boolean(subscribers),
      subscribersGained: subscribers ? Number(subscribers[0] || 0) : null,
      subscribersLost: subscribers ? Number(subscribers[1] || 0) : null,
      netSubscribers: subscribers ? Number(subscribers[0] || 0) - Number(subscribers[1] || 0) : null,
      revenueAvailable: Boolean(revenue),
      currency: revenue ? currency : null,
      estimatedRevenue: revenue ? Number(revenue[0] || 0) : null,
      monetizedPlaybacks: revenue ? Number(revenue[1] || 0) : null,
      playbackBasedCpm: revenue ? Number(revenue[2] || 0) : null
    };
  }

  async calculateEngagementMetrics(videoId) {
    const videoDetails = await this.getVideoDetails(videoId);
    const stats = videoDetails.statistics;
    
    const views = stats.viewCount || 0;
    const likes = stats.likeCount || 0;
    const comments = stats.commentCount || 0;
    const interactions = likes + comments;
    const engagementRate = views > 0 ? (interactions / views) * 100 : 0;
    const likeRatio = interactions > 0 ? (likes / interactions) * 100 : 0;
    const commentsPerView = views > 0 ? (comments / views) * 100 : 0;
    
    return {
      engagementRate: parseFloat(engagementRate.toFixed(2)),
      likeRatio: parseFloat(likeRatio.toFixed(2)),
      commentsPerView: commentsPerView.toFixed(4),
      engagementQuality: this.assessEngagementQuality(engagementRate)
    };
  }

  async analyzeThumbnailPerformance(videoId, period = null) {
    // Analyze thumbnail click-through rate and impressions
    try {
      const response = await this.youtubeAnalytics.reports.query({
        ids: 'channel==MINE',
        startDate: period?.startDate || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        endDate: period?.endDate || new Date().toISOString().split('T')[0],
        metrics: 'impressions,impressionClickThroughRate',
        filters: `video==${videoId}`
      });
      
      const data = response.data.rows?.[0] || [0, 0];
      
      const ctr = data[1] || 0;
      
      return {
        impressions: data[0] || 0,
        clickThroughRate: ctr,
        ctrQuality: this.assessCTRQuality(ctr),
        recommendations: this.generateThumbnailRecommendations(ctr)
      };
    } catch (error) {
      return {
        impressions: 0,
        clickThroughRate: 0,
        ctrQuality: 'unknown',
        recommendations: ['Unable to analyze thumbnail performance']
      };
    }
  }

  async analyzeSEOPerformance(videoDetails, analytics) {
    const searchPerformance = this.analyzeSearchPerformance(analytics.trafficSources || { sources: [] });
    const metadataChecks = {
      titlePresent: Boolean(String(videoDetails.title || '').trim()),
      descriptionPresent: Boolean(String(videoDetails.description || '').trim()),
      tagCount: Array.isArray(videoDetails.tags) ? videoDetails.tags.length : 0
    };

    return {
      titleScore: null,
      descriptionScore: null,
      tagScore: null,
      overallSEOScore: null,
      metadataChecks,
      searchPerformance,
      interpretation: 'Search/discovery performance is contextual. Metadata is not graded with keyword-density or tag-count heuristics.',
      recommendations: this.generateSEORecommendations(metadataChecks, searchPerformance)
    };
  }

  async generateInsights(videoDetails, analytics, thumbnailMetrics, seoMetrics) {
    if (analytics.available === false) {
      return [{
        type: 'data_quality',
        category: 'analytics',
        message: 'YouTube Analytics data is unavailable for this measurement window.',
        impact: 'unknown',
        recommendation: 'Do not optimize Horror Stickman prompts from simulated or missing metrics. Retry when real channel data is available.'
      }];
    }

    const insights = [];
    const views = Number(analytics.views?.totalViews || 0);
    const impressions = Number(analytics.views?.totalImpressions || thumbnailMetrics?.impressions || 0);
    const ctr = Number(thumbnailMetrics?.clickThroughRate ?? analytics.views?.averageCTR ?? 0);
    const retention = Number(analytics.watchTime?.averageViewPercentage || 0);
    const avgDuration = Number(analytics.watchTime?.averageViewDuration || 0);
    const durationSeconds = this.parseISODurationSeconds(videoDetails?.duration);
    const completionContext = durationSeconds > 0 && avgDuration > 0
      ? Math.min(200, (avgDuration / durationSeconds) * 100)
      : null;
    const netSubscribers = analytics.outcomes?.netSubscribers;

    if (views > 0 && (retention > 0 || avgDuration > 0)) {
      insights.push({
        type: 'observation',
        category: 'shorts_retention',
        message: `Horror Short measured ${views} views, ${retention.toFixed(1)}% average viewed percentage, and ${Math.round(avgDuration)}s average view duration${completionContext !== null ? ` (~${completionContext.toFixed(1)}% of the ${durationSeconds}s runtime)` : ''}.`,
        impact: 'contextual',
        recommendation: 'Compare this Short against similar-length, comparable channel videos from the same traffic source where possible. Inspect the first 1-2 seconds, each escalation beat, and the final twist before changing the winning story structure.'
      });
    }

    if (Number.isFinite(Number(netSubscribers))) {
      insights.push({
        type: 'observation',
        category: 'subscriber_conversion',
        message: `This measurement window produced ${Number(netSubscribers)} net subscriber(s).`,
        impact: 'contextual',
        recommendation: 'Favor story families and hook/twist patterns that repeatedly convert viewers into subscribers, not one-off view spikes.'
      });
    }

    if (impressions > 0) {
      insights.push({
        type: 'observation',
        category: 'packaging',
        message: `${impressions} impressions produced a ${ctr.toFixed(2)}% CTR where thumbnail/impression surfaces applied.`,
        impact: 'contextual',
        recommendation: 'For Shorts, treat first-frame performance and retention as primary creative feedback; use CTR only on surfaces where impressions are actually relevant.'
      });
    }

    const searchPercentage = Number(seoMetrics?.searchPerformance?.searchPercentage || 0);
    if (searchPercentage > 0) {
      insights.push({
        type: 'observation',
        category: 'discovery',
        message: `YouTube Search accounts for ${searchPercentage.toFixed(1)}% of measured traffic.`,
        impact: 'contextual',
        recommendation: 'Keep metadata natural. Do not sacrifice fear/curiosity packaging for keyword density.'
      });
    }

    return insights;
  }

  calculatePerformanceScore(analytics) {
    if (analytics.available === false) {
      return {
        score: null,
        grade: 'unavailable',
        breakdown: {},
        reason: 'Real YouTube Analytics data is unavailable.'
      };
    }

    return {
      score: null,
      grade: 'context_required',
      breakdown: {
        views: Number(analytics.views?.totalViews || 0),
        impressions: Number(analytics.views?.totalImpressions || 0),
        ctr: Number(analytics.views?.averageCTR || 0),
        retention: Number(analytics.watchTime?.averageViewPercentage || 0),
        averageViewDuration: Number(analytics.watchTime?.averageViewDuration || 0),
        engagementRate: Number(analytics.engagement?.engagementRate || 0)
      },
      reason: 'Absolute grades are disabled. Compare against the channel baseline, traffic source, video age, format, and similar-length content.'
    };
  }

  // Helper methods
  calculateAverage(values) {
    if (!values.length) return 0;
    return values.reduce((sum, val) => sum + val, 0) / values.length;
  }

  assessRetentionQuality(percentage) {
    return Number.isFinite(Number(percentage)) ? 'context_required' : 'unavailable';
  }

  assessEngagementQuality(rate) {
    return Number.isFinite(Number(rate)) ? 'context_required' : 'unavailable';
  }

  assessCTRQuality(ctr) {
    return Number.isFinite(Number(ctr)) ? 'context_required' : 'unavailable';
  }

  analyzeSearchPerformance(trafficSources) {
    const searchSources = trafficSources.sources.filter(source => 
      ['SEARCH', 'YOUTUBE_SEARCH'].includes(source.source)
    );
    
    const searchPercentage = searchSources.reduce((sum, source) => 
      sum + parseFloat(source.percentage), 0
    );
    
    return {
      searchPercentage: Number.isFinite(searchPercentage) ? searchPercentage : null,
      searchQuality: 'context_required',
      organicDiscovery: null
    };
  }

  generateThumbnailRecommendations(_ctr) {
    return [
      'Evaluate title and thumbnail together with impressions, traffic source, watch time, and comparable channel videos.',
      'Use YouTube title/thumbnail experiments when a real packaging question is worth testing; do not optimize from CTR alone.'
    ];
  }

  generateSEORecommendations(metadataChecks, searchPerformance) {
    const recommendations = [];
    if (!metadataChecks?.titlePresent) recommendations.push('Add an accurate title before publishing.');
    if (!metadataChecks?.descriptionPresent) recommendations.push('Add a factual natural-language description before publishing.');
    if (searchPerformance?.searchPercentage === null) {
      recommendations.push('Wait for real discovery data before drawing conclusions about search performance.');
    }
    return recommendations;
  }

  // Unavailable-data methods. Never fabricate analytics when the API fails.
  getUnavailableAnalytics(_videoId, error = null) {
    return {
      available: false,
      simulated: false,
      error: error?.message || 'YouTube Analytics data unavailable',
      views: { totalViews: 0, totalImpressions: 0, averageCTR: 0, dailyData: [] },
      watchTime: { totalWatchTime: 0, averageViewDuration: 0, averageViewPercentage: 0, retentionQuality: 'unavailable' },
      demographics: this.getUnavailableDemographics(),
      trafficSources: { sources: [], topSource: null, organicPercentage: 0 },
      devices: { devices: [], mobilePercentage: null },
      engagement: { engagementRate: 0, likeRatio: 0, commentsPerView: '0.0000', engagementQuality: 'unavailable' },
      outcomes: {
        subscribersAvailable: false, subscribersGained: null, subscribersLost: null,
        netSubscribers: null, revenueAvailable: false, currency: null, estimatedRevenue: null,
        monetizedPlaybacks: null, playbackBasedCpm: null
      }
    };
  }

  getUnavailableDemographics(error = null) {
    return {
      available: false,
      ageGroups: [],
      gender: [],
      primaryAudience: null,
      reason: error?.message || 'Demographic data unavailable or limited'
    };
  }

  identifyPrimaryAudience(ageGroups, gender) {
    const topAge = ageGroups?.[0]?.[0] || '25-34';
    const topGender = gender?.[0]?.[0] || 'male';
    return `${topGender}s ${topAge}`;
  }

  calculateOrganicPercentage(sources) {
    const organicSources = ['SEARCH', 'YOUTUBE_SEARCH', 'SUGGESTED_VIDEO'];
    return sources
      .filter(row => organicSources.includes(row[0]))
      .reduce((sum, row) => sum + row[1], 0);
  }

  calculateMobilePercentage(devices) {
    const mobileDevices = devices.filter(row => 
      ['MOBILE', 'TABLET'].includes(row[0])
    );
    const total = devices.reduce((sum, row) => sum + row[1], 0);
    const mobile = mobileDevices.reduce((sum, row) => sum + row[1], 0);
    
    return total > 0 ? ((mobile / total) * 100).toFixed(1) : '0';
  }

  async getRecentAnalytics(days = 7) {
    const recentReports = Array.from(this.performanceData.values())
      .filter(report => {
        const reportDate = new Date(report.analyzedAt);
        const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        return reportDate > cutoffDate;
      })
      .sort((a, b) => new Date(b.analyzedAt) - new Date(a.analyzedAt));
    
    return {
      totalVideos: recentReports.length,
      averagePerformanceScore: this.calculateAverageScore(recentReports),
      topPerformers: recentReports.slice(0, 5),
      insights: this.generateChannelInsights(recentReports)
    };
  }

  async getAudienceRetention(videoId, period = null, isoDuration = null) {
    const endDate = period?.endDate || new Date().toISOString().split('T')[0];
    const startDate = period?.startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    try {
      const response = await this.youtubeAnalytics.reports.query({
        ids: 'channel==MINE',
        startDate,
        endDate,
        metrics: 'audienceWatchRatio,relativeRetentionPerformance,startedWatching,stoppedWatching,totalSegmentImpressions',
        dimensions: 'elapsedVideoTimeRatio',
        filters: `video==${videoId}`
      });
      const headers = (response.data.columnHeaders || []).map(header => header.name);
      const index = name => headers.indexOf(name);
      const value = (row, name) => {
        const position = index(name);
        return position >= 0 ? Number(row[position] || 0) : 0;
      };
      const points = (response.data.rows || []).map(row => ({
        elapsedRatio: value(row, 'elapsedVideoTimeRatio'),
        audienceWatchRatio: value(row, 'audienceWatchRatio'),
        relativeRetentionPerformance: value(row, 'relativeRetentionPerformance'),
        startedWatching: value(row, 'startedWatching'),
        stoppedWatching: value(row, 'stoppedWatching'),
        totalSegmentImpressions: value(row, 'totalSegmentImpressions')
      })).filter(point => point.elapsedRatio > 0);
      return {
        available: points.length > 0,
        simulated: false,
        reason: points.length ? null : 'no_retention_rows',
        period: { startDate, endDate },
        durationSeconds: this.parseISODurationSeconds(isoDuration),
        points
      };
    } catch (error) {
      this.logger.warn(`Audience retention curve unavailable for ${videoId}: ${error.message}`);
      return { available: false, simulated: false, reason: 'retention_api_unavailable', points: [] };
    }
  }

  parseISODurationSeconds(value) {
    const match = String(value || '').match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
    if (!match) return 0;
    return Number(match[1] || 0) * 86400 + Number(match[2] || 0) * 3600 + Number(match[3] || 0) * 60 + Number(match[4] || 0);
  }

  getLearningSummary() {
    return this.learning.getSummary();
  }

  getDueMeasurementWindows(video) {
    return this.learning.getDueMeasurementWindows(video);
  }

  calculateAverageScore(reports) {
    const scores = reports
      .map(report => Number(report.performance?.score))
      .filter(Number.isFinite);
    if (!scores.length) return null;
    return Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length);
  }

  generateChannelInsights(reports) {
    const realReports = reports.filter(report => report.analytics?.available !== false && !report.analytics?.simulated);
    if (!realReports.length) return [];

    return [
      `${realReports.length} real analytics report(s) are available for baseline-based learning. Use cross-video deltas and comparable formats instead of universal performance thresholds.`
    ];
  }
}

module.exports = { AnalyticsOptimizationAgent };
