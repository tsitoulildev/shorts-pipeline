// Offline: a premise the operator planned must not be rejected as a duplicate of itself at job time.
const assert = require('assert');
process.env.AUTONOMOUS_MODE = 'true';
const { ContentStrategyAgent } = require('../agents/content-strategy-agent');

const topic = 'The Elevator Display Counted Down to a Floor Below the Basement';
const candidate = {
  topic, idea: 'basement countdown', storyFamily: 'liminal-space', everydayAnchor: 'night shift elevator',
  fearMechanism: 'impossible numbering', angle: 'each floor lower than the last while the doors stay shut',
  hook: 'The elevator display said floor minus four.', scrollStopMoment: 'stickman staring at a display reading -4',
  visualWhy: 'a negative floor number is instantly wrong', visualVariety: ['display -1', 'display -2', 'doors shake', 'display -4'],
  curiosityAngle: 'what is on -4', escalationLadder: ['display -2', 'knocking from below'],
  payoff: 'The doors open onto his own apartment, lights on, someone sitting inside.',
  storyEngine: 'ordinary-to-impossible', autonomyRisk: 'low', nicheFit: 9, visualStrength: 9, curiosityGap: 9,
  visualVarietyScore: 8, retentionPotential: 9, originalityScore: 9, brandFit: 9, twistScore: 9,
  premiseLegibility: 9, payoffStrength: 9, keywords: ['horror'], fictional: true
};

function makeAgent(aiAvailable) {
  const agent = Object.create(ContentStrategyAgent.prototype);
  agent.logger = { info() {}, warn() {}, error() {} };
  agent.identity = require('../config/channel-identity.json');
  agent.historicalPerformance = [];
  agent.trendingTopics = [];
  // The run that planned this premise is stored as a recent premise (loadRecentPremises reads operator_runs.plan).
  agent.recentPremises = [topic];
  agent.loadRecentPremises = async () => [];
  agent.getCompetitorInsights = () => [];
  agent.db = { saveContentStrategy: async () => {} };
  agent.aiTextService = {
    providerName: 'stub',
    isAvailable: () => aiAvailable,
    generateText: async () => JSON.stringify({ candidates: [{ ...candidate, topic: `${topic} Tonight` }] })
  };
  return agent;
}

(async () => {
  // AI path: the rewrite of the requested premise is near-identical to the stored plan and must still pass.
  const viaAI = await makeAgent(true).generateContentStrategy(topic);
  assert.ok(viaAI && viaAI.topic.includes('Elevator Display'), 'AI strategy accepted for the planned premise');

  // Deterministic gated fallback for the same premise must not reject it as its own duplicate either.
  const viaFallback = await makeAgent(false).generateContentStrategy(topic);
  assert.ok(viaFallback && viaFallback.topic === topic, 'deterministic fallback accepted for the planned premise');

  // Real duplicates are still rejected when no premise is requested.
  const agent = makeAgent(true);
  assert.ok(agent.isNearDuplicateOfRecent(topic, agent.getRecentTopics()), 'plain duplicate check still works');
  assert.ok(!agent.recentTopicsExcludingPremise(topic).includes(topic));
  console.log('Self duplicate: PASS');
})().catch(e => { console.error(e); process.exit(1); });
