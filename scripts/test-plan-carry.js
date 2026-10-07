// Offline: the planner's vetted idea travels into the job and is used as the strategy (not regenerated).
const assert = require('assert');
const { ContentStrategyAgent } = require('../agents/content-strategy-agent');
const { pickPlanForJob } = require('../utils/autonomous-channel-operator');

(async () => {
  const item = {
    topic: 'The Elevator Display Counted Down to a Floor Below the Basement',
    idea: 'basement countdown', storyFamily: 'liminal-space',
    everydayAnchor: 'night shift elevator', fearMechanism: 'impossible numbering',
    angle: 'each floor number lower than the last while the doors never open',
    hook: 'The elevator display said floor minus four.',
    scrollStopMoment: 'stickman staring at a display reading -4',
    visualWhy: 'a negative floor number is instantly wrong',
    visualVariety: ['display -1', 'display -2', 'doors shake', 'display -4'],
    curiosityAngle: 'what is on -4', escalationLadder: ['display -2', 'knocking from below'],
    payoff: 'The doors open onto his own apartment, lights on, someone sitting inside.',
    storyEngine: 'ordinary-to-impossible', autonomyRisk: 'low',
    nicheFit: 9, visualStrength: 9, curiosityGap: 9, visualVarietyScore: 8, retentionPotential: 9,
    originalityScore: 9, brandFit: 9, twistScore: 8, premiseLegibility: 9, payoffStrength: 8,
    keywords: ['horror'], fictional: true, extraNoise: 'dropped', rationale: 'x'
  };
  const carried = pickPlanForJob(item);
  assert.strictEqual(carried.hook, item.hook, 'hook travels with the job');
  assert.strictEqual(carried.payoff, item.payoff, 'payoff travels with the job');
  assert.ok(!('extraNoise' in carried), 'unknown fields are not carried');
  assert.strictEqual(pickPlanForJob(null), null);

  const agent = Object.create(ContentStrategyAgent.prototype);
  agent.logger = { info() {}, warn() {}, error() {} };
  agent.identity = require('../config/channel-identity.json');
  agent.historicalPerformance = [];
  agent.recentPremises = [item.topic]; // the run's own plan is stored as a recent premise
  agent.competitorData = [];
  agent.getCompetitorInsights = () => [];
  agent.loadRecentPremises = async () => [];
  let saved = null;
  agent.db = { saveContentStrategy: async s => { saved = s; } };
  agent.aiTextService = { isAvailable: () => { throw new Error('the AI must not be called'); } };

  const strategy = await agent.buildStrategyFromPlanItem(carried);
  assert.ok(strategy, 'vetted idea becomes the strategy');
  assert.strictEqual(strategy.hook, item.hook);
  assert.strictEqual(strategy.payoff, item.payoff);
  assert.strictEqual(saved.topic, item.topic);

  // An idea that no longer passes the gates returns null so the caller regenerates.
  assert.strictEqual(await agent.buildStrategyFromPlanItem({ ...carried, fictional: true, topic: '' }), null);
  assert.strictEqual(await agent.buildStrategyFromPlanItem(null), null);
  console.log('Plan carry: PASS');
})().catch(e => { console.error(e); process.exit(1); });
