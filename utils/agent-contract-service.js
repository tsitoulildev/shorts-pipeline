class AgentContractService {
  constructor(options = {}) {
    this.logger = options.logger || null;
    this.version = '1.0';
  }

  requireObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw this.invalid(`${label} must be an object`);
    }
    return value;
  }

  requireText(value, label, max = 10000) {
    const text = String(value || '').trim();
    if (!text) throw this.invalid(`${label} is required`);
    if (text.length > max) throw this.invalid(`${label} exceeds ${max} characters`);
    return text;
  }

  requireArray(value, label) {
    if (!Array.isArray(value)) throw this.invalid(`${label} must be an array`);
    return value;
  }

  validateAgentRegistry(agents = {}) {
    const required = {
      strategy: ['generateContentStrategy'],
      scriptWriter: ['generateScript'],
      thumbnailDesigner: ['generateThumbnail'],
      seoOptimizer: ['optimize'],
      production: ['processContent'],
      publishing: ['scheduleContent'],
      analytics: ['getRecentAnalytics']
    };
    const failures = [];
    for (const [name, methods] of Object.entries(required)) {
      const agent = agents[name];
      if (!agent) {
        failures.push(`${name}: missing agent`);
        continue;
      }
      for (const method of methods) {
        if (typeof agent[method] !== 'function') failures.push(`${name}.${method}: missing method`);
      }
    }
    if (failures.length) {
      throw this.invalid(`Agent registry contract failed: ${failures.join('; ')}`);
    }
    return { version: this.version, agents: Object.keys(required) };
  }

  validateStrategy(strategy, options = {}) {
    const value = this.requireObject(strategy, 'strategy output');
    value.topic = this.requireText(value.topic, 'strategy.topic', 200);
    value.contentType = this.requireText(value.contentType, 'strategy.contentType', 30);
    value.angle = this.requireText(value.angle, 'strategy.angle', 1000);
    value.researchSources = this.requireArray(value.researchSources || [], 'strategy.researchSources');
    value.researchContext = this.requireArray(value.researchContext || [], 'strategy.researchContext');

    const productionMode = options.productionMode !== false;
    const fictional = value.fictional === true || String(value.provenanceMode || '').toLowerCase() === 'fictional';
    if (productionMode && !fictional && !value.researchSources.length) {
      throw this.invalid('strategy.researchSources is empty; factual production requires a research package');
    }

    let trustedResearchCount = 0;
    for (const [index, source] of value.researchSources.entries()) {
      if (typeof source === 'string') {
        if (!/^https?:\/\//i.test(source)) throw this.invalid(`strategy.researchSources[${index}] must be an http(s) URL`);
        if (productionMode) {
          throw this.invalid(`strategy.researchSources[${index}] must include verified provenance metadata in production mode`);
        }
        continue;
      }
      this.requireObject(source, `strategy.researchSources[${index}]`);
      this.requireText(source.url, `strategy.researchSources[${index}].url`, 2000);
      if (!/^https?:\/\//i.test(source.url)) throw this.invalid(`strategy.researchSources[${index}].url must be http(s)`);
      const trusted = source.retrievalStatus === 'fetched' || source.status === 'verified';
      if (trusted) trustedResearchCount += 1;
      if (productionMode && !trusted) {
        throw this.invalid(`strategy.researchSources[${index}] is not verified or fetched; production documentary generation requires trusted research evidence`);
      }
    }

    if (productionMode && !fictional && trustedResearchCount < 1) {
      throw this.invalid('strategy.researchSources contains no verified or fetched evidence');
    }

    return value;
  }

  validateScript(script, strategy) {
    const value = this.requireObject(script, 'script output');
    const sourceStrategy = this.requireObject(strategy, 'strategy handoff');
    value.title = this.requireText(value.title, 'script.title', 100);
    const sections = this.requireArray(value.mainContent?.sections, 'script.mainContent.sections');
    if (!sections.length) throw this.invalid('script.mainContent.sections cannot be empty');
    this.requireArray(value.claims || [], 'script.claims');

    const metadataTopic = String(value.metadata?.strategy?.topic || '').trim();
    if (metadataTopic && metadataTopic !== String(sourceStrategy.topic || '').trim()) {
      throw this.invalid('script.metadata.strategy.topic does not match the strategy agent topic');
    }

    const generatedByAI = value.metadata?.generationSource === 'ai';
    const fictional = sourceStrategy.fictional === true || value.metadata?.fictional === true;
    if (fictional) {
      if (sections.length < 4 || sections.length > 7) {
        throw this.invalid(`Horror Stickman scripts require 4-7 visual beats; got ${sections.length}`);
      }
      const spokenText = [
        value.hook?.text || value.hook,
        ...sections.flatMap(section => Array.isArray(section.content) ? section.content : [section.content]),
        value.callToAction?.subscribe || value.callToAction?.text
      ].filter(Boolean).join(' ');
      const spokenWords = Number(value.metadata?.spokenWordCount) || spokenText.split(/\s+/).filter(Boolean).length;
      if (spokenWords < 90 || spokenWords > 140) {
        throw this.invalid(`Horror Stickman scripts require 90-140 spoken words; got ${spokenWords}`);
      }
      if ((value.claims || []).length) {
        throw this.invalid('Original fictional Horror Stickman scripts must not declare factual provenance claims');
      }
    }
    for (const [index, section] of sections.entries()) {
      this.requireText(section.title, `script.mainContent.sections[${index}].title`, 300);
      const content = Array.isArray(section.content) ? section.content.join(' ') : section.content;
      this.requireText(content, `script.mainContent.sections[${index}].content`, 20000);
      if (generatedByAI) {
        this.requireText(section.visualQuery, `script.mainContent.sections[${index}].visualQuery`, 140);
        this.requireArray(section.visualRequiredAny || [], `script.mainContent.sections[${index}].visualRequiredAny`);
        this.requireArray(section.visualForbiddenAny || [], `script.mainContent.sections[${index}].visualForbiddenAny`);
      }
    }
    return value;
  }

  validateThumbnail(thumbnail) {
    const value = this.requireObject(thumbnail, 'thumbnail output');
    this.requireText(value.path, 'thumbnail.path', 4000);
    if (value.fileSize !== undefined && Number(value.fileSize) < 0) {
      throw this.invalid('thumbnail.fileSize cannot be negative');
    }
    return value;
  }

  validateSEO(seo) {
    const value = this.requireObject(seo, 'SEO output');
    this.requireText(value.title, 'seo.title', 100);
    this.requireText(value.description, 'seo.description', 5000);
    this.requireArray(value.tags || [], 'seo.tags');
    return value;
  }

  validateProduction(production, context = {}) {
    const value = this.requireObject(production, 'production output');
    this.requireText(value.id, 'production.id', 200);
    this.requireObject(value.assets, 'production.assets');
    this.requireObject(value.assets.video, 'production.assets.video');
    this.requireObject(value.assets.audio, 'production.assets.audio');
    this.requireObject(value.assets.finalVideo, 'production.assets.finalVideo');

    const expectedTopic = String(context.strategy?.topic || '').trim();
    const actualTopic = String(value.strategy?.topic || '').trim();
    if (expectedTopic && actualTopic !== expectedTopic) {
      throw this.invalid('production.strategy.topic does not match the strategy handoff');
    }
    const expectedTitle = String(context.script?.title || '').trim();
    const actualTitle = String(value.script?.title || '').trim();
    if (expectedTitle && actualTitle !== expectedTitle) {
      throw this.invalid('production.script.title does not match the script handoff');
    }

    const scenePlan = value.assets.video.scenePlan;
    if (!Array.isArray(scenePlan) || !scenePlan.length) {
      throw this.invalid('production.assets.video.scenePlan must contain at least one scene');
    }
    for (const [index, scene] of scenePlan.entries()) {
      if (Number(scene.index) !== index) {
        throw this.invalid(`production scene index contract failed at position ${index}`);
      }
      this.requireText(scene.label, `production scene ${index}.label`, 300);
      this.requireText(scene.narration, `production scene ${index}.narration`, 30000);
    }

    return value;
  }

  handoff(stage, artifact, context = {}) {
    let result;
    if (stage === 'strategy') result = this.validateStrategy(artifact, context);
    else if (stage === 'script') result = this.validateScript(artifact, context.strategy);
    else if (stage === 'thumbnail') result = this.validateThumbnail(artifact);
    else if (stage === 'seo') result = this.validateSEO(artifact);
    else if (stage === 'production') result = this.validateProduction(artifact, context);
    else result = artifact;

    this.logger?.info?.(`Agent handoff contract passed: ${stage} (v${this.version})`);
    return result;
  }

  invalid(message) {
    const error = new Error(`Agent communication contract: ${message}`);
    error.code = 'AGENT_CONTRACT_VIOLATION';
    error.status = 500;
    return error;
  }
}

module.exports = { AgentContractService };
