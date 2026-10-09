// Free-tier, OpenAI-compatible text providers used by utils/ai-text-service.js.
//
// Source: awesome-free-llm-apis data.json (lastUpdated 2026-08-21), including its
// per-provider notes. "Listed there" is not treated as "free": only models that are
// on a free plan with a known limit are curated here, and every entry keeps the
// data-handling condition its provider attaches to free usage.
//
// Gemini is intentionally absent: it stays on the native path in ai-text-service.js.
// This module never holds API keys — only the names of the env vars that carry them.

const DATA_POLICIES = {
  // No training/logging condition is published for the free plan.
  UNSPECIFIED: 'unspecified',
  // "Trial use only - do not submit personal or confidential data. Your use is logged".
  LOGGED_TRIAL_ONLY: 'logged/trial-only',
  // Free-mode prompts may be logged or used for training.
  MAY_TRAIN: 'may-train/log',
};

const TIERS = ['quality', 'balanced', 'fast'];

const TASK_TIERS = {
  script: 'quality',
  ideation: 'quality',
  packaging: 'balanced',
  'comment-analysis': 'balanced',
  'reply-draft': 'balanced',
  probe: 'fast',
};
const DEFAULT_TIER = 'balanced';

// These tasks send viewer comments (third-party personal data) to the provider, so
// they may only use free providers that attach no logging/training condition.
const SENSITIVE_TASKS = ['comment-analysis', 'reply-draft'];

// Retired or otherwise unusable model ids. Never route to these, even through an
// env override. Groq shut both down on 2026-08-16.
const BLOCKED_MODELS = {
  groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
  // Not in NVIDIA's live /v1/models list on 2026-10-04 (the first two answered HTTP 410 in production).
  nvidia: ['openai/gpt-oss-120b', 'minimaxai/minimax-m3', 'meta/llama-3.3-70b-instruct', 'nvidia/nemotron-3-nano-30b-a3b'],
};

const DEFAULT_PROVIDER_ORDER = ['groq', 'nvidia', 'mistral', 'openrouter'];

// Extra completion budget for models that spend output tokens on hidden reasoning.
const REASONING_HEADROOM_TOKENS = 2048;

