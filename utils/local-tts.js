// Narration for Dark History: a local text-to-speech command (Piper) turned into an mp3. This is all that is left of the old AI video generator that Dark History used.
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { runFFmpeg } = require('./ffmpeg');

class LocalTts {
  /**
   * commandTemplate must contain {text} (input file) and {wav} (output file), e.g.
   *   python3 -m piper -m en_US-ljspeech-high --data-dir /path/to/voices --input-file {text} -f {wav}
   * The wav is converted to a mono 24 kHz mp3 at outputPath.
   */
  async generateLocalCommandTTS(text, outputPath, commandTemplate) {
    const tokens = String(commandTemplate).split(/\s+/).filter(Boolean);
    if (!tokens.length || !tokens.includes('{text}') || !tokens.includes('{wav}')) {
      throw new Error('LOCAL_TTS_COMMAND must include the {text} and {wav} placeholders');
    }
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-tts-'));
    const textPath = path.join(workDir, 'narration.txt');
    const wavPath = path.join(workDir, 'narration.wav');
    try {
      await fs.writeFile(textPath, String(text || ''), 'utf8');
      const argv = tokens.map(token => (token === '{text}' ? textPath : token === '{wav}' ? wavPath : token));
      await new Promise((resolve, reject) => {
        execFile(argv[0], argv.slice(1), {
          timeout: Math.max(10000, Number(process.env.LOCAL_TTS_TIMEOUT_MS || 180000)),
          maxBuffer: 8 * 1024 * 1024
        }, (error, _stdout, stderr) => {
          if (error) {
            error.message = `${error.message}${stderr ? `: ${String(stderr).slice(-400)}` : ''}`;
            reject(error);
          } else resolve();
        });
      });
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await runFFmpeg(['-y', '-i', wavPath, '-ac', '1', '-ar', '24000', '-codec:a', 'libmp3lame', '-q:a', '3', outputPath], { timeoutMs: 120000 });
      return outputPath;
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async isUsableAudioFile(audioPath) {
    if (typeof audioPath !== 'string' || audioPath.endsWith('.info')) return false;
    try {
      const stats = await fs.stat(audioPath);
      return stats.isFile() && stats.size > 0;
    } catch (_error) {
      return false;
    }
  }
}

module.exports = { LocalTts };
