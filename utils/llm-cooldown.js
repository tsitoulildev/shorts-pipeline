// Per provider:model cooldown bookkeeping for free-tier LLM routing.
// In-memory only: a restart forgets cooldowns and the next 429 re-establishes them.

const TRANSIENT_BACKOFF_MS = [20 * 1000, 60 * 1000, 5 * 60 * 1000];
// A model that keeps timing out or answering with nothing: 20 s, 60 s, then out for 30 min (one success resets it).
const UNRESPONSIVE_BACKOFF_MS = [20 * 1000, 60 * 1000, 30 * 60 * 1000];
const DEFAULT_RATE_LIMIT_MS = 60 * 1000;
const MAX_DAILY_QUOTA_MS = 6 * 60 * 60 * 1000;

const DAILY_QUOTA_PATTERN = /per[\s_-]?day|daily|\brpd\b|\btpd\b|free-models-per-day|requests per day|tokens per day/i;
const MODEL_NOT_FOUND_PATTERN = /model.{0,60}(not found|does not exist|decommissioned|no longer (available|supported)|invalid model)|(unknown|invalid|no such) model|no endpoints found/i;
// A 403 that names the plan (Mistral free: `mistral-large-latest` is "not available in your subscription tier") is about ONE model, not the key.
const TIER_NOT_ALLOWED_PATTERN = /tier_not_allowed|not available in your (subscription )?tier|subscription tier/i;
const TRANSIENT_PATTERN = /timeout|timed out|temporar|unavailable|overloaded|high demand|connection error/i;
const TIMEOUT_PATTERN = /timeout|timed out/i;
const TRANSIENT_CODES = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN'];

