// Narration for Dark History: a public-domain Piper voice only. The voice configured for the old path may be a
// restricted one (en_US-ryan-high is non-commercial), so the voice is taken from DARK_HISTORY_VOICE (default
// en_US-ljspeech-high) and checked against an allow-list at narration time. No fallback to a cloud TTS: no usable
// local voice means no narration and the production fails closed.
const PUBLIC_DOMAIN_VOICES = ['en_US-ljspeech-high', 'en_US-ljspeech-medium'];
// Kokoro-82M (model and voice pack: Apache-2.0, commercial use allowed; kokoro-onnx: MIT; its phonemiser espeak-ng is a GPL-3.0 library, the audio is not covered).
// Chosen by the owner after listening (2026-10-26). It is NOT the default: DARK_HISTORY_VOICE=kokoro:am_adam and DARK_HISTORY_KOKORO_COMMAND must both be set.
const KOKORO_VOICES = ['kokoro:am_adam'];
const APPROVED_VOICES = [...PUBLIC_DOMAIN_VOICES, ...KOKORO_VOICES];
const DEFAULT_VOICE = 'en_US-ljspeech-high';

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** LOCAL_TTS_COMMAND with its "-m <voice>" swapped for the Dark History voice (interpreter and --data-dir are kept). */
function narrationCommand(env = process.env) {
  const voice = String(env.DARK_HISTORY_VOICE || DEFAULT_VOICE).trim();
  if (!APPROVED_VOICES.includes(voice)) {
    throw fail('VOICE_NOT_ALLOWED', `voice "${voice.slice(0, 60)}" is not an approved free-licence voice (${APPROVED_VOICES.join(', ')})`);
  }
  if (KOKORO_VOICES.includes(voice)) {
    // `<python of the Kokoro venv> scripts/kokoro-tts.py --model-dir <dir> --voice am_adam --input-file {text} -f {wav}`: the voice name is forced to the approved one
    const kokoroTokens = String(env.DARK_HISTORY_KOKORO_COMMAND || '').trim().split(/\s+/).filter(Boolean);
    const flag = kokoroTokens.indexOf('--voice');
    if (flag < 0 || !kokoroTokens[flag + 1] || !kokoroTokens.includes('{text}') || !kokoroTokens.includes('{wav}')) {
      throw fail('VOICE_NOT_CONFIGURED', 'DARK_HISTORY_KOKORO_COMMAND must be the Kokoro command with --voice <name>, {text} and {wav}');
    }
    kokoroTokens[flag + 1] = voice.slice('kokoro:'.length);
    return kokoroTokens.join(' ');
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

/** What the production record and the gate call the voice: `piper:<voice>` or `kokoro:<voice>`. */
function narrationModel(env = process.env) {
  narrationCommand(env); // refuses a voice that is not approved or not configured
  const voice = String(env.DARK_HISTORY_VOICE || DEFAULT_VOICE).trim();
  return KOKORO_VOICES.includes(voice) ? voice : `piper:${voice}`;
}

/** narrate(text, outputPath) -> outputPath (mp3). `generator` is an AIVideoGenerator (its local-command TTS is reused). */
function makeNarrator({ generator, env = process.env }) {
  return async (text, outputPath) => generator.generateLocalCommandTTS(text, outputPath, narrationCommand(env));
}

module.exports = { narrationCommand, narrationModel, makeNarrator, PUBLIC_DOMAIN_VOICES, KOKORO_VOICES, APPROVED_VOICES, DEFAULT_VOICE };
