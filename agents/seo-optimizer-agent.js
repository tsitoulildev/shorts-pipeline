const { Logger } = require('../utils/logger');
const { AITextService } = require('../utils/ai-text-service');
const nicheContract = require('../config/horror-stickman-niche.json');
const { parseJsonResponse } = require('../utils/json-response');

const BANNED_TITLE_PATTERNS = [
  /you won['’]?t believe/i,
  /shocking truth/i,
  /secret nobody/i,
  /\binsane\b/i,
  /\bmust watch\b/i,
  /\bultimate\b/i,
  /\bcomplete guide\b/i
];

// Hard per-dimension minimums a title candidate must clear for the autonomous
// packaging contract. Shared by candidate selection and by
// assertAutonomousPackagingContract so the two can never drift apart.
const TITLE_GATE_MINIMUMS = {
  score: 88,
  curiosity: 88,
  credibility: 100,
  specificity: 82,
  thumbnailComplementarity: 78
};

class SEOOptimizerAgent {
  constructor(db, credentials) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('SEOOptimizer');
    this.keywordDatabase = new Map();
    this.aiTextService = new AITextService(credentials?.credentials || credentials || {});
  }

  async initialize() {
    this.logger.info('Initializing SEO Optimizer Agent...');
    await this.loadKeywordDatabase();
    return true;
  }

  async loadKeywordDatabase() {
    try {
      const keywords = await this.db.getKeywordHistory();
      keywords.forEach(kw => this.keywordDatabase.set(kw.keyword, kw.performance));
    } catch (_error) {
      this.logger.warn('No keyword history found');
    }
  }

  async optimize(script, strategy, packagingContext = {}) {
    try {
      this.logger.info('Building Horror Stickman packaging for: ' + script.title);

      const thumbnail = packagingContext.thumbnail || null;
      const aiPackaging = await this.generatePackagingWithAI(script, strategy, thumbnail);
      const candidates = this.normalizeTitleCandidates(
        aiPackaging?.titleCandidates,
        script,
        strategy,
        thumbnail
      );
      let rankedCandidates = candidates
        .map(candidate => this.scoreTitleCandidate(candidate, script, strategy, thumbnail))
        .sort((a, b) => b.score - a.score);
      let selected = this.pickGatePassingCandidate(rankedCandidates);

      let description = this.cleanDescription(
        aiPackaging?.description || this.generateDescription(script, strategy),
        script,
        strategy
      );
      const discoveryTerms = this.normalizeDiscoveryTerms(
        aiPackaging?.discoveryTerms,
        script,
        strategy
      );
      const tags = this.buildTags(aiPackaging?.tags, discoveryTerms, strategy);
      const hashtags = this.buildHashtags(discoveryTerms);
      const chapters = this.generateChapters(script);
      const sources = this.collectSources(script, strategy);
      const endScreen = await this.generateEndScreenStrategy();
      let packagingScore = this.calculatePackagingScore(
        selected,
        description,
        thumbnail,
        sources,
        chapters
      );
      try {
        this.assertAutonomousPackagingContract({
          selected,
          packagingScore,
          thumbnail,
          sources,
          strategy,
          description
        });
      } catch (error) {
        if (error.code !== 'AUTONOMOUS_PACKAGING_CONTRACT' || !aiPackaging) throw error;
        this.logger.warn(
          'AI packaging missed a hard quality gate; retrying with deterministic Horror titles: ' + error.message
        );
        rankedCandidates = this.normalizeTitleCandidates([], script, strategy, thumbnail)
          .map(candidate => this.scoreTitleCandidate(candidate, script, strategy, thumbnail))
          .sort((a, b) => b.score - a.score);
        selected = this.pickGatePassingCandidate(rankedCandidates);
        description = this.cleanDescription(this.generateDescription(script, strategy), script, strategy);
        packagingScore = this.calculatePackagingScore(
          selected,
          description,
          thumbnail,
          sources,
          chapters
        );
        this.assertAutonomousPackagingContract({
          selected,
          packagingScore,
          thumbnail,
          sources,
          strategy,
          description
        });
      }

      const packagingVariants = rankedCandidates.slice(0, 3).map((candidate, index) => ({
        label: index === 0 ? 'Primary' : 'Variant ' + (index + 1),
        title: candidate.title,
        mode: candidate.mode,
        rationale: candidate.rationale,
        score: candidate.score,
        thumbnailArchetype: thumbnail?.concept?.archetype || null,
        thumbnailComplementarity: candidate.scoring.thumbnailComplementarity
      }));

      const seoData = {
        title: selected.title,
        titleCandidates: rankedCandidates.slice(0, 3),
        packagingVariants,
        description,
        tags,
        hashtags,
        chapters,
        discoveryTerms,
        sources,
        endScreen,
        packagingScore,
        seoScore: packagingScore.overall,
        metadata: {
          primaryTopic: String(strategy.topic || script.title || '').trim(),
          searchIntent: this.inferSearchIntent(strategy),
          targetLength: this.calculateOptimalLength(strategy.contentType),
          language: 'en',
          category: this.selectCategory(strategy),
          thumbnailArchetype: thumbnail?.concept?.archetype || null,
          packagingStrategy: 'title-thumbnail-complementarity'
        },
        createdAt: new Date().toISOString()
      };

      if (this.db?.saveSEOData) await this.db.saveSEOData(seoData);
      this.logger.info('Packaging optimization complete. Score: ' + packagingScore.overall + '/100');
      return seoData;
    } catch (error) {
      this.logger.error('Failed to optimize Horror Stickman packaging:', error);
      throw error;
    }
  }

  async generatePackagingWithAI(script, strategy, thumbnail) {
    if (!this.aiTextService.isAvailable()) {
      this.logger.info('Using deterministic Horror Stickman packaging because no AI text provider is configured');
      return null;
    }

    const thumbnailBrief = thumbnail?.concept
      ? {
          archetype: thumbnail.concept.archetype,
          visualIdea: thumbnail.concept.visualIdea,
          text: thumbnail.concept.text || null
        }
      : null;

    const prompt = [
      'You are the Packaging & Metadata Agent of the Horror Stickman YouTube Shorts channel.',
      'Your only objective is to maximize feed curiosity and fear without spoiling the twist or using spam.',
      'Follow these rules strictly.',
      'CHANNEL: original fictional psychological micro-horror in a consistent Dark Stickman style.',
      'Create exactly 3 materially different English title candidates.',
      'Titles should usually be 28-78 characters, immediately understandable, specific, curiosity-driven, and frightening without gore.',
      'The title and first frame must complement each other. Do not reveal the final twist.',
      'Do not write TRUE STORY, BASED ON A TRUE STORY, SHOCKING, INSANE, YOU WONT BELIEVE, or fake superlatives.',
      'Do not mechanically reuse He Didnt Know, What He Found, At 3 AM, or any fixed sentence formula.',
      'No hashtag stuffing. Description should be concise, natural, and compatible with Shorts.',
      'Return 3-5 relevant hashtags, prioritizing #HorrorStories #ScaryStories #StickmanHorror when they fit.',
      'Tags are secondary; keep only precise horror/story terms.',
      'Titles lead with the most specific, strangest concrete detail and must read at a glance in a phone feed. No real brand names, real people, or real places tied to a crime in titles or descriptions.',
      'Silently score the candidates for curiosity, fear, specificity, spoiler safety, and first-frame complementarity and keep only the best three. Do not put scores or reasoning in the JSON.',
      'Return ONLY valid JSON:',
      '{"titleCandidates":[{"title":"","mode":"fear|curiosity|hybrid","rationale":""}],"description":"","discoveryTerms":[""],"tags":[""],"hashtags":[""]}',
      'Working title: ' + String(script.title || ''),
      'Premise: ' + String(strategy.topic || ''),
      'Hook: ' + String(script.hook?.text || script.hook || ''),
      'Fear mechanism: ' + String(strategy.fearMechanism || strategy.curiosityAngle || ''),
      'Twist boundary (DO NOT SPOIL): ' + String(strategy.payoff || ''),
      'First-frame direction: ' + JSON.stringify(thumbnailBrief)
    ].join('\n');

    try {
      const response = await this.aiTextService.generateText(prompt, {
        task: 'packaging',
        maxTokens: 1200,
        temperature: 0.72,
        responseMimeType: 'application/json'
      });
      const parsed = this.parseAIJsonResponse(response);
      if (!Array.isArray(parsed.titleCandidates) || parsed.titleCandidates.length < 3 || !parsed.description) {
        throw new Error('AI Horror packaging response missing required fields');
      }
      this.logger.info('Using AI Horror Stickman packaging via ' + this.aiTextService.providerName);
      return parsed;
    } catch (error) {
      this.logger.warn('AI Horror packaging failed; using deterministic fallback: ' + error.message);
      return null;
    }
  }

  assertAutonomousPackagingContract(input = {}) {
    if (String(process.env.AUTONOMOUS_MODE || '').toLowerCase() !== 'true') return true;
    const selected = input.selected || {};
    const score = selected.scoring || {};
    const packaging = input.packagingScore || {};
    const strategy = input.strategy || {};
    const failures = [];

    if (!selected.title || selected.title.length < 18 || selected.title.length > 90) failures.push('title length is not Shorts-ready');
    if (/\b(true story|based on a true story|shocking|insane|you won.t believe)\b/i.test(String(selected.title || ''))) failures.push('title uses banned horror clickbait/fake-truth framing');
    const twist = String(strategy.payoff || '').toLowerCase().replace(/[^a-z0-9\s]/g,' ').trim();
    const titleLower = String(selected.title || '').toLowerCase();
    if (twist.length >= 18 && twist.split(/\s+/).filter(w=>w.length>4).slice(0,3).filter(w=>titleLower.includes(w)).length >= 3) {
      failures.push('title appears to spoil the twist');
    }
    if (Number(selected.score || 0) < TITLE_GATE_MINIMUMS.score) failures.push(`title score below ${TITLE_GATE_MINIMUMS.score}`);
    if (Number(score.curiosity || 0) < TITLE_GATE_MINIMUMS.curiosity) failures.push(`title curiosity below ${TITLE_GATE_MINIMUMS.curiosity}`);
    if (Number(score.credibility || 0) < TITLE_GATE_MINIMUMS.credibility) failures.push(`title credibility below ${TITLE_GATE_MINIMUMS.credibility}`);
    if (Number(score.specificity || 0) < TITLE_GATE_MINIMUMS.specificity) failures.push(`title specificity below ${TITLE_GATE_MINIMUMS.specificity}`);
    if (Number(score.thumbnailComplementarity || 0) < TITLE_GATE_MINIMUMS.thumbnailComplementarity) failures.push(`title/first-frame complementarity below ${TITLE_GATE_MINIMUMS.thumbnailComplementarity}`);
    if (Number(packaging.overall || 0) < 86) failures.push('packaging score below 86');
    if (!input.thumbnail?.concept || Number(input.thumbnail.concept.score || 0) < 90) failures.push('visual hook concept below threshold');
    if (String(input.description || '').trim().length < 35) failures.push('description is too short');
    if (Number(strategy.brandFit || strategy.nicheFit || 0) < Number(nicheContract.hardGates?.brandFitMin || 9)) failures.push('strategy brand-fit gate was lost');
    if (Number(strategy.retentionPotential || 0) < Number(nicheContract.hardGates?.retentionPotentialMin || 9)) failures.push('strategy retention gate was lost');
    if (Number(strategy.payoffStrength || strategy.twistScore || 0) < 8) failures.push('twist/payoff strength is too low');

    if (failures.length) {
      const error = new Error(`Autonomous Horror packaging contract failed: ${failures.join('; ')}`);
      error.code = 'AUTONOMOUS_PACKAGING_CONTRACT';
      error.failures = failures;
      throw error;
    }
    return true;
  }

  parseAIJsonResponse(response) {
    return parseJsonResponse(response);
  }

  normalizeTitleCandidates(rawCandidates, script, strategy, thumbnail) {
    const incoming = Array.isArray(rawCandidates) ? rawCandidates : [];
    const fallbacks = this.buildFallbackTitleCandidates(script, strategy);
    const combined = [...incoming, ...fallbacks];
    const seen = new Set();
    const valid = [];
    for (const item of combined) {
      const title = this.sanitizeTitle(typeof item === 'string' ? item : item?.title);
      if (!title || seen.has(title.toLowerCase()) || this.hasBannedTitlePattern(title)) continue;
      if (/\b(true story|based on a true story)\b/i.test(title)) continue;
      seen.add(title.toLowerCase());
      valid.push({
        title,
        mode: ['fear','curiosity','hybrid'].includes(item?.mode) ? item.mode : this.classifyTitleMode(title),
        rationale: String(item?.rationale || this.defaultTitleRationale(title, thumbnail)).trim()
      });
      if (valid.length === 3) break;
    }
    while (valid.length < 3) {
      const bases = this.buildFallbackTitleCandidates(script, strategy);
      const candidate = bases[valid.length % bases.length];
      const title = this.sanitizeTitle(candidate.title);
      if (!seen.has(title.toLowerCase())) {
        seen.add(title.toLowerCase());
        valid.push(candidate);
      } else {
        const alt = this.sanitizeTitle(`${strategy.everydayAnchor || 'Something'} Was Wrong`);
        if (!seen.has(alt.toLowerCase())) {
          seen.add(alt.toLowerCase());
          valid.push({ title: alt, mode: 'curiosity', rationale: 'Preserves the fear premise without spoiling the twist.' });
        } else break;
      }
    }
    return valid.slice(0,3);
  }

  buildFallbackTitleCandidates(script, strategy) {
    const original = this.sanitizeTitle(script.title || strategy.topic || 'Something Was Wrong');
    const hook = this.sanitizeTitle(String(script.hook?.text || script.hook || '').replace(/[.!?…]+$/,''));
    const anchor = String(strategy.everydayAnchor || '').trim();
    const fear = String(strategy.fearMechanism || strategy.curiosityAngle || '').trim();
    const compactPremise = this.compactPremiseTitle(strategy.topic || script.title || original);
    const situational = this.sanitizeTitle(
      hook && hook.length >= 18 ? hook : (anchor ? `Something Was Wrong With ${anchor}` : original)
    );
    const second = this.sanitizeTitle(
      fear && fear.length >= 18 ? fear : `The ${anchor || 'Room'} Wasn't Empty`
    );
    return [
      { title: compactPremise || original, mode: 'hybrid', rationale: 'Compresses the approved premise into a specific Shorts-ready title without revealing the twist.' },
      { title: situational, mode: 'fear', rationale: 'Turns the opening situation into an immediate fear question.' },
      { title: second, mode: 'curiosity', rationale: 'Creates a specific unanswered threat while withholding the final reveal.' }
    ];
  }

  compactPremiseTitle(value) {
    const words = String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    let title = '';
    for (const word of words) {
      const next = title ? `${title} ${word}` : word;
      if (next.length > 78) break;
      title = next;
      if (title.length >= 54 && title.split(/\s+/).length >= 8) break;
    }
    return this.sanitizeTitle(title || value);
  }

  sanitizeTitle(value) {
    const title = String(value || '')
      .replace(/\s+/g, ' ')
      .replace(/\s+([:;,.!?])/g, '$1')
      .trim()
      .slice(0, 100);
    return title ? title.charAt(0).toUpperCase() + title.slice(1) : '';
  }

  hasBannedTitlePattern(title) {
    return BANNED_TITLE_PATTERNS.some(pattern => pattern.test(title));
  }

  classifyTitleMode(title) {
    if (/^(how|what|why|where|when|can|does|do|is|are)\b/i.test(title)) return 'hybrid';
    return 'intriguing';
  }

  defaultTitleRationale(_title, thumbnail) {
    return thumbnail?.concept?.archetype
      ? 'Adds editorial context to the ' + thumbnail.concept.archetype + ' visual without repeating it.'
      : 'Balances clarity, curiosity, and factual accuracy.';
  }

  /**
   * The ranked candidates are sorted by a single weighted composite score,
   * but the autonomous contract also enforces hard per-dimension minimums
   * (curiosity, specificity, credibility, thumbnailComplementarity). The
   * single highest composite score does not always clear every one of those
   * minimums even when a lower-ranked candidate would. Prefer the
   * highest-ranked candidate that clears every hard gate; only fall back to
   * the raw top score (and let assertAutonomousPackagingContract reject it)
   * when none of the candidates do.
   */
  pickGatePassingCandidate(rankedCandidates) {
    return rankedCandidates.find(candidate => this.titleMeetsHardGates(candidate)) || rankedCandidates[0];
  }

  titleMeetsHardGates(candidate) {
    const scoring = candidate?.scoring || {};
    return (
      Number(candidate?.score || 0) >= TITLE_GATE_MINIMUMS.score &&
      Number(scoring.curiosity || 0) >= TITLE_GATE_MINIMUMS.curiosity &&
      Number(scoring.credibility || 0) >= TITLE_GATE_MINIMUMS.credibility &&
      Number(scoring.specificity || 0) >= TITLE_GATE_MINIMUMS.specificity &&
      Number(scoring.thumbnailComplementarity || 0) >= TITLE_GATE_MINIMUMS.thumbnailComplementarity
    );
  }

  scoreTitleCandidate(candidate, script, strategy, thumbnail) {
    const title = candidate.title;
    const titleTokens = new Set(this.tokenize(title));
    const premiseTokens = this.tokenize(strategy.topic || script.title || '');
    const visualTokens = this.tokenize([thumbnail?.concept?.visualIdea, thumbnail?.concept?.text].filter(Boolean).join(' '));
    const premiseCoverage = premiseTokens.length
      ? Math.round((premiseTokens.filter(token => titleTokens.has(token)).length / premiseTokens.length) * 100)
      : 70;
    const visualOverlap = visualTokens.length ? visualTokens.filter(token => titleTokens.has(token)).length / visualTokens.length : 0;
    const clarity = title.length >= 24 && title.length <= 78 ? 98 : title.length <= 90 ? 88 : 72;
    const fearLanguage = /\b(heard|voice|inside|behind|alone|wrong|knock(?:ing|ed|s)?|door|walls?|mirror|reflection|message|camera|shadow|empty|bedroom|closet|hallway|elevator|floor|stairs|window|footsteps?|someone|something|locked|lock|signal|tracker|device|app|delay|suitcase|apartment|basement|attic|vent|intercom|speaker|screen|monitor|photo|text|call|number|static|flicker|glitch|breathing|watching|waiting|sprinted|running|bluetooth|gps)\b/i.test(title);
    const curiosity = fearLanguage ? 98 : /\b(why|what|when|who|where|how)\b/i.test(title) ? 92 : 88;
    const credibility = this.hasBannedTitlePattern(title) || /\b(true story|based on a true story)\b/i.test(title) ? 40 : 100;
    const specificity = Math.max(78, Math.min(100, 80 + Math.round(premiseCoverage * .20)));
    const thumbnailComplementarity = Math.max(78, Math.round(100 - visualOverlap * 20));
    const score = Math.round(clarity*.20 + curiosity*.27 + credibility*.23 + specificity*.16 + thumbnailComplementarity*.14);
    return { ...candidate, score, scoring:{clarity,curiosity,credibility,specificity,thumbnailComplementarity} };
  }

  tokenize(value) {
    const stop = new Set(['the','a','an','and','or','of','to','in','on','for','with','from','this','that','why','how','what']);
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2 && !stop.has(word));
  }

  generateDescription(script, strategy) {
    const hook = String(script.hook?.text || script.hook || '').trim();
    const premise = String(strategy.topic || script.title || '').trim();
    const opening = hook || premise;
    return `${opening}\n\nOriginal Dark Stickman psychological horror short. #HorrorStories #ScaryStories #StickmanHorror`.trim();
  }

  cleanDescription(description, script, strategy) {
    let value = String(description || '').trim();
    if (!value) value = this.generateDescription(script, strategy);
    value = value
      .replace(/\b(true story|based on a true story)\b/gi, 'fictional horror story')
      .replace(/\bThis documentary\b/gi, 'This horror short')
      .replace(/(?:#youtube|#youtuber|#subscribe|#viral|#trending|#new)\b/gi, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return value.slice(0, 900);
  }

  normalizeDiscoveryTerms(rawTerms, script, strategy) {
    const pool = [
      ...(Array.isArray(rawTerms) ? rawTerms : []),
      strategy.topic,
      ...(Array.isArray(strategy.keywords) ? strategy.keywords : []),
      ...(Array.isArray(script.keywords) ? script.keywords : [])
    ];
    const result = [];
    const seen = new Set();
    for (const term of pool) {
      const cleaned = String(term || '').trim().replace(/\s+/g, ' ');
      if (!cleaned || cleaned.length > 80 || seen.has(cleaned.toLowerCase())) continue;
      seen.add(cleaned.toLowerCase());
      result.push(cleaned);
      if (result.length >= 10) break;
    }
    return result;
  }

  buildTags(aiTags, discoveryTerms, strategy) {
    const pool = [
      ...(Array.isArray(aiTags) ? aiTags : []),
      ...discoveryTerms,
      ...(Array.isArray(strategy.keywords) ? strategy.keywords : [])
    ];
    const tags = [];
    const seen = new Set();
    let total = 0;
    for (const term of pool) {
      const cleaned = String(term || '').trim().replace(/^#/, '');
      if (!cleaned || cleaned.length > 80 || seen.has(cleaned.toLowerCase())) continue;
      if (/^(youtube|youtuber|subscribe|viral|trending|new|video)$/i.test(cleaned)) continue;
      if (total + cleaned.length + 1 > 500) break;
      seen.add(cleaned.toLowerCase());
      tags.push(cleaned);
      total += cleaned.length + 1;
      if (tags.length >= 12) break;
    }
    return tags;
  }

  buildHashtags(discoveryTerms) {
    const core = ['#HorrorStories','#ScaryStories','#StickmanHorror'];
    const extra = (discoveryTerms || [])
      .filter(term => /^[A-Za-z0-9 -]{3,40}$/.test(term))
      .map(term => '#' + term.replace(/[^A-Za-z0-9]/g, ''))
      .filter(tag => tag.length > 1 && !core.some(base => base.toLowerCase() === tag.toLowerCase()));
    return [...new Set([...core, ...extra])].slice(0,5);
  }

  collectSources(script, strategy) {
    const raw = [
      ...(Array.isArray(strategy.researchSources) ? strategy.researchSources : []),
      ...(Array.isArray(script.metadata?.strategy?.researchSources) ? script.metadata.strategy.researchSources : [])
    ];
    const seen = new Set();
    const sources = [];
    for (const source of raw) {
      const url = typeof source === 'string' ? source : source?.url;
      if (!/^https?:\/\//i.test(String(url || '')) || seen.has(url)) continue;
      seen.add(url);
      sources.push({
        url,
        title: typeof source === 'object' && source?.title ? String(source.title) : null
      });
    }
    return sources;
  }

  generateChapters(script) {
    const sections = Array.isArray(script.mainContent?.sections) ? script.mainContent.sections : [];
    if (sections.length < 2) return [];

    const normalized = sections
      .map(section => ({
        title: String(section.title || '').trim(),
        duration: Number(section.duration || 0)
      }))
      .filter(section => section.title && section.duration >= 10);

    if (normalized.length < 2) return [];
    const totalSeconds = normalized.reduce((sum, section) => sum + section.duration, 0);
    if (totalSeconds < 180) return [];

    const chapters = [{ time: '00:00', title: 'The Question', seconds: 0 }];
    let currentTime = Math.max(10, Number(script.hook?.duration || 20));
    for (const section of normalized) {
      chapters.push({
        time: this.formatTimestamp(currentTime),
        title: section.title,
        seconds: currentTime
      });
      currentTime += section.duration;
    }
    return chapters.length >= 3 ? chapters : [];
  }

  formatTimestamp(seconds) {
    const safe = Math.max(0, Math.floor(seconds));
    const minutes = Math.floor(safe / 60);
    const remainder = safe % 60;
    return String(minutes).padStart(2, '0') + ':' + String(remainder).padStart(2, '0');
  }

  calculatePackagingScore(selected, description, thumbnail, _sources, _chapters) {
    const title = selected?.scoring || {};
    const descriptionQuality = description.length >= 35 && description.length <= 900 && !/keyword dump|true story/i.test(description) ? 96 : 82;
    const thumbnailLink = thumbnail?.concept ? (title.thumbnailComplementarity || 85) : 80;
    const spoilerSafety = /\b(true story|based on a true story)\b/i.test(String(selected?.title || '')) ? 40 : 100;
    const overall = Math.round((selected?.score || 80)*.55 + descriptionQuality*.18 + thumbnailLink*.17 + spoilerSafety*.10);
    return { overall, title:selected?.score||80, description:descriptionQuality, thumbnailComplementarity:thumbnailLink, spoilerSafety };
  }

  inferSearchIntent(_strategy) {
    return 'horror-story-discovery';
  }

  async generateEndScreenStrategy() {
    return {
      elements: [],
      startTime: null,
      template: 'shorts-related-video',
      note: 'Use the YouTube Shorts Related Video surface when a genuinely related published Short exists.'
    };
  }

  calculateOptimalLength(_contentType) {
    return '20-45 seconds';
  }

  selectCategory(_strategy) {
    return 24;
  }

}

module.exports = { SEOOptimizerAgent };
