const OpenAI = require('openai');
const { Logger } = require('./logger');
const { CooldownTracker } = require('./llm-cooldown');
const {
  FREE_PROVIDERS,
  FREE_PROVIDER_ENV_KEYS,
  completionBudget,
  getCandidates,
  getProviderOrder,
  getTierModels,
  isModelAllowed,
  isSensitiveTask,
  tierForTask,
  TASK_TIERS,
} = require('./free-llm-catalog');

const GEMINI_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.1-pro-preview',
  'gemini-3.5-flash-lite',
];
const GEMINI_DEFAULT_MODEL = GEMINI_MODELS[0];
// Longest wait for a rate-limited free model to recover before the chain gives up (one retry).
const FREE_CHAIN_MAX_WAIT_MS = 20000;
const GEMINI_FREE_FALLBACK_MODELS = [
  'gemini-3.7-flash',
  'gemini-3.5-flash-lite',
];

const PROVIDERS = {
  openai: {
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.6',
    models: ['gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-luna'],
    envKey: 'OPENAI_API_KEY',
  },
  openrouter: {
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-5.6-sol',
    models: ['openai/gpt-5.6-sol', 'anthropic/claude-fable-5', 'google/gemini-3.7-flash', 'moonshotai/kimi-k3', 'z-ai/glm-5.3'],
    envKey: 'OPENROUTER_API_KEY',
  },
  kimi: {
    name: 'Kimi (Moonshot AI)',
    baseURL: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k3',
    models: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6'],
    envKey: 'MOONSHOT_API_KEY',
  },
  mimo: {
    name: 'MiMo (Xiaomi)',
    baseURL: 'https://api.xiaomimimo.com/v1',
    defaultModel: 'mimo-v2.5-pro',
    models: ['mimo-v2.5-pro', 'mimo-v2.5'],
    envKey: 'MIMO_API_KEY',
  },
  glm: {
    name: 'GLM (Zhipu AI)',
    baseURL: 'https://api.z.ai/api/paas/v4/',
    defaultModel: 'glm-5.3',
    models: ['glm-5.3', 'glm-5.2', 'glm-5.1'],
    envKey: 'GLM_API_KEY',
  },
};

// Every env var that can configure a text provider. Tests and the walkthrough clear
// exactly this list to isolate themselves from the host environment.
const TEXT_PROVIDER_ENV_KEYS = [...new Set([
  ...Object.values(PROVIDERS).map(provider => provider.envKey),
  'GEMINI_API_KEY',
  ...FREE_PROVIDER_ENV_KEYS,
])];

// Free-first policy, on by default like FREE_MEDIA_ONLY.
function isFreeLLMOnly() {
  return !/^(0|false|no)$/i.test(String(process.env.FREE_LLM_ONLY || 'true'));
}

// Reasoning models on free providers may inline their scratchpad in the answer.
function stripThinking(text) {
  let cleaned = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  // An unclosed block means the budget ran out mid-thought: nothing usable follows.
  cleaned = cleaned.replace(/<think>[\s\S]*$/i, '');
  // Some models emit only the closing tag after their reasoning.
  cleaned = cleaned.replace(/^[\s\S]*<\/think>/i, '');
  return cleaned.trim();
}

const LLM_USAGE = { calls: 0, ok: 0, failed: 0, totalMs: 0, since: new Date().toISOString() };

class AITextService {
  constructor(credentials = {}) {
    this.logger = new Logger('AITextService');
    this.client = null;
    this.gemini = null;
    this.model = null;
    this.providerName = null;
    this.fallbacks = [];
    this.exhaustedGeminiModels = new Map(); // model -> epoch ms when its daily free quota resets
    this.freeOnly = isFreeLLMOnly();
    this.freeProviders = [];
    this.freeClients = {};
    this.freePrimaryId = null;
    this.ignoredPaidEnvKeys = [];
    this.cooldowns = new CooldownTracker();

    this._initFreeProviders();
    this._initPrimary(credentials);
    this._initFallbacks(credentials);
  }

