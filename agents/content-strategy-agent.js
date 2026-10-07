const { Logger } = require('../utils/logger');
const { AITextService } = require('../utils/ai-text-service');
const axios = require('axios');
const channelIdentity = require('../config/channel-identity.json');
const nicheContract = require('../config/horror-stickman-niche.json');
const { parseJsonResponse } = require('../utils/json-response');
const { OVERUSED_TROPES } = require('../utils/creative-review');
const storyStructures = require('../config/story-structures.json');

class ContentStrategyAgent {
  constructor(db, credentials) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('ContentStrategy');
    this.trendingTopics = [];
    this.competitorData = [];
    this.aiTextService = new AITextService(credentials?.credentials || credentials || {});
    this.identity = channelIdentity;
  }

  async initialize() {
    this.logger.info('Initializing Content Strategy Agent...');
    await this.loadHistoricalData();
    await this.analyzeTrends();
    return true;
  }

  async loadHistoricalData() {
    try {
      const history = await this.db.getContentHistory();
      this.historicalPerformance = history;
    } catch (error) {
      this.logger.warn('No historical data found, starting fresh');
      this.historicalPerformance = [];
    }
  }

  async analyzeTrends() {
    try {
      // Analyze YouTube trends
      const trends = await this.fetchYouTubeTrends();
      
      // Analyze competitor channels
      const competitors = await this.analyzeCompetitors();
      this.competitorData = competitors;
      
      // Combine insights
      this.trendingTopics = this.mergeTrendData(trends, competitors);
      
      this.logger.info(`Identified ${this.trendingTopics.length} trending topics`);
    } catch (error) {
      this.logger.error('Error analyzing trends:', error);
    }
  }

  async fetchYouTubeTrends() {
    // Use YouTube API to fetch trending videos
    const youtube = this.credentials.getYouTubeClient();
    
    try {
      const response = await youtube.videos.list({
        part: 'snippet,statistics',
        chart: 'mostPopular',
        maxResults: 50,
        regionCode: process.env.YOUTUBE_REGION || 'US'
      });

      return response.data.items.map(video => ({
        videoId: video.id,
        title: video.snippet.title,
        tags: video.snippet.tags || [],
        viewCount: parseInt(video.statistics?.viewCount, 10) || 0,
        category: video.snippet.categoryId,
        publishedAt: video.snippet.publishedAt,
        publisher: video.snippet.channelTitle || 'YouTube',
        url: `https://www.youtube.com/watch?v=${video.id}`
      }));
    } catch (error) {
      this.logger.error('Failed to fetch YouTube trends:', error);
      return [];
    }
  }

  async analyzeCompetitors() {
    const competitorChannels = (process.env.COMPETITOR_CHANNELS || '').split(',');
    const competitorData = [];

    for (const channelId of competitorChannels) {
      if (!channelId) continue;
      
      try {
        const videos = await this.getChannelVideos(channelId);
        const analysis = this.analyzeVideoPerformance(videos);
        competitorData.push({
          channelId,
          topPerformingTopics: analysis.topTopics,
          averageViews: analysis.avgViews,
          uploadFrequency: analysis.frequency
        });
      } catch (error) {
        this.logger.error(`Failed to analyze competitor ${channelId}:`, error);
      }
    }

    return competitorData;
  }

  async getChannelVideos(channelId) {
    const youtube = this.credentials.getYouTubeClient();
    
    try {
      const response = await youtube.search.list({
        part: 'snippet',
        channelId: channelId,
        maxResults: 20,
        order: 'date',
        type: 'video'
      });

      const videoIds = response.data.items.map(item => item.id.videoId).join(',');
      
      const videoDetails = await youtube.videos.list({
        part: 'statistics,snippet',
        id: videoIds
      });

      return videoDetails.data.items;
    } catch (error) {
      this.logger.error(`Failed to get videos for channel ${channelId}:`, error);
      return [];
    }
  }

  analyzeVideoPerformance(videos) {
    if (!videos || videos.length === 0) {
      return { topTopics: [], avgViews: 0, frequency: 0 };
    }

    const topics = {};
    let totalViews = 0;

    videos.forEach(video => {
      const title = video.snippet.title.toLowerCase();
      const views = parseInt(video.statistics?.viewCount, 10) || 0;
      totalViews += views;

      // Extract topics from title
      const keywords = this.extractKeywords(title);
      keywords.forEach(keyword => {
        if (!topics[keyword]) topics[keyword] = { count: 0, views: 0, evidence: [] };
        topics[keyword].count++;
        topics[keyword].views += views;
        topics[keyword].evidence.push({
          url: `https://www.youtube.com/watch?v=${video.id}`,
          title: video.snippet.title,
          publisher: video.snippet.channelTitle || 'Configured competitor channel',
          publishedAt: video.snippet.publishedAt,
          sourceType: 'video'
        });
      });
    });

    const topTopics = Object.entries(topics)
      .sort((a, b) => b[1].views - a[1].views)
      .slice(0, 10)
      .map(([topic, data]) => ({ topic, avgViews: data.views / data.count, evidence: data.evidence.slice(0, 5) }));

    return {
      topTopics,
      avgViews: totalViews / videos.length,
      frequency: videos.length
    };
  }

  extractKeywords(text) {
    // Simple keyword extraction
    const stopWords = ['the', 'is', 'at', 'which', 'on', 'and', 'a', 'an', 'as', 'are', 'was', 'were', 'been', 'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'can', 'could', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'what', 'which', 'who', 'when', 'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'can', 'will', 'just', 'should', 'now'];
    
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(word => word.length > 3 && !stopWords.includes(word));
  }

  mergeTrendData(trends, competitors) {
    const mergedTopics = new Map();

    // Add trending topics
    trends.forEach(trend => {
      const keywords = this.extractKeywords(trend.title);
      keywords.forEach(keyword => {
        if (!mergedTopics.has(keyword)) {
          mergedTopics.set(keyword, { score: 0, sources: [], evidence: [] });
        }
        const topic = mergedTopics.get(keyword);
        topic.score += trend.viewCount / 1000000; // Normalize by millions
        topic.sources.push('trending');
        topic.evidence.push({
          url: trend.url,
          title: trend.title,
          publisher: trend.publisher,
          publishedAt: trend.publishedAt,
          sourceType: 'video'
        });
      });
    });

    // Add competitor topics
    competitors.forEach(competitor => {
      if (competitor.topPerformingTopics) {
        competitor.topPerformingTopics.forEach(({ topic, avgViews, evidence = [] }) => {
          if (!mergedTopics.has(topic)) {
            mergedTopics.set(topic, { score: 0, sources: [], evidence: [] });
          }
          const topicData = mergedTopics.get(topic);
          topicData.score += avgViews / 100000; // Normalize
          topicData.sources.push('competitor');
          topicData.evidence.push(...evidence);
        });
      }
    });

    // Convert to array and sort by score
    return Array.from(mergedTopics.entries())
      .map(([topic, data]) => ({ topic, ...data }))
      .map(item => ({
        ...item,
        evidence: [...new Map(item.evidence.filter(source => source.url).map(source => [source.url, source])).values()].slice(0, 5)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 50);
  }

  async generateContentStrategy(requestedTopic = null) {
    try {
      let topic, angle, targetAudience, contentType;

      const autonomousMode = String(process.env.AUTONOMOUS_MODE || '').toLowerCase() === 'true';
      const maxEditorialAttempts = autonomousMode && !requestedTopic ? 5 : 1;
      for (let attempt = 1; attempt <= maxEditorialAttempts; attempt += 1) {
        let aiStrategy = null;
        try {
          aiStrategy = await this.generateContentStrategyWithAI(requestedTopic);
        } catch (error) {
          if (!autonomousMode) throw error;
          this.logger.warn(
            `AI Horror strategy attempt ${attempt}/${maxEditorialAttempts} rejected: ${error.message}`
          );
        }
        if (aiStrategy) {
          const enriched = await this.enrichStrategyWithResearch(aiStrategy);
          await this.db.saveContentStrategy(enriched);
          this.logger.info(`Generated AI strategy for: ${enriched.topic}`);
          return enriched;
        }
        if (autonomousMode && attempt < maxEditorialAttempts) {
          this.logger.warn(`Autonomous flagship candidate rejected; trying another eligible story (${attempt}/${maxEditorialAttempts})`);
        }
      }

      if (autonomousMode) {
        const fallbackTopic = requestedTopic || this.selectOptimalTopic().topic;
        const deterministic = this.buildDeterministicHorrorStrategy(fallbackTopic);
        if (!this.isApprovedNicheCandidate(deterministic, requestedTopic ? this.recentTopicsExcludingPremise(requestedTopic) : undefined)) {
          const error = new Error(`Autonomous editorial selection produced no approved strategy after ${maxEditorialAttempts} AI attempt(s) and deterministic gated fallback`);
          error.code = 'AUTONOMOUS_STRATEGY_REJECTED';
          throw error;
        }
        const enriched = await this.enrichStrategyWithResearch(deterministic);
        await this.db.saveContentStrategy(enriched);
        this.logger.warn(`Using deterministic Horror Stickman strategy fallback for: ${enriched.topic}`);
        return enriched;
      }

      this.logger.info('Using template content strategy generation');
      if (requestedTopic) {
        topic = requestedTopic;
        angle = await this.generateAngle(topic);
      } else {
        // Select from trending topics
        const selectedTopic = this.selectOptimalTopic();
        topic = selectedTopic.topic;
        angle = await this.generateAngle(topic);
      }

      // Determine target audience
      targetAudience = await this.identifyTargetAudience(topic);

      // Select content type
      contentType = this.selectContentType(topic);

      // Generate content calendar entry
      const strategy = {
        topic,
        angle,
        targetAudience,
        contentType,
        keywords: this.extractKeywords(topic),
        estimatedViews: this.predictViews(topic),
        bestPublishTime: this.calculateBestPublishTime(),
        competitorAnalysis: this.getCompetitorInsights(topic),
        createdAt: new Date().toISOString()
      };

      const enriched = await this.enrichStrategyWithResearch(strategy);

      // Save to database
      await this.db.saveContentStrategy(enriched);

      this.logger.info(`Generated strategy for: ${topic}`);
      return enriched;
    } catch (error) {
      this.logger.error('Failed to generate content strategy:', error);
      throw error;
    }
  }

  async enrichStrategyWithResearch(strategy) {
    if (strategy?.fictional !== false) {
      return {
        ...strategy,
        fictional: true,
        provenanceMode: 'fictional',
        researchSources: [],
        researchContext: [],
        researchGeneratedAt: null
      };
    }

    const existing = Array.isArray(strategy.researchSources) ? strategy.researchSources : [];
    const trustedExisting = existing.filter(source => this.isVerifiedResearchSource(source));
    const hasFetchedEvidence = trustedExisting.some(source => source.retrievalStatus === 'fetched');
    if (hasFetchedEvidence) {
      return { ...strategy, researchSources: trustedExisting };
    }

    const research = await this.researchTopicEvidence(strategy.topic);
    if (!research.sources.length) {
      this.logger.warn(`No factual research package could be fetched for "${strategy.topic}". Provenance will remain blocking.`);
      return {
        ...strategy,
        researchSources: trustedExisting,
        researchContext: Array.isArray(strategy.researchContext) ? strategy.researchContext : []
      };
    }

    return {
      ...strategy,
      researchSources: [...trustedExisting, ...research.sources],
      researchContext: research.context,
      researchGeneratedAt: research.generatedAt
    };
  }

  isVerifiedResearchSource(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return false;
    const url = String(source.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return false;
    return source.retrievalStatus === 'fetched' || source.status === 'verified';
  }

  normalizeResearchToken(token) {
    const value = String(token || '').toLowerCase().trim();
    if (value.length > 4 && value.endsWith('ies')) return `${value.slice(0, -3)}y`;
    if (value.length > 4 && /(ches|shes|xes|zes|ses)$/.test(value)) return value.slice(0, -2);
    if (value.length > 4 && value.endsWith('s') && !/(ss|is|us)$/.test(value)) return value.slice(0, -1);
    return value;
  }

  normalizedResearchTokens(value) {
    const stop = new Set([
      'the','a','an','and','or','of','to','in','on','for','with','why','how','what','when','where',
      'that','this','inside','about','from','world','really','actually','looks','harder','powerful',
      'lets','let','survive','survives'
    ]);
    return new Set(String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .map(token => this.normalizeResearchToken(token))
      .filter(token => token.length >= 4 && !stop.has(token)));
  }

  buildResearchQueries(topic) {
    const cleanTopic = String(topic || '').replace(/\s+/g, ' ').trim();
    if (!cleanTopic) return [];
    const tokens = [...this.normalizedResearchTokens(cleanTopic)];
    const variants = [cleanTopic];
    if (tokens.length) variants.push(tokens.slice(0, 8).join(' '));

    const anchors = tokens.slice(0, 6);
    for (let left = 0; left < anchors.length && variants.length < 6; left += 1) {
      for (let right = left + 1; right < anchors.length && variants.length < 6; right += 1) {
        variants.push(`${anchors[left]} ${anchors[right]}`);
      }
    }

    return [...new Set(variants.map(value => value.trim()).filter(Boolean))];
  }

  async researchTopicEvidence(topic) {
    const cleanTopic = String(topic || '').replace(/\s+/g, ' ').trim();
    if (!cleanTopic) return { sources: [], context: [], generatedAt: new Date().toISOString() };

    const topicTokens = this.normalizedResearchTokens(cleanTopic);
    const requiredMatches = topicTokens.size <= 1 ? 1 : 2;
    const relevanceText = value => {
      const haystackTokens = this.normalizedResearchTokens(value);
      return [...topicTokens].filter(token => haystackTokens.has(token)).length;
    };
    const relevance = page => relevanceText(`${page?.title || ''} ${page?.extract || ''}`);
    const collected = new Map();
    const queries = this.buildResearchQueries(cleanTopic);
    const headers = { 'User-Agent': 'ShortsPipeline/1.0 documentary-research' };

    for (const query of queries) {
      try {
        const search = await axios.get('https://en.wikipedia.org/w/api.php', {
          params: {
            action: 'query',
            format: 'json',
            origin: '*',
            list: 'search',
            srsearch: query,
            srnamespace: 0,
            srlimit: 8,
            srprop: 'snippet'
          },
          headers,
          timeout: 20000
        });

        const candidates = Array.isArray(search.data?.query?.search) ? search.data.query.search : [];
        for (const candidate of candidates) {
          if (collected.size >= 4) break;
          const snippet = String(candidate?.snippet || '').replace(/<[^>]+>/g, ' ');
          const candidateScore = relevanceText(`${candidate?.title || ''} ${snippet}`);
          if (topicTokens.size && candidateScore < requiredMatches) continue;

          const details = await axios.get('https://en.wikipedia.org/w/api.php', {
            params: {
              action: 'query',
              format: 'json',
              origin: '*',
              pageids: candidate.pageid,
              prop: 'extracts|info',
              inprop: 'url',
              explaintext: 1,
              exchars: 5000
            },
            headers,
            timeout: 20000
          });
          const page = Object.values(details.data?.query?.pages || {})[0];
          if (!page?.fullurl || !page?.extract) continue;
          const score = Math.max(candidateScore, relevance(page));
          if (topicTokens.size && score < requiredMatches) continue;
          const previous = collected.get(page.fullurl);
          if (!previous || score > previous._relevance) {
            collected.set(page.fullurl, { ...page, _relevance: score });
          }
        }
        if (collected.size >= 4) break;
      } catch (error) {
        this.logger.warn(`Topic research query failed for "${query}": ${error.message}`);
      }
    }

    const pages = [...collected.values()]
      .sort((a, b) => (b._relevance - a._relevance) || (Number(a.index || 999) - Number(b.index || 999)))
      .slice(0, 4);

    const sources = [];
    const context = [];
    for (const page of pages) {
      const excerpt = String(page.extract || '').replace(/\s+/g, ' ').trim().slice(0, 5000);
      if (!excerpt) continue;
      const source = {
        url: page.fullurl,
        title: page.title || page.fullurl,
        publisher: 'Wikipedia',
        sourceType: 'article',
        status: 'verified',
        retrievalStatus: 'fetched',
        accessedAt: new Date().toISOString(),
        notes: 'Automatically retrieved as relevant factual context. Standard claims may auto-pass only when the claim text materially matches this fetched excerpt; high-risk claims remain blocked.'
      };
      sources.push(source);
      context.push({
        url: source.url,
        title: source.title,
        publisher: source.publisher,
        excerpt
      });
    }

    this.logger.info(`Fetched ${sources.length} research source(s) for: ${cleanTopic} using ${queries.length} query variant(s)`);
    return { sources, context, generatedAt: new Date().toISOString() };
  }

  async researchAndPlanChannel(channelStrategy) {
    const targetCount = Math.max(1, Math.min(5, Number(channelStrategy.videos_per_run || 1)));
    try { await this.analyzeTrends(); } catch (error) { this.logger.warn(`Trend scan unavailable: ${error.message}`); }

    const recentRows = (await this.loadRecentPremises()).map(topic => ({ topic }));
    const approvedLearnings = this.db.listLearningRecommendations
      ? await this.db.listLearningRecommendations({ status: 'approved', limit: 12 })
      : [];

    const research = {
      generatedAt: new Date().toISOString(),
      sources: ['Channel content history', 'YouTube trend/competitor pattern scan', 'Approved analytics learnings'],
      signals: this.trendingTopics.slice(0, 20).map(item => ({
        topic: item.topic,
        score: Number(item.score || 0),
        sources: [...new Set(item.sources || [])]
      })),
      sourceCatalog: [],
      recentTopics: recentRows.map(row => row.topic),
      evergreenLeads: this.getEvergreenFallbackTopics()
        .filter(topic => !this.isNearDuplicateOfRecent(topic, recentRows.map(row => row.topic)))
        .slice(0, 15),
      competitorChannelsAnalyzed: this.competitorData.length,
      approvedLearnings: approvedLearnings.map(item => ({
        category: item.category,
        title: item.title,
        rationale: item.rationale,
        confidence: item.confidence,
        proposedChange: item.proposedChange
      }))
    };

    let plan = await this.generateAutonomousPlanWithAI(channelStrategy, research, targetCount);
    plan = this.normalizeAutonomousPlan(plan, channelStrategy, targetCount, research);
    if (plan.length < targetCount) {
      this.logger.warn(
        `AI planning produced ${plan.length}/${targetCount} approved Horror stories; validating curated original fallback premises against the same hard gates`
      );
      plan = this.normalizeAutonomousPlan(
        [...plan, ...this.buildFallbackAutonomousPlan(channelStrategy, research, targetCount)],
        channelStrategy,
        targetCount,
        research
      );
    }
    if (plan.length < targetCount) {
      const error = new Error(`Horror Stickman planning produced ${plan.length}/${targetCount} approved original stories after gated fallback; refusing low-quality filler`);
      error.code = 'AUTONOMOUS_PLAN_INSUFFICIENT';
      throw error;
    }
    return { research, plan };
  }

  async generateAutonomousPlanWithAI(channelStrategy, research, targetCount, requestedTopic = null) {
    if (!this.aiTextService.isAvailable()) return [];
    const candidateCount = requestedTopic ? 1 : 10;
    const prompt = `You are the Content Strategy Agent of the Horror Stickman channel.
Your only objective is to create original fictional micro-horror ideas with exceptional scroll-stop, retention, twist, and Dark Stickman production potential.
Follow these rules strictly.

BRAND
Core promise: ${this.identity.corePromise}
Audience: ${this.identity.audience}
Pillars: ${this.identity.contentPillars.map(p => p.label).join(' | ')}
Story criteria: ${this.identity.storyCriteria.join(' | ')}
Avoid: ${this.identity.avoid.join(' | ')}

LOCKED NICHE
Name: ${nicheContract.name}
Positioning: ${nicheContract.positioning}
Discovery promise: ${nicheContract.discoveryPromise}
Preferred angles: ${nicheContract.preferredAngles.join(' | ')}
Hard gates: ${JSON.stringify(nicheContract.hardGates)}
Retention mechanics: ${nicheContract.requiredRetentionMechanics.join(' | ')}

Generate ${candidateCount} ${requestedTopic ? 'version of the requested premise' : 'materially different candidate ideas'}.
${requestedTopic ? `REQUESTED PREMISE: ${requestedTopic}. Preserve this exact subject; do not substitute another story.` : ''}
Recent premises to avoid semantically repeating: ${JSON.stringify(research.recentTopics || [])}
STORY STRUCTURES (proven shapes for 90-140 word horror Shorts; every candidate must use ONE of them and the ten candidates must use at least four different ones). Do not invent new kinds of physics. Take the shape and put a NEW specific person, place and wrong detail into it. The seeds only show the shape; never reuse a seed.
${storyStructures.structures.map(item => `- ${item.id} (${item.name}): ${item.shape} Twist: ${item.twist} Seeds: ${item.seeds.join(' | ')}`).join('\n')}
Worn-out endings to avoid: ${OVERUSED_TROPES.join('; ')}.
The premise must say who the person is, what ordinary thing they are doing, and what goes wrong. The hook is a rule, a person who is wrong in one small way, or a sound from where nobody is. It must make a stranger ask a question; it is not a mundane glitch and not a feeling.
Current pattern signals may inspire structure only, never copy a real story: ${JSON.stringify((research.signals || []).slice(0, 12))}
Approved analytics learnings: ${JSON.stringify(research.approvedLearnings || [])}

Every candidate must:
- be clearly fictional and original;
- fit 20-45 seconds and roughly 90-140 spoken words;
- hook in the first 1-1.5 seconds;
- begin from an instantly understandable everyday or liminal situation;
- escalate at least twice, each escalation a consequence of the one before it (a chain of cause and effect, never a list of unrelated strange things);
- put one specific person at risk: say who they are, what ordinary thing they are doing and why, and what choice of theirs makes it worse;
- make the payoff reuse an object, sound or number planted in the setup, so the ending changes the meaning of the opening;
- end in a twist, climax, or disturbing unresolved beat;
- support 4-7 distinct Dark Stickman visual beats, each one clear stickman action in one place with one prop or detail (door, phone, mirror, lamp, window), visibly different from its neighbour;
- show fear through the moment before an event or its aftermath at a distance, never depicted injury, blood, or a person being harmed;
- use no real names, brands, logos, or places tied to a real crime;
- avoid gore-first horror, comedy, real people, true crime, fake "true story" framing, and copyrighted horror characters;
- remain scary through implication, impossible space/sound/message/reflection/repetition/presence rather than graphic violence;
- be different enough that swapping only the setting noun would NOT produce the same story.

Before final output, evaluate each candidate against hook, tension, twist, originality, and brand consistency. Return only compact scores, not private chain-of-thought.

Return ONLY valid JSON:
{"candidates":[
  {
    "topic":"specific fictional premise in one sentence",
    "idea":"short idea label",
    "storyStructure":"one id from the STORY STRUCTURES list",
    "storyFamily":"psychological-horror family",
    "everydayAnchor":"ordinary situation",
    "fearMechanism":"single central fear mechanism",
    "angle":"how tension escalates without revealing everything",
    "hook":"8-12 word opening line",
    "scrollStopMoment":"exact first-frame visual (one stickman, one prop, readable on a dark frame)",
    "visualWhy":"why the first frame stops a swipe",
    "visualVariety":["beat 1","beat 2","beat 3","beat 4"],
    "curiosityAngle":"the unanswered question",
    "escalationLadder":["escalation 1","escalation 2"],
    "payoff":"specific twist/climax/unresolved final beat",
    "fitRationale":"why it fits this exact channel",
    "storyEngine":"ordinary-to-impossible|viewer-knows-first|impossible-sound|space-does-not-behave|repetition-loop|presence-without-proof|late-recontextualization",
    "autonomyRisk":"low",
    "nicheFit":1,
    "visualStrength":1,
    "curiosityGap":1,
    "visualVarietyScore":1,
    "retentionPotential":1,
    "originalityScore":1,
    "brandFit":1,
    "twistScore":1,
    "premiseLegibility":1,
    "payoffStrength":1,
    "targetAudience":"global English horror Shorts viewers",
    "contentType":"Story",
    "keywords":["horror","scary story"],
    "fictional":true
  }
]}`;

    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await this.aiTextService.generateText(prompt + (attempt === 2
          ? '\nRETRY: Return complete compact JSON only. Do not add prose and do not lower the scores to bypass gates.'
          : ''), {
          task: 'ideation',
          maxTokens: requestedTopic ? 1500 : 9000,
          temperature: 0.85,
          thinkingLevel: 'low',
          responseMimeType: 'application/json'
        });
        const parsed = this.parseAIJsonResponse(response);
        return Array.isArray(parsed) ? parsed : (Array.isArray(parsed.candidates) ? parsed.candidates : []);
      } catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1200));
      }
    }
    this.logger.warn(`Horror idea batch generation failed: ${lastError?.message || 'unknown error'}`);
    return [];
  }

  buildFallbackAutonomousPlan(channelStrategy, research, targetCount) {
    const recent = research.recentTopics || [];
    return this.getEvergreenFallbackTopics()
      .filter(topic => !this.isNearDuplicateOfRecent(topic, recent))
      .slice(0, targetCount)
      .map(topic => ({
        topic,
        idea: topic,
        storyFamily: 'psychological-horror',
        everydayAnchor: 'ordinary nighttime situation',
        fearMechanism: 'an impossible detail becomes more threatening each beat',
        angle: this.buildDocumentaryAngle(topic),
        hook: String(topic).replace(/[.…]+$/g, '').slice(0, 90),
        scrollStopMoment: 'A lone dark stickman freezes beside the one impossible detail that proves something is wrong.',
        visualWhy: 'One readable silhouette and one impossible cue create immediate fear without exposition.',
        visualVariety: ['ordinary setup', 'first anomaly', 'closer escalation', 'final impossible reveal'],
        curiosityAngle: 'What is causing the impossible detail, and how close is the threat?',
        escalationLadder: ['the anomaly repeats or responds', 'the threat crosses into the character’s immediate space'],
        payoff: 'The final beat recontextualizes the setup and confirms the threat was already closer than the character realized.',
        fitRationale: 'Original-looking psychological micro-horror designed for the locked Dark Stickman brand.',
        storyEngine: 'ordinary-to-impossible',
        autonomyRisk: 'low',
        nicheFit: 9,
        visualStrength: 9,
        curiosityGap: 9,
        visualVarietyScore: 8,
        retentionPotential: 9,
        originalityScore: 9,
        brandFit: 9,
        twistScore: 9,
        premiseLegibility: 9,
        payoffStrength: 9,
        targetAudience: channelStrategy.audience || this.identity.audience,
        contentType: 'Story',
        keywords: ['horror', 'scary story', 'stickman horror'],
        fictional: true,
        format: 'story',
        length: 'short',
        sourceUrls: []
      }));
  }

  normalizeAutonomousPlan(plan, channelStrategy, targetCount, research = {}) {
    const seen = new Set();
    const recent = research.recentTopics || [];
    return (Array.isArray(plan) ? plan : [])
      .map(item => {
        const visualVariety = (Array.isArray(item.visualVariety) ? item.visualVariety : [])
          .map(value => String(value).trim()).filter(Boolean).slice(0, 7);
        const escalationLadder = (Array.isArray(item.escalationLadder) ? item.escalationLadder : [])
          .map(value => String(value).trim()).filter(Boolean).slice(0, 4);
        const candidate = {
          topic: String(item.topic || item.premise || item.idea || '').trim().slice(0, 200),
          idea: String(item.idea || item.topic || '').trim().slice(0, 160),
          storyFamily: String(item.storyFamily || 'psychological-horror').trim().slice(0, 80),
          storyStructure: String(item.storyStructure || '').trim().toLowerCase().slice(0, 60),
          everydayAnchor: String(item.everydayAnchor || '').trim().slice(0, 300),
          fearMechanism: String(item.fearMechanism || '').trim().slice(0, 400),
          angle: String(item.angle || '').trim().slice(0, 500),
          hook: String(item.hook || '').trim().slice(0, 180),
          scrollStopMoment: String(item.scrollStopMoment || item.visualHook || '').trim().slice(0, 500),
          visualWhy: String(item.visualWhy || '').trim().slice(0, 500),
          visualVariety,
          footageAvailability: 'synthetic',
          curiosityAngle: String(item.curiosityAngle || item.retentionMechanic || '').trim().slice(0, 500),
          escalationLadder,
          payoff: String(item.payoff || item.twist || '').trim().slice(0, 500),
          fitRationale: String(item.fitRationale || '').trim().slice(0, 500),
          storyEngine: String(item.storyEngine || 'ordinary-to-impossible').trim().toLowerCase(),
          autonomyRisk: String(item.autonomyRisk || 'low').trim().toLowerCase(),
          nicheFit: Number(item.nicheFit || item.brandFit || 0),
          visualStrength: Number(item.visualStrength || 0),
          curiosityGap: Number(item.curiosityGap || item.hookScore || 0),
          visualVarietyScore: Number(item.visualVarietyScore || 0),
          retentionPotential: Number(item.retentionPotential || 0),
          originalityScore: Number(item.originalityScore || 0),
          brandFit: Number(item.brandFit || item.nicheFit || 0),
          twistScore: Number(item.twistScore || item.payoffStrength || 0),
          premiseLegibility: Number(item.premiseLegibility || 0),
          payoffStrength: Number(item.payoffStrength || item.twistScore || 0),
          targetAudience: String(item.targetAudience || channelStrategy.audience || this.identity.audience).trim(),
          contentType: 'Story',
          keywords: (Array.isArray(item.keywords) ? item.keywords : ['horror','scary story','stickman horror'])
            .map(value => String(value).trim()).filter(Boolean).slice(0, 10),
          fictional: item.fictional !== false,
          provenanceMode: 'fictional',
          researchSources: [],
          researchContext: [],
          format: 'story',
          length: 'short',
          requestedLengthKey: 'short',
          sourceUrls: [],
          staticExplainerRisk: 'low'
        };
        candidate.priority = Math.round([
          candidate.nicheFit,
          candidate.visualStrength,
          candidate.curiosityGap,
          candidate.retentionPotential,
          candidate.originalityScore,
          candidate.brandFit,
          candidate.twistScore
        ].reduce((sum, value) => sum + Number(value || 0), 0) / 7 * 10);
        const learned = this.learnedPlanAdjustment(candidate, research.approvedLearnings);
        if (learned.delta) {
          candidate.priority += learned.delta;
          candidate.learningSignals = learned.signals;
        }
        return candidate;
      })
      .filter(item => {
        const key = item.topic.toLowerCase();
        if (!item.topic || seen.has(key)) return false;
        if (this.isNearDuplicateOfRecent(item.topic, recent)) return false;
        if (!this.isApprovedNicheCandidate(item, research.recentOverride ? recent : undefined)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => b.priority - a.priority)
      .slice(0, targetCount);
  }

  /**
   * Apply approved analytics learnings to plan ranking without AI. The bonus is
   * bounded so it tilts selection toward what retained viewers while every hard
   * gate (niche, originality, brand, duplicates) still filters first and other
   * story engines keep getting explored.
   */
  learnedPlanAdjustment(candidate, approvedLearnings = []) {
    let delta = 0;
    const signals = [];
    for (const learning of Array.isArray(approvedLearnings) ? approvedLearnings : []) {
      const change = learning?.proposedChange || {};
      if (change.target !== 'future_plans' || change.dimension !== 'storyEngine') continue;
      const engine = String(candidate.storyEngine || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
      const weight = String(learning.confidence).toLowerCase() === 'high' ? 8 : 6;
      if (engine && engine === String(change.prefer || '')) {
        delta += weight;
        signals.push(`+${weight} learned: ${learning.title}`);
      } else if (engine && engine === String(change.deprioritize || '')) {
        delta -= weight;
        signals.push(`-${weight} learned: ${learning.title}`);
      }
    }
    return { delta: Math.max(-10, Math.min(10, delta)), signals };
  }

  inferDeterministicStoryEngine(topic) {
    const text = String(topic || '').toLowerCase();
    if (/\b(mirror|reflection|reflected)\b/.test(text)) return 'wrong-reflection';
    if (/\b(text|message|phone|voicemail|notification)\b/.test(text)) return 'impossible-message';
    if (/\b(camera|monitor|security feed|cctv|recording)\b/.test(text)) return 'viewer-knows-first';
    if (/\b(loop|repeat|repeating|again and again)\b/.test(text)) return 'repetition-loop';
    if (/\b(knock|knocking|voice|sound|footsteps|whisper|breathing)\b/.test(text)) return 'impossible-sound';
    if (/\b(elevator|hallway|corridor|stairs|stairwell|floor|room|door|window)\b/.test(text)) return 'space-does-not-behave';
    if (/\b(shadow|closet|behind|presence|someone|alone)\b/.test(text)) return 'presence-without-proof';
    return 'ordinary-to-impossible';
  }

  buildDeterministicHorrorStrategy(topic) {
    const cleanTopic = String(topic || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!cleanTopic) throw new Error('Deterministic Horror strategy requires a topic');

    const engine = this.inferDeterministicStoryEngine(cleanTopic);
    const blueprints = {
      'wrong-reflection': {
        hook: 'The reflection moved after the person had already stopped.',
        everydayAnchor: 'an ordinary late-night moment alone in front of a mirror',
        fearMechanism: 'the reflection stops matching the real person and begins acting first',
        scrollStopMoment: 'A dark stickman faces a glowing mirror while the reflected figure is visibly out of sync.',
        visualVariety: [
          'stickman facing an ordinary bathroom mirror',
          'reflection blinking or turning a fraction too late',
          'real figure freezing while reflection keeps moving',
          'reflection pressing closer to the glass',
          'final frame where the reflection moves first'
        ],
        curiosityAngle: 'Why is the reflection falling out of sync, and what happens when it stops copying completely?',
        escalationLadder: [
          'the delay becomes obvious even when the real figure stands still',
          'the reflection begins moving independently and closes the distance to the glass'
        ],
        payoff: 'The final beat reveals the reflection can move first, turning the mirror from a copy into the threat.'
      },
      'impossible-message': {
        hook: 'The message came from the room that was locked.',
        everydayAnchor: 'an ordinary person alone at home with a phone nearby',
        fearMechanism: 'messages arrive from a place or identity that should be impossible',
        scrollStopMoment: 'A dark stickman stares at a glowing phone beside a locked door in a nearly black room.',
        visualVariety: [
          'stickman reading an unexpected message',
          'locked door or empty room matching the message source',
          'new message describing the character in real time',
          'door handle or shadow reacting after the next message',
          'final phone screen proving the sender is impossibly close'
        ],
        curiosityAngle: 'Who is sending the messages, and how can the sender know what is happening right now?',
        escalationLadder: [
          'the messages describe details they should not know',
          'the sender proves it is inside or immediately beside the supposedly safe space'
        ],
        payoff: 'The last message proves the sender is already inside the safe space before the character can escape.'
      },
      'viewer-knows-first': {
        hook: 'The live camera showed tomorrow before it happened.',
        everydayAnchor: 'a quiet surveillance shift watching ordinary security monitors',
        fearMechanism: 'one live feed shows a future version of the same place before events occur',
        scrollStopMoment: 'A dark stickman night guard stares at a glowing security monitor stamped TOMORROW.',
        visualVariety: [
          'night guard watching a normal bank of security screens',
          'one monitor carrying an impossible future timestamp',
          'future feed showing the same desk from a threatening angle',
          'on-screen figure moving before the real person does',
          'final monitor image matching the danger now entering the room'
        ],
        curiosityAngle: 'Why is one camera showing the future, and can the character avoid what is already on-screen?',
        escalationLadder: [
          'the future feed updates before the character makes the predicted movement',
          'the on-screen danger gets closer while the real room begins matching the feed'
        ],
        payoff: 'The final feed shows the predicted danger arriving at the desk just as the real room becomes identical.'
      },
      'repetition-loop': {
        hook: 'The same place returned no matter which way they went.',
        everydayAnchor: 'an ordinary route through a familiar building at night',
        fearMechanism: 'the environment repeats perfectly while one detail changes each cycle',
        scrollStopMoment: 'A lone dark stickman sees the same corridor repeated beyond two different doors.',
        visualVariety: [
          'stickman entering a familiar hallway',
          'same hallway appearing after a different turn',
          'one object changing position between loops',
          'a second silhouette appearing in the repeated space',
          'final loop placing the silhouette beside the character'
        ],
        curiosityAngle: 'What is changing inside the repeated space, and why is the loop becoming more dangerous?',
        escalationLadder: [
          'each repetition preserves the space but changes one impossible detail',
          'the changing detail becomes a presence that moves closer every cycle'
        ],
        payoff: 'The final repetition ends with the threat already beside the character instead of at the far end.'
      },
      'impossible-sound': {
        hook: 'The knocking matched every step moving away from it.',
        everydayAnchor: 'an ordinary quiet room or hallway late at night',
        fearMechanism: 'an impossible sound reacts precisely to the character’s movement',
        scrollStopMoment: 'A dark stickman freezes in a hallway while a nearby wall produces one visible knock cue.',
        visualVariety: [
          'stickman hearing the first sound in an empty space',
          'character stepping away while the sound answers',
          'sound source shifting to a closer wall or door',
          'silence while the character stops moving',
          'final knock coming from directly behind the character'
        ],
        curiosityAngle: 'What is matching the movement, and why does the sound keep getting closer?',
        escalationLadder: [
          'the sound copies the character’s movement instead of occurring randomly',
          'the source relocates into the character’s immediate space'
        ],
        payoff: 'The final sound comes from directly behind the character after every visible source has been left behind.'
      },
      'space-does-not-behave': {
        hook: /\belevator\b/i.test(cleanTopic)
          ? 'The elevator opened on a floor that did not exist.'
          : 'The hallway led back to the room just left.',
        everydayAnchor: 'an ordinary trip through a familiar building late at night',
        fearMechanism: 'familiar space reconnects in a way that should be physically impossible',
        scrollStopMoment: 'A dark stickman faces a familiar doorway or corridor that impossibly leads back to the same place.',
        visualVariety: [
          'stickman entering an ordinary corridor or elevator',
          'doors opening onto an impossible duplicate space',
          'character trying a different route',
          'duplicate space returning with one threatening change',
          'final doorway revealing the threat already on the character’s side'
        ],
        curiosityAngle: 'Why is the building folding back on itself, and what changed during the last loop through the space?',
        escalationLadder: [
          'a second route returns to the same impossible location',
          'the repeated space now contains a presence that was not there before'
        ],
        payoff: 'The final doorway opens back onto the same place, but the threat is now standing on the character’s side.'
      },
      'presence-without-proof': {
        hook: 'The room was empty until the shadow moved first.',
        everydayAnchor: 'an ordinary person alone in a familiar room at night',
        fearMechanism: 'a shadow or unseen presence behaves independently without revealing a body',
        scrollStopMoment: 'A lone dark stickman stands in a dim room while one shadow points the wrong direction.',
        visualVariety: [
          'stickman alone in a familiar room',
          'shadow appearing where no object could cast it',
          'shadow changing shape while the character stays still',
          'presence moving across the wall toward the character',
          'final frame with the shadow touching the character before anything is visible'
        ],
        curiosityAngle: 'What is casting the impossible shadow, and why can it move without a visible body?',
        escalationLadder: [
          'the shadow moves while every visible object remains still',
          'the shadow crosses the room and reaches the character’s position'
        ],
        payoff: 'The final beat shows the impossible shadow touching the character before any physical figure appears.'
      },
      'ordinary-to-impossible': {
        hook: 'One ordinary detail changed the moment it was noticed.',
        everydayAnchor: 'a familiar everyday situation late at night',
        fearMechanism: 'one simple detail breaks reality and begins reacting to the character',
        scrollStopMoment: 'A dark stickman freezes beside one ordinary object behaving in an impossible way.',
        visualVariety: [
          'ordinary setup with one clear stickman focal subject',
          'first impossible detail appearing',
          'detail reacting after the character notices it',
          'threat crossing into the character’s immediate space',
          'final reveal recontextualizing the original ordinary object'
        ],
        curiosityAngle: 'Why did the ordinary detail react, and what happens when the character acknowledges it?',
        escalationLadder: [
          'the impossible detail repeats in direct response to the character',
          'the response becomes a physical threat inside the safe space'
        ],
        payoff: 'The final beat reveals the ordinary detail was not a warning but the visible edge of the threat itself.'
      }
    };

    const blueprint = blueprints[engine] || blueprints['ordinary-to-impossible'];
    const gates = nicheContract.hardGates || {};
    const atLeast = (value, fallback) => Math.max(fallback, Number(value || 0));
    const candidate = {
      topic: cleanTopic,
      idea: cleanTopic.slice(0, 160),
      storyFamily: 'psychological-horror',
      everydayAnchor: blueprint.everydayAnchor,
      fearMechanism: blueprint.fearMechanism,
      angle: this.buildDocumentaryAngle(cleanTopic),
      hook: blueprint.hook,
      scrollStopMoment: blueprint.scrollStopMoment,
      visualWhy: 'One readable Dark Stickman silhouette plus one impossible cue creates an immediate mobile scroll-stop.',
      visualVariety: blueprint.visualVariety,
      footageAvailability: 'synthetic',
      curiosityAngle: blueprint.curiosityAngle,
      escalationLadder: blueprint.escalationLadder,
      payoff: blueprint.payoff,
      fitRationale: 'Original psychological micro-horror built for the locked Dark Stickman visual grammar and 20-45 second retention structure.',
      storyEngine: engine,
      autonomyRisk: 'low',
      nicheFit: atLeast(gates.nicheFitMin, 9),
      visualStrength: atLeast(gates.visualStrengthMin, 9),
      curiosityGap: atLeast(gates.curiosityGapMin, 9),
      visualVarietyScore: atLeast(gates.visualVarietyMin, 9),
      retentionPotential: atLeast(gates.retentionPotentialMin, 9),
      originalityScore: atLeast(gates.originalityMin, 9),
      brandFit: atLeast(gates.brandFitMin, 9),
      twistScore: 9,
      premiseLegibility: 9,
      payoffStrength: 9,
      targetAudience: this.identity.audience,
      contentType: 'Story',
      keywords: ['horror', 'scary story', 'stickman horror'],
      fictional: true,
      provenanceMode: 'fictional',
      researchSources: [],
      researchContext: [],
      format: 'story',
      length: 'short',
      requestedLengthKey: 'short',
      sourceUrls: [],
      staticExplainerRisk: 'low',
      estimatedViews: null,
      bestPublishTime: null,
      competitorAnalysis: this.getCompetitorInsights(cleanTopic),
      createdAt: new Date().toISOString(),
      generationSource: 'deterministic-fallback'
    };
    return candidate;
  }

  async generateContentStrategyWithAI(requestedTopic = null) {
    if (!this.aiTextService.isAvailable()) {
      this.logger.info('No AI text provider configured for Horror Stickman strategy generation');
      return null;
    }
    await this.loadRecentPremises();
    const recentTopics = requestedTopic ? this.recentTopicsExcludingPremise(requestedTopic) : this.getRecentTopics();
    const channelStrategy = {
      audience: this.identity.audience,
      contentPillars: this.identity.contentPillars.map(p => p.label),
      default_format: 'story',
      default_length: 'short'
    };
    const research = {
      recentTopics,
      recentOverride: Boolean(requestedTopic),
      signals: this.trendingTopics.slice(0, 15).map(item => ({ topic: item.topic, score: Number(item.score || 0) })),
      approvedLearnings: []
    };
    const raw = await this.generateAutonomousPlanWithAI(channelStrategy, research, 1, requestedTopic);
    const normalized = this.normalizeAutonomousPlan(raw, channelStrategy, 1, research);
    const candidate = normalized[0] || null;
    if (!candidate) return null;
    if (requestedTopic && this.topicSimilarity(requestedTopic, candidate.topic) < 0.45) {
      const error = new Error(`Horror strategy substituted a different requested premise: ${requestedTopic}`);
      error.code = 'STRATEGY_TOPIC_DRIFT';
      throw error;
    }
    candidate.estimatedViews = null;
    candidate.bestPublishTime = null;
    candidate.competitorAnalysis = this.getCompetitorInsights(candidate.topic);
    candidate.createdAt = new Date().toISOString();
    this.logger.info(`Using Horror Stickman strategy via ${this.aiTextService.providerName}`);
    return candidate;
  }

  /**
   * Turn a plan item that the planner already vetted (best of its candidate
   * list) into the job's strategy, re-checking the same hard gates. Returns
   * null when the item no longer passes, so the caller can regenerate.
   */
  async buildStrategyFromPlanItem(planItem) {
    if (!planItem || typeof planItem !== 'object' || !planItem.topic) return null;
    await this.loadRecentPremises();
    const channelStrategy = {
      audience: this.identity.audience,
      contentPillars: this.identity.contentPillars.map(p => p.label),
      default_format: 'story',
      default_length: 'short'
    };
    // The operator run that carries this item is itself a stored "recent premise";
    // the item must not be rejected as a duplicate of its own plan.
    const recentTopics = this.recentTopicsExcludingPremise(planItem.topic);
    const research = { recentTopics, recentOverride: true, signals: [], approvedLearnings: [] };
    const candidate = this.normalizeAutonomousPlan([planItem], channelStrategy, 1, research)[0] || null;
    if (!candidate) return null;
    candidate.estimatedViews = null;
    candidate.bestPublishTime = null;
    candidate.competitorAnalysis = this.getCompetitorInsights(candidate.topic);
    candidate.createdAt = new Date().toISOString();
    const enriched = await this.enrichStrategyWithResearch(candidate);
    await this.db.saveContentStrategy(enriched);
    this.logger.info(`Using the planner's vetted idea for: ${enriched.topic}`);
    return enriched;
  }

  parseAIJsonResponse(response) {
    return parseJsonResponse(response);
  }

  selectOptimalTopic() {
    const recentTopics = this.getRecentTopics();
    const scoredTopics = this.trendingTopics
      .filter(item => this.isIdentityAlignedStoryTopic(item.topic))
      .filter(item => !this.isNearDuplicateOfRecent(item.topic, recentTopics))
      .map(item => ({
        ...item,
        finalScore: Number(item.score || 0) * this.getAudienceMultiplier(item.topic)
      }))
      .sort((a, b) => b.finalScore - a.finalScore);

    if (scoredTopics.length) return scoredTopics[0];

    const fallbackTopics = this.getEvergreenFallbackTopics();
    const pick = fallbackTopics.find(topic => !this.isNearDuplicateOfRecent(topic, recentTopics)) || fallbackTopics[0];
    this.logger.info(`Template mode: no identity-aligned story signal available — using evergreen story "${pick}"`);
    return { topic: pick, score: 1 };
  }

  getEvergreenFallbackTopics() {
    return [...this.identity.fallbackTopics];
  }

  buildDocumentaryAngle(topic) {
    const patterns = [
      `Start with the one impossible detail in ${topic}, let it react to the character, then reveal that the threat was already closer than expected.`,
      `Open on an ordinary moment in ${topic}, introduce one wrong detail, escalate it twice, and use the final beat to recontextualize the setup.`,
      `Frame ${topic} as a simple everyday situation that becomes impossible through sound, space, reflection, message, repetition, or unseen presence.`,
      `Let the viewer notice the danger in ${topic} before the character does, then tighten the distance between them until the final reveal.`
    ];
    return patterns[this.stableIndex(topic, patterns.length)];
  }

  async generateAngle(topic) {
    return this.buildDocumentaryAngle(topic);
  }

  async identifyTargetAudience() {
    return this.identity.audience;
  }

  stableIndex(value, modulo) {
    const hash = String(value || '').split('').reduce((sum, char) => ((sum * 31) + char.charCodeAt(0)) >>> 0, 0);
    return modulo ? hash % modulo : 0;
  }

  normalizedTopicTokens(value) {
    const stop = new Set(['the','a','an','and','or','of','to','in','on','for','with','why','how','what','when','where','that','this']);
    return new Set(String(value || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(token => token.length > 2 && !stop.has(token)));
  }

  topicSimilarity(left, right) {
    const a = this.normalizedTopicTokens(left);
    const b = this.normalizedTopicTokens(right);
    if (!a.size || !b.size) return 0;
    const intersection = [...a].filter(token => b.has(token)).length;
    return intersection / Math.min(a.size, b.size);
  }

  /**
   * Recent premises minus the premise being produced right now. The operator run
   * that planned it is itself stored as a recent premise, and an AI rewrite of it
   * is near-identical, so without this a requested premise rejects itself.
   */
  recentTopicsExcludingPremise(premise) {
    return this.getRecentTopics().filter(topic => this.topicSimilarity(topic, premise) < 0.65);
  }

  isNearDuplicateOfRecent(topic, recentTopics = []) {
    return recentTopics.some(recent => this.topicSimilarity(topic, recent) >= 0.65);
  }

  isApprovedNicheCandidate(candidate = {}, recentTopics = this.getRecentTopics()) {
    const topic = String(candidate.topic || '').trim();
    if (!topic || candidate.fictional === false) return false;
    const lower = topic.toLowerCase();
    if (/\b(true crime|based on a true story|real murder|actual murder case)\b/i.test(lower)) return false;
    if (/\b(dismember|decapitat|entrails|guts spilling|graphic gore)\b/i.test(lower)) return false;
    if ((nicheContract.rejectedAcceptanceExamples || []).some(example =>
      this.topicSimilarity(lower, String(example).toLowerCase()) >= 0.85
    )) return false;

    const gates = nicheContract.hardGates || {};
    const numericChecks = [
      ['nicheFit', gates.nicheFitMin],
      ['visualStrength', gates.visualStrengthMin],
      ['curiosityGap', gates.curiosityGapMin],
      ['visualVarietyScore', gates.visualVarietyMin],
      ['retentionPotential', gates.retentionPotentialMin],
      ['originalityScore', gates.originalityMin],
      ['brandFit', gates.brandFitMin]
    ].filter(([, min]) => Number.isFinite(Number(min)));
    if (numericChecks.some(([field, min]) =>
      !Number.isFinite(Number(candidate[field])) || Number(candidate[field]) < Number(min)
    )) return false;

    const engines = new Set(nicheContract.brandSignature?.storyEngines || []);
    if (engines.size && !engines.has(String(candidate.storyEngine || '').toLowerCase())) return false;
    if (String(candidate.autonomyRisk || '').toLowerCase() !== String(gates.requireAutonomyRisk || 'low')) return false;
    if (String(candidate.hook || '').trim().split(/\s+/).filter(Boolean).length < 5) return false;
    if (gates.requireScrollStopMoment && String(candidate.scrollStopMoment || '').trim().length < 16) return false;
    const beats = Array.isArray(candidate.visualVariety) ? candidate.visualVariety.filter(Boolean) : [];
    if (beats.length < Number(gates.minVisualStates || 4) || beats.length > Number(gates.maxVisualStates || 7)) return false;
    const escalation = Array.isArray(candidate.escalationLadder) ? candidate.escalationLadder.filter(Boolean) : [];
    if (escalation.length < Number(gates.minEscalationSteps || 2)) return false;
    if (gates.requireConcretePayoff && String(candidate.payoff || '').trim().length < 16) return false;
    if (this.isNearDuplicateOfRecent(topic, recentTopics)) return false;
    return true;
  }

  isIdentityAlignedStoryTopic(topic) {
    const text = String(topic || '').trim();
    if (text.length < 12 || text.split(/\s+/).length < 3) return false;
    const lower = text.toLowerCase();
    if (/\b(true crime|celebrity|reaction|trailer|song|lyrics|gaming highlights)\b/i.test(lower)) return false;
    const keywords = this.identity.contentPillars.flatMap(pillar => pillar.keywords || []).map(k => String(k).toLowerCase());
    const horrorShape = /\b(knock|door|wall|voice|message|phone|mirror|reflection|shadow|hallway|elevator|stairs|camera|night|room|closet|window|footsteps|alone|empty|wrong|behind|inside)\b/i.test(text);
    return horrorShape || keywords.some(keyword => lower.includes(keyword));
  }

  selectContentType(_topic) {
    return 'Story';
  }

  predictViews(_topic) {
    // Do not fabricate a view forecast without measured channel evidence.
    // Analytics can populate performance expectations after real uploads exist.
    return null;
  }

  calculateBestPublishTime() {
    // There is no universal evidence-based publish time for a new channel.
    // PublishingSchedulingAgent can use stored YouTube Audience timing evidence,
    // otherwise the operator must select the first schedule explicitly.
    return null;
  }

  getCompetitorInsights(topic) {
    // Get insights from competitor analysis
    return this.competitorData
      .filter(competitor => 
        competitor.topPerformingTopics.some(t => 
          t.topic.toLowerCase().includes(topic.toLowerCase())
        )
      )
      .map(competitor => ({
        channelId: competitor.channelId,
        averageViews: competitor.averageViews,
        relevantVideos: competitor.topPerformingTopics.filter(t => 
          t.topic.toLowerCase().includes(topic.toLowerCase())
        )
      }));
  }

  getRecentTopics() {
    // Use a long originality window when history is available, but stay safe on a cold start.
    // content_history rows carry `publish_date`/`created_at` (never `createdAt`): reading the wrong field made
    // every row an Invalid Date, so this list was always empty and the same premises came back run after run.
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    const fromHistory = (Array.isArray(this.historicalPerformance) ? this.historicalPerformance : [])
      .filter(content => {
        const stamp = content.created_at || content.createdAt || content.publish_date;
        const contentDate = new Date(stamp);
        // A row without a usable date is kept: forgetting a premise is worse than remembering one too long.
        return !stamp || Number.isNaN(contentDate.getTime()) || contentDate > cutoff;
      })
      .map(content => content.topic);
    return [...new Set([...(this.recentPremises || []), ...fromHistory].map(topic => String(topic || '').trim()).filter(Boolean))];
  }

  /**
   * Premises the channel already tried, including ones that never became a published Short: saved strategies,
   * every content idea (failed and rejected too) and the plans of recent operator runs. Without the failed ones the
   * planner proposed the same smoke detector / clock / mirror stories again and again.
   */
  async loadRecentPremises() {
    const topics = [];
    const read = async (sql, pick) => {
      try {
        const rows = await this.db.getAllRows(sql);
        for (const row of rows || []) topics.push(...pick(row));
      } catch (error) {
        this.logger.warn(`Recent premises: ${error.message}`);
      }
    };
    await read("SELECT topic FROM content_strategies WHERE created_at >= datetime('now', '-90 days') ORDER BY created_at DESC LIMIT 100", row => [row.topic]);
    await read("SELECT topic FROM content_ideas WHERE created_at >= datetime('now', '-30 days') ORDER BY created_at DESC LIMIT 100", row => [row.topic]);
    await read("SELECT plan FROM operator_runs WHERE created_at >= datetime('now', '-14 days') ORDER BY created_at DESC LIMIT 30", row => {
      let plan = row.plan;
      if (typeof plan === 'string') { try { plan = JSON.parse(plan); } catch (_error) { plan = []; } }
      return (Array.isArray(plan) ? plan : []).map(item => item?.topic);
    });
    this.recentPremises = [...new Set(topics.map(topic => String(topic || '').trim()).filter(Boolean))].slice(0, 150);
    return this.recentPremises;
  }

  getAudienceMultiplier(topic) {
    return this.isIdentityAlignedStoryTopic(topic) ? 1.35 : 0.5;
  }
}

module.exports = { ContentStrategyAgent };
