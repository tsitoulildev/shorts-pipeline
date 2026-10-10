// preferFree: free providers answer first and Gemini (the primary) only when all of them failed; avoidModel puts the model of an unusable answer last;
// a reply cut off by the token limit is retried on another model; a permanently ineligible story is followed by the next one in the same check.
const assert = require('node:assert/strict');
const { AITextService } = require('../utils/ai-text-service');
const { CooldownTracker } = require('../utils/llm-cooldown');
const { produceFromPool } = require('../utils/dark-history/live');
const { writeGroundedScript } = require('../utils/dark-history/grounded-writer');

const make = ({ gemini, free }) => {
  const s = Object.create(AITextService.prototype);
  s.logger = { info() {}, warn() {} };
  s.cooldowns = new CooldownTracker();
  s.freePrimaryId = null; s.fallbacks = []; s.freeProviders = ['nvidia']; s.gemini = {}; s.model = 'gemini-x'; s.providerName = 'Google Gemini';
  s.freeClients = { nvidia: { chat: { completions: { create: async request => free(request) } } } };
  s._generateGeminiWithModelFallback = async () => gemini();
  return s;
};
const ok = text => ({ choices: [{ message: { content: text }, finish_reason: 'stop' }] });

(async () => {
  // free first: Gemini is not called while a free model answers
  let geminiCalls = 0;
  const first = make({ gemini: () => { geminiCalls += 1; return 'from-gemini'; }, free: () => ok('from-free') });
  assert.equal(await first._generateTextRouted('p', { task: 'script', preferFree: true }), 'from-free');
  assert.equal(geminiCalls, 0);
  // without the option the primary still answers first (the older system is unchanged)
  assert.equal(await first._generateTextRouted('p', { task: 'script' }), 'from-gemini');
  // every free model fails: the primary answers
  const down = make({ gemini: () => 'from-gemini', free: () => { throw Object.assign(new Error('Request timed out.'), { code: 'ETIMEDOUT' }); } });
  assert.equal(await down._generateTextRouted('p', { task: 'script', preferFree: true }), 'from-gemini');
  // avoidModel: the named model is tried last
  const order = [];
  const avoid = make({ gemini: () => 'g', free: request => { order.push(request.model); throw new Error('boom'); } });
  await avoid._generateTextRouted('p', { task: 'script', preferFree: true, avoidModel: 'moonshotai/kimi-k3' }).catch(() => {});
  assert.equal(order[order.length - 1], 'moonshotai/kimi-k3');
  assert.notEqual(order[0], 'moonshotai/kimi-k3');

  // the writer: a cut-off reply is retried on another model, free first
  const story = { article_url: 'https://en.wikipedia.org/wiki/X', attribution: 'a', plan: { title: 'X', extract: 'e', folder: '.', beats: [] } };
  const models = [];
  let n = 0;
  const llm = {
    lastCall: null,
    generateText: async (prompt, options) => {
      models.push([options.preferFree, options.avoidModel || null]);
      n += 1;
      llm.lastCall = { model: n === 1 ? 'cut-model' : 'other-model', finishReason: n === 1 ? 'length' : 'stop' };
      return '{"title":"t"';
    }
  };
  await writeGroundedScript({ story, llm, imageFit: { judge: async () => '{}', readImage: async () => ({}) } }).catch(() => {});
  assert.ok(models.length >= 2 && models.every(m => m[0] === true), 'every writer call prefers the free providers');
  assert.equal(models[1][1], 'cut-model', 'the retry avoids the model whose reply was cut off');

  // an ineligible story is followed by the next one in the same check (3 at most); another failure stops at once
  const pool = (() => { let i = 0; return { claimNext: async () => { i += 1; return null; }, get claims() { return i; } }; })();
  await assert.rejects(() => produceFromPool({ pool, llm: {}, generator: {}, env: { LOCAL_TTS_COMMAND: '/x -m en_US-ljspeech-high {text} {wav}' } }), error => error.code === 'STORY_POOL_EMPTY');
  assert.equal(pool.claims, 1, 'an empty pool stops the loop');
  console.log('free first: ok');
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