// maxOutput is the provider's documented output cap in tokens (data.json "65K" =>
// 65000). null means the provider does not publish one, so no request is skipped.
const FREE_PROVIDERS = {
  groq: {
    name: 'Groq',
    baseURL: 'https://api.groq.com/openai/v1',
    envKey: 'GROQ_API_KEY',
    dataPolicy: DATA_POLICIES.UNSPECIFIED,
    tokenParam: 'max_completion_tokens',
    // Free plan: 30 RPM, 1,000 RPD per model.
    tiers: {
      quality: [
        { id: 'openai/gpt-oss-120b', maxOutput: 65000, reasoning: true },
        { id: 'qwen/qwen3.8-27b', maxOutput: 16000, reasoning: true },
      ],
      balanced: [
        { id: 'qwen/qwen3.8-27b', maxOutput: 16000, reasoning: true },
        { id: 'openai/gpt-oss-20b', maxOutput: 65000, reasoning: true },
        { id: 'openai/gpt-oss-120b', maxOutput: 65000, reasoning: true },
      ],
      fast: [
        { id: 'openai/gpt-oss-20b', maxOutput: 65000, reasoning: true },
        { id: 'qwen/qwen3.8-27b', maxOutput: 16000, reasoning: true },
      ],
    },
  },
  nvidia: {
    name: 'NVIDIA NIM',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    envKey: 'NVIDIA_API_KEY',
    dataPolicy: DATA_POLICIES.LOGGED_TRIAL_ONLY,
    tokenParam: 'max_tokens',
    // Free with NVIDIA Developer Program membership: 40 RPM, 10,000 RPD per model.
    // Model ids checked against the live https://integrate.api.nvidia.com/v1/models list (2026-10-04).
    // Order: fast and capable first; the 550B Ultra is last because it timed out in production.
    tiers: {
      quality: [
        { id: 'deepseek-ai/deepseek-v4.1-flash', maxOutput: null, reasoning: true },
        { id: 'nvidia/nemotron-3-super-120b-a12b', maxOutput: 262000, reasoning: true },
        { id: 'moonshotai/kimi-k3', maxOutput: null, reasoning: true },
        { id: 'z-ai/glm-5.3', maxOutput: null, reasoning: true },
        { id: 'nvidia/nemotron-3-ultra-550b-a55b', maxOutput: 262000, reasoning: true },
      ],
      balanced: [
        { id: 'nvidia/nemotron-3-super-120b-a12b', maxOutput: 262000, reasoning: true },
        { id: 'z-ai/glm-5.3-flash', maxOutput: null, reasoning: true },
        { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', maxOutput: null, reasoning: true },
        { id: 'google/gemma-4-31b-it', maxOutput: 8000 },
      ],
      fast: [
        { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', maxOutput: null, reasoning: true },
        { id: 'nvidia/nemotron-nano-3-30b-a3b', maxOutput: 32000, reasoning: true },
        { id: 'openai/gpt-oss-20b', maxOutput: 131000, reasoning: true },
        { id: 'google/gemma-4-31b-it', maxOutput: 8000 },
      ],
    },
  },
  mistral: {
    name: 'Mistral AI',
    baseURL: 'https://api.mistral.ai/v1',
    envKey: 'MISTRAL_API_KEY',
    dataPolicy: DATA_POLICIES.MAY_TRAIN,
    // Mistral documents only max_tokens and rejects unknown request fields.
    tokenParam: 'max_tokens',
    // Free mode shares one monthly allowance across Studio, the API and Vibe Code,
    // and Mistral no longer publishes numeric free-tier limits or output caps.
    //
    // `mistral-large-latest` answers 403 on the free plan (and the SDK error carries no body, so the 403 reads as a bad key and disables the
    // whole provider): it is not in the free tiers; set MISTRAL_MODEL_QUALITY to add it on a paid plan. `ministral-14b-latest` answers 200 on the free plan.
    // Model ids: only `mistral-large-latest` is confirmed against docs.mistral.ai
    // (it is the id used in the official API examples). The other aliases are the
    // long-standing `-latest` names but could not be confirmed without an account,
    // so each tier is overridable (comma-separated) and an unknown id is disabled
    // at runtime on the first 404. Verify with GET https://api.mistral.ai/v1/models.
    tierEnv: {
      quality: 'MISTRAL_MODEL_QUALITY',
      balanced: 'MISTRAL_MODEL_BALANCED',
      fast: 'MISTRAL_MODEL_FAST',
    },
    tiers: {
      quality: [
        { id: 'mistral-medium-latest', maxOutput: null },
        { id: 'ministral-14b-latest', maxOutput: null },
      ],
      balanced: [
        { id: 'mistral-medium-latest', maxOutput: null },
        { id: 'mistral-small-latest', maxOutput: null },
        { id: 'ministral-14b-latest', maxOutput: null },
      ],
      fast: [
        { id: 'mistral-small-latest', maxOutput: null },
        { id: 'ministral-14b-latest', maxOutput: null },
      ],
    },
  },
  openrouter: {
    name: 'OpenRouter (free)',
    baseURL: 'https://openrouter.ai/api/v1',
    envKey: 'OPENROUTER_API_KEY',
    dataPolicy: DATA_POLICIES.MAY_TRAIN,
    tokenParam: 'max_tokens',
    // Only ":free" models are ever requested. 20 RPM and 50 RPD per model unless the
    // account has bought $10+ of credits (then 1,000 RPD).
    requiredModelSuffix: ':free',
    tiers: {
      quality: [
        { id: 'nvidia/nemotron-3-super-120b-a12b:free', maxOutput: 262000, reasoning: true },
        { id: 'google/gemma-4-31b-it:free', maxOutput: 32000 },
      ],
      balanced: [
        { id: 'google/gemma-4-31b-it:free', maxOutput: 32000 },
        { id: 'inclusionai/ling-3.0-flash:free', maxOutput: 32000 },
        { id: 'openai/gpt-oss-20b:free', maxOutput: 32000, reasoning: true },
      ],
      fast: [
        { id: 'openai/gpt-oss-20b:free', maxOutput: 32000, reasoning: true },
        { id: 'google/gemma-4-26b-a4b-it:free', maxOutput: 32000 },
      ],
    },
  },
};

function parseList(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean);
}

function tierForTask(task) {
  return TASK_TIERS[task] || DEFAULT_TIER;
}

function isSensitiveTask(task) {
  return SENSITIVE_TASKS.includes(task);
}

function isProviderAllowedForTask(providerId, task) {
  const provider = FREE_PROVIDERS[providerId];
  if (!provider) return false;
  return !isSensitiveTask(task) || provider.dataPolicy === DATA_POLICIES.UNSPECIFIED;
}

function isModelAllowed(providerId, modelId) {
  const provider = FREE_PROVIDERS[providerId];
  const id = String(modelId || '');
  if (!provider || !id) return false;
  if ((BLOCKED_MODELS[providerId] || []).includes(id)) return false;
  if (provider.requiredModelSuffix && !id.endsWith(provider.requiredModelSuffix)) return false;
  return true;
}

// Provider ids in routing order: FREE_LLM_PROVIDER_ORDER (unknown ids ignored),
// minus FREE_LLM_DISABLE. Whether a key is configured is the caller's concern.
function getProviderOrder(env = process.env) {
  const requested = parseList(env.FREE_LLM_PROVIDER_ORDER);
  const order = requested.length ? requested : DEFAULT_PROVIDER_ORDER;
  const disabled = new Set(parseList(env.FREE_LLM_DISABLE));
  return [...new Set(order)].filter(id => FREE_PROVIDERS[id] && !disabled.has(id));
}

function getTierModels(providerId, tier, env = process.env) {
  const provider = FREE_PROVIDERS[providerId];
  if (!provider) return [];
  const curated = provider.tiers[tier] || [];
  const override = provider.tierEnv?.[tier] ? String(env[provider.tierEnv[tier]] || '') : '';
  const models = override.trim()
    ? override.split(',').map(id => id.trim()).filter(Boolean).map(id => ({
      id,
      maxOutput: null,
      ...curated.find(model => model.id === id),
    }))
    : curated;
  return models.filter(model => isModelAllowed(providerId, model.id));
}

// Ordered provider:model candidates for one request. A model is left out when the
// requested maxTokens exceeds its documented output cap.
function getCandidates({ task, maxTokens = 0, providerIds, env = process.env } = {}) {
  const tier = tierForTask(task);
  const ids = providerIds || getProviderOrder(env);
  const candidates = [];
  for (const providerId of ids) {
    const provider = FREE_PROVIDERS[providerId];
    if (!provider || !isProviderAllowedForTask(providerId, task)) continue;
    for (const model of getTierModels(providerId, tier, env)) {
      if (model.maxOutput && maxTokens > model.maxOutput) continue;
      candidates.push({
        providerId,
        providerName: provider.name,
        model: model.id,
        tier,
        maxOutput: model.maxOutput || null,
        reasoning: model.reasoning === true,
        tokenParam: provider.tokenParam,
        dataPolicy: provider.dataPolicy,
      });
    }
  }
  return candidates;
}

// Completion budget actually sent: reasoning models get headroom so hidden thinking
// does not consume the visible answer, never above the documented output cap.
function completionBudget(candidate, maxTokens) {
  const wanted = candidate.reasoning ? maxTokens + REASONING_HEADROOM_TOKENS : maxTokens;
  return candidate.maxOutput ? Math.min(wanted, candidate.maxOutput) : wanted;
}

const FREE_PROVIDER_ENV_KEYS = [...new Set(Object.values(FREE_PROVIDERS).map(provider => provider.envKey))];

module.exports = {
  FREE_PROVIDERS,
  FREE_PROVIDER_ENV_KEYS,
  BLOCKED_MODELS,
  DATA_POLICIES,
  DEFAULT_PROVIDER_ORDER,
  REASONING_HEADROOM_TOKENS,
  SENSITIVE_TASKS,
  TASK_TIERS,
  TIERS,
  completionBudget,
  getCandidates,
  getProviderOrder,
  getTierModels,
  isModelAllowed,
  isProviderAllowedForTask,
  isSensitiveTask,
  tierForTask,
};