  _initFreeProviders() {
    const timeout = Math.max(1000, Number(process.env.FREE_LLM_TIMEOUT_MS) || 45000);
    for (const id of getProviderOrder()) {
      const preset = FREE_PROVIDERS[id];
      const apiKey = process.env[preset.envKey];
      if (!apiKey) continue;
      // No SDK retries: a rate-limited or slow free endpoint should hand over to the
      // next provider immediately instead of burning its quota on retries.
      this.freeClients[id] = new OpenAI({ apiKey, baseURL: preset.baseURL, maxRetries: 0, timeout });
      this.freeProviders.push(id);
    }
  }

  _initPrimary(credentials) {
    const provider = credentials.aiProvider?.provider;
    const apiKey = credentials.aiProvider?.apiKey;
    const model = credentials.aiProvider?.model;

    if (provider && PROVIDERS[provider] && apiKey) {
      return this._initOpenAICompatible(PROVIDERS[provider], apiKey, model);
    }

    if (!this.freeOnly) {
      for (const [, preset] of Object.entries(PROVIDERS)) {
        const key = process.env[preset.envKey];
        if (key) {
          return this._initOpenAICompatible(preset, key);
        }
      }
    } else {
      // OPENROUTER_API_KEY is not ignored: it serves the ":free" models only.
      this.ignoredPaidEnvKeys = Object.values(PROVIDERS)
        .map(preset => preset.envKey)
        .filter(envKey => envKey !== FREE_PROVIDERS.openrouter.envKey && process.env[envKey]);
      if (this.ignoredPaidEnvKeys.length) {
        this.logger.warn(`FREE_LLM_ONLY is on: ignoring paid text provider key(s) ${this.ignoredPaidEnvKeys.join(', ')}. Set FREE_LLM_ONLY=false or an explicit aiProvider to use them.`);
      }
    }

    const geminiKey = credentials.gemini?.apiKey || process.env.GEMINI_API_KEY;
    if (geminiKey) {
      return this._initGemini(geminiKey, credentials.gemini?.model);
    }

    const freeId = this.freeProviders[0];
    if (freeId) {
      const preset = FREE_PROVIDERS[freeId];
      this.freePrimaryId = freeId;
      this.client = this.freeClients[freeId];
      this.model = getTierModels(freeId, tierForTask())[0]?.id || null;
      this.providerName = preset.name;
      this.logger.info(`${preset.name} initialized as free primary (model chosen per task)`);
      return;
    }

    this.logger.warn('No AI text provider configured — text generation unavailable');
  }

  _initFallbacks(credentials) {
    const primary = String(this.providerName || '').toLowerCase();

    const openRouterKey = process.env.OPENROUTER_API_KEY ||
      (credentials.aiProvider?.provider === 'openrouter' ? credentials.aiProvider?.apiKey : '');
    // Under FREE_LLM_ONLY the paid OpenRouter default is replaced by the ":free"
    // OpenRouter entry of the free catalog.
    if (!this.freeOnly && openRouterKey && !primary.includes('openrouter')) {
      const preset = PROVIDERS.openrouter;
      this.fallbacks.push({
        type: 'openai-compatible',
        name: preset.name,
        client: new OpenAI({ apiKey: openRouterKey, baseURL: preset.baseURL }),
        model: credentials.aiProvider?.provider === 'openrouter' && credentials.aiProvider?.model
          ? credentials.aiProvider.model
          : preset.defaultModel
      });
    }

    const geminiKey = credentials.gemini?.apiKey || process.env.GEMINI_API_KEY;
    if (geminiKey && !primary.includes('gemini')) {
      try {
        const { GoogleGenAI } = require('@google/genai');
        this.fallbacks.push({
          type: 'gemini',
          name: 'Google Gemini',
          client: new GoogleGenAI({ apiKey: geminiKey }),
          model: credentials.gemini?.model || process.env.GEMINI_TEXT_MODEL || GEMINI_DEFAULT_MODEL
        });
      } catch (error) {
        this.logger.warn(`Gemini fallback could not initialize: ${error.message}`);
      }
    }

    const names = [
      ...this.fallbacks.map(item => item.name),
      ...this.freeProviders.filter(id => id !== this.freePrimaryId).map(id => FREE_PROVIDERS[id].name),
    ];
    if (names.length) {
      this.logger.info(`Text failover ready: ${this.providerName || 'none'} -> ${names.join(' -> ')}`);
    }

    // One provider is a single point of failure: when its daily free quota runs out
    // (Gemini does this), every text task stops instead of moving to another model.
    if (this.redundancy().singlePoint) {
      this.logger.warn(`Only one text provider is configured (${this.providerName}). When its free quota is exhausted all text generation stops. Add GROQ_API_KEY (free) and optionally OPENROUTER_API_KEY to the environment, then check with: npm run readiness:providers`);
    }
  }

