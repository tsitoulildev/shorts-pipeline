// Narration for Dark History: a public-domain Piper voice only. The voice configured for the old path may be a
// restricted one (en_US-ryan-high is non-commercial), so the voice is taken from DARK_HISTORY_VOICE (default
// en_US-ljspeech-high) and checked against an allow-list at narration time. No fallback to a cloud TTS: no usable
// local voice means no narration and the production fails closed.
const PUBLIC_DOMAIN_VOICES = ['en_US-ljspeech-high', 'en_US-ljspeech-medium'];
const DEFAULT_VOICE = 'en_US-ljspeech-high';

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** LOCAL_TTS_COMMAND with its "-m <voice>" swapped for the Dark History voice (interpreter and --data-dir are kept). */
function narrationCommand(env = process.env) {
  const voice = String(env.DARK_HISTORY_VOICE || DEFAULT_VOICE).trim();
  if (!PUBLIC_DOMAIN_VOICES.includes(voice)) {
    throw fail('VOICE_NOT_ALLOWED', `voice "${voice.slice(0, 60)}" is not an approved public-domain voice (${PUBLIC_DOMAIN_VOICES.join(', ')})`);
  }
  const command = String(env.LOCAL_TTS_COMMAND || '').trim();
  const tokens = command.split(/\s+/).filter(Boolean);
  const at = tokens.lastIndexOf('-m'); // `python3 -m piper -m <voice>`: the voice follows the last -m
  if (!command || at < 0 || !tokens[at + 1] || !tokens.includes('{text}') || !tokens.includes('{wav}')) {
    throw fail('VOICE_NOT_CONFIGURED', 'LOCAL_TTS_COMMAND must be a Piper command with -m <voice>, {text} and {wav}; Dark History narrates with the local public-domain voice only');
  }
  tokens[at + 1] = voice;
  return tokens.join(' ');
}

/** narrate(text, outputPath) -> outputPath (mp3). `generator` is an AIVideoGenerator (its local-command TTS is reused). */
function makeNarrator({ generator, env = process.env }) {
  return async (text, outputPath) => generator.generateLocalCommandTTS(text, outputPath, narrationCommand(env));
}

module.exports = { narrationCommand, makeNarrator, PUBLIC_DOMAIN_VOICES, DEFAULT_VOICE };