function readHeader(error, name) {
  const headers = error?.headers || error?.response?.headers;
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined;
  const key = Object.keys(headers).find(item => item.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

// Retry-After as milliseconds (delta-seconds or HTTP-date), or null when absent.
function parseRetryAfterMs(error, now = Date.now()) {
  const ms = Number(readHeader(error, 'retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) return ms;

  const raw = readHeader(error, 'retry-after');
  if (raw === undefined || raw === null || raw === '') return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds > 0 ? seconds * 1000 : null;
  const date = Date.parse(String(raw));
  return Number.isFinite(date) && date > now ? date - now : null;
}

function msUntilUtcMidnight(now = Date.now()) {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1) - now;
}

class CooldownTracker {
  constructor(options = {}) {
    this.now = options.now || Date.now;
    this.cooldowns = new Map();
    this.transientFailures = new Map();
    this.unresponsive = new Map();
    this.stats = new Map();
    this.disabledModels = new Map();
    this.disabledProviders = new Map();
  }

  key(provider, model) {
    return `${provider}:${model}`;
  }

  isAvailable(provider, model) {
    if (this.disabledProviders.has(provider)) return false;
    const key = this.key(provider, model);
    if (this.disabledModels.has(key)) return false;
    return (this.cooldowns.get(key) || 0) <= this.now();
  }

  remainingMs(provider, model) {
    return Math.max(0, (this.cooldowns.get(this.key(provider, model)) || 0) - this.now());
  }

  state(provider, model) {
    if (this.disabledProviders.has(provider)) return 'provider-disabled';
    if (this.disabledModels.has(this.key(provider, model))) return 'model-disabled';
    return this.remainingMs(provider, model) > 0 ? 'cooldown' : 'ready';
  }

  recordSuccess(provider, model, ms = null) {
    const key = this.key(provider, model);
    this.cooldowns.delete(key);
    this.transientFailures.delete(key);
    this.unresponsive.delete(key);
    const stat = this._stat(key);
    stat.ok += 1;
    if (Number.isFinite(ms)) { stat.okMs += ms; stat.maxOkMs = Math.max(stat.maxOkMs, ms); }
  }

  _stat(key) {
    if (!this.stats.has(key)) this.stats.set(key, { ok: 0, okMs: 0, maxOkMs: 0, timeout: 0, empty: 0, rateLimited: 0, other: 0, expelled: 0 });
    return this.stats.get(key);
  }

  // Successes and failures per provider:model since the process started (real numbers for choosing the order of a tier).
  getStats() {
    return [...this.stats.entries()].map(([key, stat]) => ({
      model: key,
      ...stat,
      avgOkMs: stat.ok ? Math.round(stat.okMs / stat.ok) : null,
      failures: stat.timeout + stat.empty + stat.rateLimited + stat.other
    })).sort((a, b) => b.ok - a.ok || a.failures - b.failures);
  }

  // Classifies a failed request and applies the matching penalty.
  // options.isPrimary keeps an auth failure on the primary provider loud: it is
  // reported but never turned into a silent provider disable.
  recordFailure(provider, model, error, options = {}) {
    const outcome = this._classify(provider, model, error, options);
    const stat = this._stat(this.key(provider, model));
    const text = String(error?.message || '');
    if (outcome.action === 'rate-limited' || outcome.action === 'daily-quota') stat.rateLimited += 1;
    else if (String(error?.code || '').toUpperCase() === 'AI_EMPTY_RESPONSE') stat.empty += 1;
    else if (String(error?.code || '').toUpperCase() === 'ETIMEDOUT' || TIMEOUT_PATTERN.test(text)) stat.timeout += 1;
    else stat.other += 1;
    if (outcome.action === 'expelled') stat.expelled += 1;
    return outcome;
  }

  _classify(provider, model, error, options = {}) {
    const key = this.key(provider, model);
    const status = Number(error?.status || error?.response?.status || 0);
    const code = String(error?.code || '').toUpperCase();
    const message = String(error?.message || '');

    if (status === 403 && TIER_NOT_ALLOWED_PATTERN.test(message)) {
      this.disabledModels.set(key, 'HTTP 403 (tier)');
      return { action: 'model-disabled', ms: 0 };
    }

    if (status === 401 || status === 403) {
      if (options.isPrimary) return { action: 'auth-error', ms: 0 };
      this.disabledProviders.set(provider, `HTTP ${status}`);
      return { action: 'provider-disabled', ms: 0 };
    }

    // 410 Gone is how a provider answers for a retired model (NVIDIA did for two catalog entries); retrying it every run only wastes time.
    if (status === 404 || status === 410 || MODEL_NOT_FOUND_PATTERN.test(message)) {
      this.disabledModels.set(key, status ? `HTTP ${status}` : 'model not found');
      return { action: 'model-disabled', ms: 0 };
    }

    if (status === 429) {
      const retryAfter = parseRetryAfterMs(error, this.now());
      let ms = DEFAULT_RATE_LIMIT_MS;
      let action = 'rate-limited';
      if (retryAfter) {
        ms = retryAfter;
      } else if (DAILY_QUOTA_PATTERN.test(message)) {
        ms = Math.min(msUntilUtcMidnight(this.now()), MAX_DAILY_QUOTA_MS);
        action = 'daily-quota';
      }
      return this._cooldown(key, ms, action);
    }

    // A timeout or an empty answer: the next model is tried at once; a model that keeps doing it is put out for 30 min.
    const emptyAnswer = code === 'AI_EMPTY_RESPONSE';
    if (emptyAnswer || code === 'ETIMEDOUT' || TIMEOUT_PATTERN.test(message)) {
      const count = (this.unresponsive.get(key) || 0) + 1;
      this.unresponsive.set(key, count);
      const ms = UNRESPONSIVE_BACKOFF_MS[Math.min(count, UNRESPONSIVE_BACKOFF_MS.length) - 1];
      return this._cooldown(key, ms, count >= UNRESPONSIVE_BACKOFF_MS.length ? 'expelled' : 'transient');
    }

    const transient = status >= 500 || status === 408 || status === 409 ||
      TRANSIENT_CODES.includes(code) || TRANSIENT_PATTERN.test(message);
    if (transient) {
      const failures = (this.transientFailures.get(key) || 0) + 1;
      this.transientFailures.set(key, failures);
      const ms = TRANSIENT_BACKOFF_MS[Math.min(failures, TRANSIENT_BACKOFF_MS.length) - 1];
      return this._cooldown(key, ms, 'transient');
    }

    return { action: 'none', ms: 0 };
  }

  _cooldown(key, ms, action) {
    this.cooldowns.set(key, this.now() + ms);
    return { action, ms };
  }
}

module.exports = {
  CooldownTracker,
  parseRetryAfterMs,
  msUntilUtcMidnight,
  TRANSIENT_BACKOFF_MS,
  MAX_DAILY_QUOTA_MS,
};