  // Number of independent text providers in the failover chain (secret-free).
  redundancy() {
    const primary = this.providerName ? 1 : 0;
    const fallbacks = (this.fallbacks || []).length;
    const free = (this.freeProviders || []).filter(id => id !== this.freePrimaryId).length;
    const count = primary + fallbacks + free;
    return { count, singlePoint: count === 1 };
  }

  _initOpenAICompatible(preset, apiKey, model) {
    this.client = new OpenAI({ apiKey, baseURL: preset.baseURL });
    this.model = model || preset.defaultModel;
    this.providerName = preset.name;
    this.logger.info(`${preset.name} initialized (model: ${this.model})`);
  }

  _initGemini(apiKey, model) {
    try {
      const { GoogleGenAI } = require('@google/genai');
      this.gemini = new GoogleGenAI({ apiKey });
      this.model = model || process.env.GEMINI_TEXT_MODEL || GEMINI_DEFAULT_MODEL;
      this.providerName = 'Google Gemini';
      this.logger.info(`Gemini initialized (model: ${this.model})`);
    } catch (error) {
      this.logger.error('Failed to initialize Gemini:', error.message);
    }
  }

  shouldFallback(error) {
    if (error?.code === 'AI_EMPTY_RESPONSE') return false;
    const status = Number(error?.status || error?.response?.status || 0);
    const code = String(error?.code || '').toUpperCase();
    const message = String(error?.message || '').toLowerCase();
    return [408, 409, 429].includes(status) ||
      status >= 500 ||
      ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN'].includes(code) ||
      /high demand|quota|rate limit|temporar|timeout|timed out|unavailable|overloaded/.test(message);
  }

  // Secret-free, process-wide usage counters so LLM load per Short can be measured.
  static usageSnapshot() {
    return { ...LLM_USAGE, avgMs: LLM_USAGE.calls ? Math.round(LLM_USAGE.totalMs / LLM_USAGE.calls) : 0 };
  }

  static resetUsage() {
    LLM_USAGE.calls = 0; LLM_USAGE.ok = 0; LLM_USAGE.failed = 0; LLM_USAGE.totalMs = 0;
    LLM_USAGE.since = new Date().toISOString();
  }

  async generateText(prompt, options = {}) {
    const started = Date.now();
    LLM_USAGE.calls += 1;
    try {
      const result = await this._generateTextRouted(prompt, options);
      LLM_USAGE.ok += 1;
      return result;
    } catch (error) {
      LLM_USAGE.failed += 1;
      throw error;
    } finally {
      LLM_USAGE.totalMs += Date.now() - started;
    }
  }

