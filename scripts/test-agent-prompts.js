/**
 * Guards the prompts of the agents that call an LLM (strategy, script writer, packaging, editor).
 * It captures the real prompt each agent sends and checks the rules the channel depends on:
 * a role and one objective, one narrator that reads cleanly aloud, one clear action per beat,
 * no depicted harm. It never calls a model.
 */
const { ContentStrategyAgent } = require('../agents/content-strategy-agent');
const { ScriptWriterAgent } = require('../agents/script-writer-agent');
const { SEOOptimizerAgent } = require('../agents/seo-optimizer-agent');
const { buildReviewPrompt } = require('../utils/creative-review');

function capturing(prompts) {
  return {
    isAvailable: () => true,
    providerName: 'prompt-capture',
    generateText: async prompt => { prompts.push(String(prompt)); return 'not json'; }
  };
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function requireAll(name, prompt, phrases) {
  check(/^You are /.test(prompt.trim()), `${name}: prompt must start with a role ("You are ...")`);
  check(/Your only objective/.test(prompt), `${name}: prompt must state one objective`);
  for (const phrase of phrases) check(prompt.includes(phrase), `${name}: prompt lost the rule "${phrase}"`);
}

async function main() {
  const strategy = {
    topic: 'A phone in an empty apartment keeps ringing from inside the wall',
    hook: 'The ringing came from inside the wall.',
    everydayAnchor: 'a quiet apartment at night',
    fearMechanism: 'an ordinary sound that cannot be real',
    escalationLadder: ['it rings again', 'it answers'],
    payoff: 'the voice on the line is the narrator',
    visualVariety: ['phone on a table', 'ear to the wall', 'hand on the door', 'empty chair'],
    storyEngine: 'impossible-sound',
    contentType: 'Story',
    keywords: ['horror']
  };

  const writerPrompts = [];
  const writer = new ScriptWriterAgent({}, {});
  writer.aiTextService = capturing(writerPrompts);
  try { await writer.generateScriptWithAI(strategy, {}, {}); } catch (_error) { /* fallback path is not under test */ }
  check(writerPrompts.length > 0, 'script writer did not send a prompt');
  requireAll('script writer', writerPrompts[0], [
    'NARRATOR AND VOICE', 'One narrator, always the same', 'no quoted dialogue',
    'The hook is spoken exactly once', 'must NOT repeat or paraphrase it',
    'VISUAL BEATS', 'ONE clear action', 'Never depict injury, blood, or a person being harmed',
    'diegetic only', 'Return ONLY valid JSON'
  ]);

  const strategyPrompts = [];
  const strategist = new ContentStrategyAgent({}, {});
  strategist.aiTextService = capturing(strategyPrompts);
  await strategist.generateAutonomousPlanWithAI({}, { recentTopics: [], signals: [], approvedLearnings: [] }, 1);
  check(strategyPrompts.length > 0, 'content strategy did not send a prompt');
  requireAll('content strategy', strategyPrompts[0], [
    'never depicted injury, blood, or a person being harmed', 'one clear stickman action in one place',
    'no real names, brands, logos', 'Return ONLY valid JSON'
  ]);

  const packagingPrompts = [];
  const packaging = new SEOOptimizerAgent({}, {});
  packaging.aiTextService = capturing(packagingPrompts);
  await packaging.generatePackagingWithAI({ title: 'Working title', hook: strategy.hook }, strategy, null);
  check(packagingPrompts.length > 0, 'packaging did not send a prompt');
  requireAll('packaging', packagingPrompts[0], [
    'Do not put scores or reasoning in the JSON', 'Twist boundary (DO NOT SPOIL)', 'Return ONLY valid JSON'
  ]);

  const review = buildReviewPrompt({ hook: 'The ringing came from inside the wall.', mainContent: { sections: [{ content: ['It rang again.'] }] } }, strategy);
  requireAll('editor', review, ['Never praise', 'never rewrite the script yourself', 'spoken only once', 'Return ONLY valid JSON']);

  console.log('Agent prompt contract test completed successfully');
}

main().catch(error => { console.error(error); process.exit(1); });
