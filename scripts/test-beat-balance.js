// Offline: the writer's beat-size rule and the visual_cadence gate share one definition,
// so a script that passes the contract cannot be rejected for a long beat.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { MAX_NARRATION_SECONDS, maxBeatSeconds, maxBeatWordShare, beatWordCounts, beatBalanceIssues } = require('../utils/beat-balance');

const repeat = (word, count) => Array(count).fill(word).join(' ');
const script = (hookWords, beatWords) => ({
  hook: repeat('h', hookWords),
  mainContent: { sections: beatWords.map(count => ({ content: [repeat('w', count)] })) }
});

// The limit keeps a worst-case beat inside the gate (target + 1 s tolerance).
const limit = maxBeatWordShare({});
assert.strictEqual(maxBeatSeconds({}), 12);
assert.ok(limit * MAX_NARRATION_SECONDS < maxBeatSeconds({}) + 1, 'limit must stay inside the gate tolerance');
assert.ok(limit > 0.25, 'limit must still allow a 4-beat script with equal beats');

// Hook words count toward beat 1, exactly like the scene planner.
assert.deepStrictEqual(beatWordCounts(script(8, [22, 25, 25, 28])), [30, 25, 25, 28]);

// Real data: beat 1 had 30.6% of the narration (13.3 s) and was rejected.
const rejected = beatBalanceIssues(script(8, [25, 21, 18, 16, 20]), {});
assert.strictEqual(rejected.length, 1, 'the 30.6% first beat of the rejected production must be flagged');
const heavy = beatBalanceIssues(script(10, [38, 20, 20, 20]), {});
assert.strictEqual(heavy.length, 1);
assert.match(heavy[0], /beat 1 carries 48 of 108/);
assert.match(heavy[0], /hook included/);

// Balanced scripts pass, including the 4-beat minimum and the 7-beat maximum.
assert.deepStrictEqual(beatBalanceIssues(script(8, [22, 25, 25, 28]), {}), []);
assert.deepStrictEqual(beatBalanceIssues(script(8, [10, 12, 12, 12, 12, 12, 12]), {}), []);

// Every beat is checked, not only the first.
const lateHeavy = beatBalanceIssues(script(8, [20, 20, 20, 50]), {});
assert.strictEqual(lateHeavy.length, 1);
assert.match(lateHeavy[0], /beat 4 carries 50/);

// Single beat or empty script never throws.
assert.deepStrictEqual(beatBalanceIssues({}, {}), []);
assert.deepStrictEqual(beatBalanceIssues(script(8, [60]), {}), []);

// The writer enforces the rule and the gate reads the same pacing target.
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
assert.ok(/beatBalanceIssues\(script\)/.test(read('agents/script-writer-agent.js')), 'writer contract must use the beat-balance rule');
assert.ok(/maxBeatWordShare\(\)/.test(read('agents/script-writer-agent.js')), 'writer prompt must state the beat limit');
assert.ok(/Specific problems to fix/.test(read('agents/script-writer-agent.js')), 'repair passes must receive the previous problems');
assert.ok(/maxBeat = maxBeatSeconds\(\)/.test(read('utils/operator-service.js')), 'gate must use the shared pacing target');

// The deterministic fallback (last resort) must satisfy the same rule for every evergreen topic.
const { ScriptWriterAgent } = require('../agents/script-writer-agent');
const identity = require('../config/channel-identity.json');
const writer = new ScriptWriterAgent({});
for (const topic of identity.fallbackTopics) {
  const strategy = {
    topic, idea: topic, hook: topic, everydayAnchor: 'a quiet kitchen at night',
    fearMechanism: 'one impossible detail reacted to them', curiosityAngle: 'the detail moved when unseen',
    payoff: 'the threat had been inside the safe space all along', storyEngine: 'ordinary-to-impossible',
    nicheFit: 10, visualStrength: 10, curiosityGap: 10, visualVarietyScore: 10,
    retentionPotential: 10, originalityScore: 10, brandFit: 10,
    visualVariety: ['an empty hallway', 'a door left ajar', 'a shadow on the wall', 'a phone glowing alone', 'a figure at the window'],
    escalationLadder: ['it answered again', 'it moved closer']
  };
  const fallback = writer.buildDeterministicHorrorFallback(strategy, 'test');
  assert.deepStrictEqual(beatBalanceIssues(fallback, {}), [], `fallback unbalanced for: ${topic}`);
}

console.log('Beat balance: PASS');
