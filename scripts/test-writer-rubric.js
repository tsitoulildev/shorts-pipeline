// Offline: the writer and the planner see the editor's rubric (same numbers as the real gate) before they write.
const assert = require('assert');
const review = require('../utils/creative-review');
const { ScriptWriterAgent } = require('../agents/script-writer-agent');
const { ContentStrategyAgent } = require('../agents/content-strategy-agent');

(async () => {
  const rubric = review.editorRubricForWriter();
  assert.ok(rubric.includes(`below ${review.MIN_OVERALL}/10`));
  for (const [key, floor] of Object.entries(review.FLOORS)) assert.ok(rubric.includes(`${key} below ${floor}`) || rubric.includes(`${floor}`), `${key} floor ${floor} is in the rubric`);
  for (const trope of review.OVERUSED_TROPES) assert.ok(rubric.includes(trope));

  assert.ok(rubric.includes('catalogue') && rubric.includes('makes ONE choice'), 'rubric demands a story, not a catalogue');
  assert.ok(rubric.includes('reuse an object'), 'the ending must reframe the opening');
  const criticPrompt = review.buildReviewPrompt({ hook: { text: 'A hook line goes here now' }, mainContent: { sections: [{ content: ['One beat.'] }] } }, { topic: 't', payoff: 'p' });
  assert.ok(criticPrompt.includes('catalogue, not a story'), 'the critic scores catalogues low');

  // The real writer prompt contains the rubric.
  let writerPrompt = '';
  const writer = Object.create(ScriptWriterAgent.prototype);
  writer.logger = { info() {}, warn() {}, error() {} };
  writer.identity = require('../config/channel-identity.json');
  writer.aiTextService = { isAvailable: () => true, providerName: 'stub', generateText: async prompt => { writerPrompt = writerPrompt || prompt; throw new Error('stop'); } };
  try { await writer.generateScriptWithAI({ topic: 'A test premise', hook: 'A test hook line here now' }, null, {}); } catch (_error) { /* the fallback may throw; only the prompt matters */ }
  assert.ok(writerPrompt.includes('EDITOR RUBRIC'), 'writer prompt carries the editor rubric');
  assert.ok(writerPrompt.includes(review.OVERUSED_TROPES[0]));
  assert.ok(writerPrompt.includes('QUALITY EXAMPLES'), 'writer prompt carries the quality examples');

  // The examples must themselves pass the editor's own heuristics (voice, hook, ending, length).
  const text = writerPrompt.split('QUALITY EXAMPLES')[1].split('Before returning')[0];
  for (const label of ['Example A', 'Example B']) {
    const body = text.split(label)[1].split(/Example [AB]/)[0];
    const hook = body.match(/Hook: (.*?) Beats:/)[1];
    const beats = body.split('Beats:')[1].split(/\s\d\.\s/).map(item => item.replace(/^\s*\d\.\s*/, '').trim()).filter(Boolean);
    const spoken = [hook, ...beats].join(' ').split(/\s+/).length;
    assert.ok(spoken >= 95 && spoken <= 125, `${label} has ${spoken} spoken words`);
    const result = review.heuristicReview({ hook: { text: hook }, mainContent: { sections: beats.map(content => ({ content: [content] })) } });
    assert.ok(result.scores.voice >= 9, `${label} voice ${result.scores.voice}: ${result.notes.join(' | ')}`);
    assert.ok(result.overall >= 8.5, `${label} overall ${result.overall}: ${result.notes.join(' | ')}`);
  }

  // The planner prompt names the overused ideas.
  let plannerPrompt = '';
  const planner = Object.create(ContentStrategyAgent.prototype);
  planner.logger = { info() {}, warn() {}, error() {} };
  planner.identity = require('../config/channel-identity.json');
  planner.aiTextService = { isAvailable: () => true, generateText: async prompt => { plannerPrompt = prompt; throw new Error('stop'); } };
  try { await planner.generateAutonomousPlanWithAI({}, { recentTopics: [], signals: [], approvedLearnings: [] }, 1); } catch (_error) { /* only the prompt matters */ }
  assert.ok(plannerPrompt.includes('STORY STRUCTURES'), 'planner prompt carries the story-structure library');
  for (const structure of require('../config/story-structures.json').structures) assert.ok(plannerPrompt.includes(structure.id), `planner prompt lists ${structure.id}`);
  assert.ok(plannerPrompt.includes(review.OVERUSED_TROPES[1]), 'only the worn-out endings are banned');
  assert.ok(!plannerPrompt.includes('impossible detail about an ordinary object'), 'the planner is no longer asked for odd physics');
  assert.ok(plannerPrompt.includes('"storyStructure"'), 'the planner returns the chosen structure');
  console.log('Writer and planner rubric: PASS');
})().catch(error => { console.error(error); process.exit(1); });
