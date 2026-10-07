// Offline: the text chain reports how many independent providers it has and warns
// loudly when there is only one (a daily free quota then stops all text generation).
const assert = require('assert');
const { AITextService, TEXT_PROVIDER_ENV_KEYS } = require('../utils/ai-text-service');

const saved = Object.fromEntries(TEXT_PROVIDER_ENV_KEYS.map(key => [key, process.env[key]]));
const savedFlags = { FREE_LLM_ONLY: process.env.FREE_LLM_ONLY, FREE_LLM_PROVIDER_ORDER: process.env.FREE_LLM_PROVIDER_ORDER };

const Logger = require('../utils/logger');
const LoggerClass = Logger.Logger || Logger;

function build(env) {
  for (const key of TEXT_PROVIDER_ENV_KEYS) delete process.env[key];
  delete process.env.FREE_LLM_PROVIDER_ORDER;
  process.env.FREE_LLM_ONLY = 'true';
  Object.assign(process.env, env);
  const warnings = [];
  const originalWarn = LoggerClass.prototype.warn;
  LoggerClass.prototype.warn = function warn(message) { warnings.push(String(message)); };
  try {
    return { service: new AITextService({}), warnings };
  } finally {
    LoggerClass.prototype.warn = originalWarn;
  }
}

try {
  const none = build({});
  assert.deepStrictEqual(none.service.redundancy(), { count: 0, singlePoint: false });
  assert.ok(!none.warnings.some(w => /Only one text provider/.test(w)), 'no provider is reported by its own warning, not as a single point of failure');

  const gemini = build({ GEMINI_API_KEY: 'test-key' });
  assert.deepStrictEqual(gemini.service.redundancy(), { count: 1, singlePoint: true });
  assert.strictEqual(gemini.warnings.length, 1);
  assert.ok(/GROQ_API_KEY/.test(gemini.warnings[0]) && !/test-key/.test(gemini.warnings[0]));

  const geminiGroq = build({ GEMINI_API_KEY: 'test-key', GROQ_API_KEY: 'test-groq' });
  assert.strictEqual(geminiGroq.service.redundancy().count, 2);
  assert.strictEqual(geminiGroq.service.redundancy().singlePoint, false);
  assert.ok(!geminiGroq.warnings.some(w => /Only one text provider/.test(w)));
  assert.strictEqual(geminiGroq.service.describeChain().redundancy.count, 2);

  const groqOnly = build({ GROQ_API_KEY: 'test-groq' });
  assert.strictEqual(groqOnly.service.redundancy().count, 1);
  assert.strictEqual(groqOnly.warnings.length, 1);
  console.log('Provider redundancy tests passed');
} finally {
  for (const key of TEXT_PROVIDER_ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
  for (const [key, value] of Object.entries(savedFlags)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
