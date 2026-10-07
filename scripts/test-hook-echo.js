// Offline: the hook is spoken once; an echo of it at the start of beat 1 is removed, nothing else is touched.
const assert = require('assert');
const { ScriptWriterAgent } = require('../agents/script-writer-agent');

const agent = Object.create(ScriptWriterAgent.prototype);
const beat = (content, duration = 6) => ({ type: 'horror_beat', title: 't', content, duration });
const hook = 'My smart-home app says every light is off.';

// Exact echo (punctuation and case differ): removed, the rest of the line stays.
let out = agent.stripHookEcho(hook, [beat(['my smart home app says every light is off. One bulb stayed lit above my feet.']), beat(['Two.'])]);
assert.deepStrictEqual(out[0].content, ['One bulb stayed lit above my feet.']);
assert.strictEqual(out[1].content[0], 'Two.');

// The echo is its own line: that line is dropped.
out = agent.stripHookEcho(hook, [beat([hook, 'The bulb followed me.']), beat(['Two.'])]);
assert.deepStrictEqual(out[0].content, ['The bulb followed me.']);

// No echo: unchanged (same objects).
const clean = [beat(['The bulb followed me down the hall.']), beat(['Two.'])];
assert.strictEqual(agent.stripHookEcho(hook, clean), clean);

// A beat that would become empty is kept as it was.
const only = [beat([hook]), beat(['Two.'])];
assert.strictEqual(agent.stripHookEcho(hook, only), only);

// Very short hooks are never matched.
const shortHook = [beat(['Run now. Run.'])];
assert.strictEqual(agent.stripHookEcho('Run now', shortHook), shortHook);
console.log('Hook echo: PASS');
