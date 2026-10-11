// Dark History yield statistics: causes of a rejection are classified, results are counted per day, role and model, and the report adds them to the jobs.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Database } = require('../database/db');
const { YieldStats, classifyNote, causesOf } = require('../utils/dark-history/yield-stats');
const { AITextService } = require('../utils/ai-text-service');
const { CooldownTracker } = require('../utils/llm-cooldown');

assert.equal(classifyNote('beat 1: amount "Two" is not in its evidence'), 'number word not in evidence');
assert.equal(classifyNote('beat 3: number "24" is not in its evidence'), 'number not in evidence');
assert.equal(classifyNote('beat 2: evidence not found verbatim in the source: "x"'), 'evidence not verbatim');
assert.equal(classifyNote('beat 2: the source does not support "A map shows".'), 'sentence not supported');
assert.equal(classifyNote('beat 4: "Brummer" does not appear in the source'), 'name or quote not in source');
assert.equal(classifyNote('beat 2: the picture does not show what the narration says (the check gave no verdict for this beat)'), 'picture does not fit');
assert.equal(classifyNote('the narration is 52 words; it must be 70-100'), 'word count');
assert.equal(classifyNote('use plain ASCII letters only'), 'not plain ASCII');
assert.equal(classifyNote('beat 3: 26 words for 1 picture(s); keep it to 21 words or fewer'), 'beat too long for its picture');
assert.equal(classifyNote('remove semicolons and dashes; narration is spoken'), 'semicolons or dashes');
assert.equal(classifyNote('Unexpected end of JSON input'), 'unusable reply');
assert.deepEqual(causesOf({ message: 'x', attempts: [{ notes: ['beat 1: amount "Two" is not in its evidence || beat 2: the source does not support "y"'] }, { notes: ['use plain ASCII letters only'] }] }), ['number word not in evidence', 'sentence not supported', 'not plain ASCII']);
assert.deepEqual(causesOf({ message: 'only 3 beats have a picture that shows what its passage describes' }), ['story not eligible (pictures)']);

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yield-'));
  const file = path.join(dir, 'test.db');
  const db = new Database();
  db.dbPath = file; // never the project's own database
  await db.initialize();
  const stats = new YieldStats(db);
  await stats.llmEvent({ role: 'writer', provider: 'Groq', model: 'openai/gpt-oss-120b', outcome: 'ok' });
  await stats.llmEvent({ role: 'writer', provider: 'Groq', model: 'openai/gpt-oss-120b', outcome: 'ok' });
  await stats.llmEvent({ role: 'writer', provider: 'Groq', model: 'openai/gpt-oss-120b', outcome: 'rate_limited' });
  await stats.llmEvent({ role: 'verifier', provider: 'NVIDIA NIM', model: 'nemotron', outcome: 'empty' });
  await stats.llmEvent({ role: 'judge', provider: 'Mistral ministral-14b', model: 'vision', outcome: 'ok' });
  await stats.jobFailure({ message: 'x', attempts: [{ notes: ['beat 1: amount "Two" is not in its evidence'] }] });
  await stats.jobFailure({ message: 'Unexpected end of JSON input' });
  await db.executeQuery("INSERT INTO generation_jobs (id, topic, style, length, source, status, created_at) VALUES ('j1', NULL, 'documentary', 'short', 'manual', 'completed', datetime('now'))");
  await db.executeQuery("INSERT INTO generation_jobs (id, topic, style, length, source, status, created_at) VALUES ('j2', NULL, 'documentary', 'short', 'scheduler', 'failed', datetime('now'))");
  const report = await stats.report(2);
  const writer = report.models.find(row => row.role === 'writer');
  assert.deepEqual([writer.ok, writer.failed, writer.rate_limited], [2, 1, 1]);
  assert.equal(report.models.find(row => row.role === 'verifier').empty, 1);
  assert.equal(report.models.find(row => row.role === 'judge').ok, 1);
  assert.deepEqual(report.causes.map(row => row.cause).sort(), ['number word not in evidence', 'unusable reply']);
  assert.deepEqual(report.jobs.map(row => [row.source, row.completed, row.failed]).sort(), [['manual', 1, 0], ['scheduler', 0, 1]]);

  // the text service reports every free-chain result with its role to the sink
  const events = [];
  const service = Object.create(AITextService.prototype);
  service.logger = { info() {}, warn() {} };
  service.cooldowns = new CooldownTracker();
  service.statsSink = event => events.push(event);
  service.freeClients = { groq: { chat: { completions: { create: async request => { if (request.model === 'openai/gpt-oss-120b') throw Object.assign(new Error('Rate limit'), { status: 429 }); return { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }; } } } } };
  const candidate = model => ({ providerId: 'groq', providerName: 'Groq', model, tokenParam: 'max_completion_tokens', maxOutput: null });
  const result = await service._runFreeChain([candidate('openai/gpt-oss-120b'), candidate('openai/gpt-oss-20b')], 'p', 100, 0, [], { role: 'verifier' });
  assert.equal(result.text, 'ok');
  assert.deepEqual(events.map(event => [event.role, event.model, event.outcome]), [['verifier', 'openai/gpt-oss-120b', 'rate_limited'], ['verifier', 'openai/gpt-oss-20b', 'ok']]);
  await db.close?.();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log('yield stats: ok');
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
