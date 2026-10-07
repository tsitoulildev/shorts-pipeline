// The Dark History narrator speaks with a public-domain Piper voice only (decision: no paid or restricted voice).
// It reuses the interpreter and --data-dir of LOCAL_TTS_COMMAND but swaps the voice, and refuses any other voice.
const assert = require('assert');
const { narrationCommand, makeNarrator, PUBLIC_DOMAIN_VOICES } = require('../utils/dark-history/narration');

const base = '/opt/piper/bin/python3 -m piper -m en_US-ryan-high --data-dir /opt/voices --input-file {text} -f {wav}';
const env = overrides => ({ LOCAL_TTS_COMMAND: base, ...overrides });

// default voice is the public-domain one, taken over the voice configured for the old path (ryan is NOT public domain)
assert.ok(PUBLIC_DOMAIN_VOICES.includes('en_US-ljspeech-high'));
assert.strictEqual(narrationCommand(env({})), '/opt/piper/bin/python3 -m piper -m en_US-ljspeech-high --data-dir /opt/voices --input-file {text} -f {wav}');
assert.ok(!/ryan/.test(narrationCommand(env({}))));

// an explicit allowed voice is used; any other voice (including the restricted ryan voice) is refused, never "tried"
assert.match(narrationCommand(env({ DARK_HISTORY_VOICE: 'en_US-ljspeech-medium' })), /-m en_US-ljspeech-medium /);
assert.throws(() => narrationCommand(env({ DARK_HISTORY_VOICE: 'en_US-ryan-high' })), error => error.code === 'VOICE_NOT_ALLOWED');
assert.throws(() => narrationCommand(env({ DARK_HISTORY_VOICE: 'en_US-ljspeech-high --evil' })), error => error.code === 'VOICE_NOT_ALLOWED');

// no local voice configured, or a command that does not name a voice: fail closed (no silent fallback to Gemini/OpenAI TTS)
assert.throws(() => narrationCommand({}), error => error.code === 'VOICE_NOT_CONFIGURED');
assert.throws(() => narrationCommand({ LOCAL_TTS_COMMAND: 'say {text} {wav}' }), error => error.code === 'VOICE_NOT_CONFIGURED');

(async () => {
  const calls = [];
  const generator = { async generateLocalCommandTTS(text, out, command) { calls.push({ text, out, command }); return out; } };
  const narrate = makeNarrator({ generator, env: env({}) });
  assert.strictEqual(await narrate('Hello there.', '/tmp/x.mp3'), '/tmp/x.mp3');
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0].command, /-m en_US-ljspeech-high /);
  // the check runs at narration time, so a bad voice never produces audio
  await assert.rejects(() => makeNarrator({ generator, env: env({ DARK_HISTORY_VOICE: 'en_US-ryan-high' }) })('x', '/tmp/y.mp3'), error => error.code === 'VOICE_NOT_ALLOWED');
  assert.strictEqual(calls.length, 1);
  console.log('dark-history narration tests passed');
})().catch(error => { console.error(error); process.exit(1); });