  async _generateTextRouted(prompt, options = {}) {
    const model = options.model || this.model;
    const maxTokens = options.maxTokens || 2048;
    const temperature = options.temperature ?? 0.7;
    const fallbacks = this.fallbacks || [];

    if (this.freePrimaryId) {
      return this._generateWithFreePrimary(prompt, options, maxTokens, temperature);
    }

    let primaryError = null;
    try {
      // A caller whose previous answer from the primary provider was unusable (e.g. a script that broke its
      // contract) can ask for a different provider. Without this the failover chain only ran when the
      // primary threw, so a weak but "successful" model was retried forever.
      if (options.skipPrimary && (fallbacks.length > 0 || this._freeCandidates(options, maxTokens).length > 0)) {
        this.logger.info('Skipping the primary text provider for this attempt (previous answer was unusable)');
        throw Object.assign(new Error('primary provider skipped for this attempt (unavailable)'), { status: 503 });
      }
      if (this.gemini) {
        return await this._generateGeminiWithModelFallback(
          this.gemini,
          this.providerName || 'Google Gemini',
          model,
          prompt,
          options
        );
      }
      if (this.client) {
        return await this._generateOpenAICompatible(
          this.client,
          this.providerName || 'AI provider',
          model,
          prompt,
          maxTokens,
          temperature
        );
      }
      throw new Error('No AI text provider configured');
    } catch (error) {
      primaryError = error;
    }

    const freeCandidates = this._freeCandidates(options, maxTokens);
    const hasFallbacks = fallbacks.length > 0 || freeCandidates.length > 0;
    // An empty body is not retried on its own, but another provider may well answer.
    const emptyWithFallbacks = primaryError?.code === 'AI_EMPTY_RESPONSE' && hasFallbacks;
    if ((!this.shouldFallback(primaryError) && !emptyWithFallbacks) || !hasFallbacks) {
      throw primaryError;
    }

    const failures = [`${this.providerName || 'Primary provider'}: ${primaryError.message}`];
    for (const fallback of fallbacks) {
      try {
        this.logger.warn(`${this.providerName || 'Primary AI provider'} failed; trying ${fallback.name}: ${primaryError.message}`);
        if (fallback.type === 'gemini') {
          return await this._generateGemini(
            fallback.client,
            fallback.name,
            options.fallbackModel || fallback.model,
            prompt,
            options
          );
        }
        return await this._generateOpenAICompatible(
          fallback.client,
          fallback.name,
          options.fallbackModel || fallback.model,
          prompt,
          maxTokens,
          temperature
        );
      } catch (error) {
        failures.push(`${fallback.name}: ${error.message}`);
      }
    }

    const result = await this._runFreeChainPatient(freeCandidates, prompt, maxTokens, temperature, failures);
    if (result.ok) return result.text;

    throw new Error(`All configured text providers failed: ${failures.join(' | ')}`);
  }

  _cooldowns() {
    return this.cooldowns || (this.cooldowns = new CooldownTracker());
  }

  // Free provider:model candidates for this request, in routing order. Tasks that
  // carry viewer comments are limited by the catalog to providers that attach no
  // logging/training condition to free usage.
  _freeCandidates(options = {}, maxTokens = options.maxTokens || 2048) {
    const providerIds = this.freeProviders || [];
    if (!providerIds.length) return [];
    return getCandidates({ task: options.task, maxTokens, providerIds });
  }

