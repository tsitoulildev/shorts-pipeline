// Offline: the visual_cadence quality check reads one pacing target, with sane bounds.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { maxBeatSeconds } = require('../utils/beat-balance');

assert.strictEqual(maxBeatSeconds({}), 12);
assert.strictEqual(maxBeatSeconds({ MAX_VISUAL_BEAT_SECONDS: '3' }), 8, 'never below 8 s');
assert.strictEqual(maxBeatSeconds({ MAX_VISUAL_BEAT_SECONDS: '60' }), 18, 'never above 18 s');
assert.strictEqual(maxBeatSeconds({ MAX_VISUAL_BEAT_SECONDS: '10' }), 10);
assert.ok(/maxBeat = maxBeatSeconds\(\)/.test(fs.readFileSync(path.join(__dirname, '..', 'utils/operator-service.js'), 'utf8')), 'the gate must use the shared pacing target');

console.log('Beat balance: PASS');
