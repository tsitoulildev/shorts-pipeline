// Offline: the job path plan item -> strategy -> script, with the run's own plan sitting in the planner's memory
// (exactly the production state that broke runs 06/08/10 UTC on 2026-10-05).
const assert = require('assert');
process.env.AUTONOMOUS_MODE = 'true';
const { ContentStrategyAgent } = require('../agents/content-strategy-agent');
const { ScriptWriterAgent } = require('../agents/script-writer-agent');
const { pickPlanForJob } = require('../utils/autonomous-channel-operator');

const item = {
  topic: 'The Parking Garage Exit Sign Pointed Down Instead of Out',
  idea: 'exit sign', storyFamily: 'liminal-space', everydayAnchor: 'late parking garage',
  fearMechanism: 'space does not behave', angle: 'each ramp leads one level deeper',
  hook: 'The exit sign pointed straight down.', scrollStopMoment: 'stickman beneath a glowing exit sign pointing at the floor',
  visualWhy: 'a sign that points the wrong way is instantly wrong', visualVariety: ['sign points down', 'ramp loops', 'car alarm silent', 'sign blinks'],
  curiosityAngle: 'where does down lead', escalationLadder: ['second sign points down', 'floor hums'],
  payoff: 'The ground floor button reads B9 and the doors open on the same garage, empty, his car already waiting.',
  storyEngine: 'space-does-not-behave', autonomyRisk: 'low', nicheFit: 9, visualStrength: 9, curiosityGap: 9,
  visualVarietyScore: 8, retentionPotential: 9, originalityScore: 9, brandFit: 9, twistScore: 9,
  premiseLegibility: 9, payoffStrength: 9, keywords: ['horror'], fictional: true
};

(async () => {
  const identity = require('../config/channel-identity.json');
  const planner = Object.create(ContentStrategyAgent.prototype);
  planner.logger = { info() {}, warn() {}, error() {} };
  planner.identity = identity;
  planner.historicalPerformance = [];
  planner.trendingTopics = [];
  planner.recentPremises = [item.topic, 'Another recent premise about a hallway light'];
  planner.loadRecentPremises = async () => [];
  planner.getCompetitorInsights = () => [];
  planner.db = { saveContentStrategy: async () => {} };
  planner.aiTextService = { providerName: 'stub', isAvailable: () => false };

  const context = { plan: pickPlanForJob(item) };
  const strategy = await planner.buildStrategyFromPlanItem(context.plan);
  assert.ok(strategy, 'job strategy built from the planned item');
  assert.strictEqual(strategy.hook, item.hook, 'the planned hook is the one the writer receives');

  const writer = Object.create(ScriptWriterAgent.prototype);
  writer.logger = { info() {}, warn() {}, error() {} };
  writer.identity = identity;
  writer.templates = {};
  writer.aiTextService = { providerName: 'stub', isAvailable: () => false };
  let stored = null;
  writer.db = { saveScript: async s => { stored = s; } };
  const script = await writer.generateScript(strategy);
  assert.ok(script && script.fullScript, 'a script comes out of the strategy');
  assert.ok(stored, 'script was stored');
  console.log('Job path: PASS');
})().catch(e => { console.error(e); process.exit(1); });