  async _generateWithFreePrimary(prompt, options, maxTokens, temperature) {
    let candidates = this._freeCandidates(options, maxTokens);
    if (options.skipPrimary) {
      const others = candidates.filter(candidate => candidate.providerId !== this.freePrimaryId);
      if (others.length) candidates = others;
    }
    if (!options.skipPrimary && options.model && isModelAllowed(this.freePrimaryId, options.model)) {
      const preset = FREE_PROVIDERS[this.freePrimaryId];
      candidates.unshift({
        providerId: this.freePrimaryId,
        providerName: preset.name,
        model: options.model,
        tier: tierForTask(options.task),
        maxOutput: null,
        reasoning: false,
        tokenParam: preset.tokenParam,
        dataPolicy: preset.dataPolicy,
      });
    }
    if (!candidates.length) {
      throw new Error(isSensitiveTask(options.task)
        ? `No configured free text provider may receive viewer comments for task "${options.task}" (GROQ_API_KEY, GEMINI_API_KEY or an explicit aiProvider is required)`
        : 'No free text model can serve this request');
    }

    const failures = [];
    const result = await this._runFreeChainPatient(candidates, prompt, maxTokens, temperature, failures);
    if (result.ok) return result.text;
    if (result.lastError && failures.length === 1) throw result.lastError;
    throw new Error(`All configured text providers failed: ${failures.join(' | ')}`);
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Free plans limit tokens per minute, and the error says when to retry (often 1-15 s). When every candidate
  // failed and the shortest cooldown is that short, wait for it once instead of giving up on the whole chain
  // (the script writer then fell back to its emergency script although Groq would have answered a few seconds later).
  async _runFreeChainPatient(candidates, prompt, maxTokens, temperature, failures) {
    const result = await this._runFreeChain(candidates, prompt, maxTokens, temperature, failures);
    if (result.ok) return result;
    const tracker = this._cooldowns();
    const waits = candidates
      .filter(candidate => tracker.state(candidate.providerId, candidate.model) === 'cooldown')
      .map(candidate => tracker.remainingMs(candidate.providerId, candidate.model))
      .filter(ms => ms > 0);
    if (!waits.length) return result;
    const wait = Math.min(...waits);
    if (wait > FREE_CHAIN_MAX_WAIT_MS) return result;
    this.logger?.info?.(`All free text models are rate-limited; waiting ${Math.round(wait / 100) / 10}s for the first to recover`);
    await this._sleep(wait + 250);
    return this._runFreeChain(candidates, prompt, maxTokens, temperature, failures);
  }

  async _runFreeChain(candidates, prompt, maxTokens, temperature, failures) {
    const tracker = this._cooldowns();
    let lastError = null;
    let skipped = 0;

    for (const candidate of candidates) {
      if (!tracker.isAvailable(candidate.providerId, candidate.model)) {
        skipped += 1;
        continue;
      }
      const isPrimary = candidate.providerId === this.freePrimaryId;
      const client = isPrimary && this.client ? this.client : (this.freeClients || {})[candidate.providerId];
      const label = `${candidate.providerName} ${candidate.model}`;
      try {
        const text = await this._generateFree(client, candidate, prompt, maxTokens, temperature);
        tracker.recordSuccess(candidate.providerId, candidate.model);
        return { ok: true, text };
      } catch (error) {
        const outcome = tracker.recordFailure(candidate.providerId, candidate.model, error, { isPrimary });
        // A rejected key on the primary provider must stay loud, never a silent failover.
        if (outcome.action === 'auth-error') throw error;
        lastError = error;
        failures.push(`${label}: ${error.message}`);
        if (outcome.action === 'provider-disabled') {
          this.logger?.warn(`${candidate.providerName} rejected its API key (${candidate.providerId} disabled until restart); check ${FREE_PROVIDERS[candidate.providerId].envKey}`);
        } else {
          const penalty = outcome.ms ? `, cooling down ${Math.round(outcome.ms / 1000)}s` : '';
          this.logger?.warn(`${label} failed (${outcome.action}${penalty}); trying next free model: ${error.message}`);
        }
      }
    }

    if (skipped) failures.push(`${skipped} free model(s) skipped (cooling down or disabled)`);
    return { ok: false, lastError };
  }

  async _generateFree(client, candidate, prompt, maxTokens, temperature) {
    const response = await client.chat.completions.create({
      model: candidate.model,
      messages: [{ role: 'user', content: prompt }],
      temperature,
      [candidate.tokenParam]: completionBudget(candidate, maxTokens),
    });
    const content = stripThinking(this._extractContent(response, candidate.providerName));
    this.lastCall = { provider: candidate.providerName, model: candidate.model, finishReason: response?.choices?.[0]?.finish_reason || null };
    if (!content) {
      const error = new Error(`${candidate.providerName} returned an empty response. The provider response did not satisfy the text-agent contract.`);
      error.code = 'AI_EMPTY_RESPONSE';
      throw error;
    }
    return content;
  }

  // Secret-free view of the routing chain for readiness reports.
  describeChain() {
    const tracker = this._cooldowns();
    const fallbacks = this.fallbacks || [];
    const freeProviders = this.freeProviders || [];
    const tasks = {};
    for (const task of Object.keys(TASK_TIERS)) {
      const chain = [];
      if (!this.freePrimaryId && (this.client || this.gemini)) {
        chain.push({ provider: this.providerName, model: this.model, role: 'primary' });
      }
      for (const fallback of fallbacks) {
        chain.push({ provider: fallback.name, model: fallback.model, role: 'fallback' });
      }
      for (const candidate of this._freeCandidates({ task }, 0)) {
        chain.push({
          provider: candidate.providerName,
          model: candidate.model,
          role: candidate.providerId === this.freePrimaryId ? 'primary' : 'fallback',
          dataPolicy: candidate.dataPolicy,
          state: tracker.state(candidate.providerId, candidate.model),
        });
      }
      tasks[task] = { tier: tierForTask(task), sensitive: isSensitiveTask(task), chain };
    }
    return {
      freeOnly: this.freeOnly !== false,
      primary: this.providerName || null,
      redundancy: this.redundancy(),
      freeProviders: [...freeProviders],
      ignoredPaidEnvKeys: [...(this.ignoredPaidEnvKeys || [])],
      tasks,
    };
  }

  isDailyGeminiQuotaExhausted(error) {
    const status = Number(error?.status || error?.response?.status || 0);
    const message = String(error?.message || '');
    return status === 429 && /GenerateRequestsPerDayPerProjectPerModel-FreeTier|free[_ -]?tier.*requests.*per day|requests per day per project per model/i.test(message);
  }

  /** Epoch ms of the next Gemini free-tier daily reset (midnight Pacific time). */
  nextGeminiQuotaReset(now = Date.now()) {
    try {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit'
      }).formatToParts(new Date(now)).map(part => [part.type, Number(part.value)]));
      const secondsIntoDay = parts.hour * 3600 + parts.minute * 60 + parts.second;
      return now + (86400 - secondsIntoDay) * 1000;
    } catch {
      return now + 6 * 3600 * 1000;
    }
  }

  isGeminiModelExhausted(model, now = Date.now()) {
    const exhausted = this.exhaustedGeminiModels || (this.exhaustedGeminiModels = new Map());
    const resetAt = exhausted.get(model);
    if (resetAt === undefined) return false;
    // The daily quota resets by itself; without this a process that hit the limit once skipped the model
    // until the next restart, long after the quota had come back.
    if (now >= resetAt) {
      exhausted.delete(model);
      return false;
    }
    return true;
  }

  async _generateGeminiWithModelFallback(client, providerName, model, prompt, options = {}) {
    const candidates = [...new Set([model, ...GEMINI_FREE_FALLBACK_MODELS].filter(Boolean))];
    const exhausted = this.exhaustedGeminiModels || (this.exhaustedGeminiModels = new Map());
    let lastError = null;

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (this.isGeminiModelExhausted(candidate)) {
        this.logger.warn(`${providerName} model ${candidate} skipped because its daily free-tier quota was exhausted (resets ${new Date(exhausted.get(candidate)).toISOString()})`);
        continue;
      }
      try {
        return await this._generateGemini(client, providerName, candidate, prompt, options);
      } catch (error) {
        lastError = error;
        if (this.isDailyGeminiQuotaExhausted(error)) exhausted.set(candidate, this.nextGeminiQuotaReset());
        const remaining = candidates.slice(index + 1).find(next => !this.isGeminiModelExhausted(next));
        if (!remaining || !this.shouldFallback(error)) throw error;
        this.logger.warn(`${providerName} model ${candidate} unavailable; trying free Gemini fallback ${remaining}: ${error.message}`);
      }
    }

    throw lastError || new Error('All free Gemini text models failed');
  }

  async _generateGemini(client, providerName, model, prompt, options = {}) {
    const maxTokens = options.maxTokens || 2048;
    const temperature = options.temperature ?? 0.7;
    const config = { maxOutputTokens: maxTokens };
    if (!/^gemini-3\.(?:[5-9]|\d{2,})-/.test(model)) config.temperature = temperature;
    if (/^gemini-3\./.test(model) && options.thinkingLevel) {
      config.thinkingConfig = { thinkingLevel: options.thinkingLevel };
    }
    if (options.responseMimeType) {
      config.responseMimeType = options.responseMimeType;
    }

    const timeoutMs = Math.max(
      5000,
      Number(options.timeoutMs || process.env.GEMINI_TEXT_TIMEOUT_MS || 25000)
    );
    let timeoutHandle = null;
    let response;
    try {
      response = await Promise.race([
        client.models.generateContent({
          model,
          contents: prompt,
          config,
        }),
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => {
            const error = new Error(`${providerName} request timed out after ${timeoutMs}ms`);
            error.code = 'ETIMEDOUT';
            reject(error);
          }, timeoutMs);
        })
      ]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
    const text = response && response.text;
    if (typeof text !== 'string' || !text.trim()) {
      const error = new Error(`${providerName} returned an empty response. The provider response did not satisfy the text-agent contract.`);
      error.code = 'AI_EMPTY_RESPONSE';
      throw error;
    }
    this.lastCall = { provider: providerName, model, finishReason: response?.candidates?.[0]?.finishReason || null };
    return text;
  }

  async _generateOpenAICompatible(client, providerName, model, prompt, maxTokens, temperature) {
    const params = {
      model,
      messages: [{ role: 'user', content: prompt }],
    };
    if (!/(^|\/)gpt-5\.6(?:-|$)/i.test(String(model || ''))) {
      params.temperature = temperature;
    }

    try {
      const response = await client.chat.completions.create({
        ...params,
        max_completion_tokens: maxTokens,
      });
      this.lastCall = { provider: providerName, model, finishReason: response?.choices?.[0]?.finish_reason || null };
      return this._extractContent(response, providerName);
    } catch (error) {
      if (
        error &&
        error.status === 400 &&
        /max(_completion)?_tokens/i.test(error.message || '')
      ) {
        const response = await client.chat.completions.create({
          ...params,
          max_tokens: maxTokens,
        });
        this.lastCall = { provider: providerName, model, finishReason: response?.choices?.[0]?.finish_reason || null };
        return this._extractContent(response, providerName);
      }
      throw error;
    }
  }

  _extractContent(response, providerName = this.providerName) {
    const content =
      response &&
      response.choices &&
      response.choices[0] &&
      response.choices[0].message
        ? response.choices[0].message.content
        : null;

    if (typeof content !== 'string' || !content.trim()) {
      const error = new Error(
        `${providerName || 'AI provider'} returned an empty response. The provider response did not satisfy the text-agent contract.`
      );
      error.code = 'AI_EMPTY_RESPONSE';
      throw error;
    }
    return content;
  }

  isAvailable() {
    return !!(this.client || this.gemini || (this.fallbacks || []).length || (this.freeProviders || []).length);
  }
}

module.exports = { AITextService, PROVIDERS, GEMINI_MODELS, GEMINI_DEFAULT_MODEL, TEXT_PROVIDER_ENV_KEYS };
