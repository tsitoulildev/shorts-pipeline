const OpenAI = require('openai');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const { Logger } = require('./logger');
const { runFFmpeg, getMediaDuration, checkFFmpeg, ffmpegInstallHint } = require('./ffmpeg');
const { MediaGenerationService } = require('./media-generation-service');
const { buildStickmanScene } = require('./stickman-scene');
const { isAnimationEnabled, renderBeatClip } = require('./stickman-animation');

class AIVideoGenerator {
  constructor(credentials, options = {}) {
    this.logger = new Logger('AIVideoGenerator');
    const resolvedCredentials = credentials?.credentials || credentials || {};
    this.db = options.db || null;
    this.lastVideoResult = null;
    this.lastNarrationResult = null;
    this.lastImageResult = null;
    
    // FREE_MEDIA_ONLY (default true) means paid media providers are never even
    // constructed, so a paid key present for other purposes (e.g. text) can never
    // silently become the narration, image or video provider.
    this.freeMediaOnly = !/^(0|false|no)$/i.test(String(process.env.FREE_MEDIA_ONLY || 'true'));
    const allowPaid = !this.freeMediaOnly;

    // Initialize AI services with graceful fallback
    const openaiKey = allowPaid ? (resolvedCredentials.openai?.apiKey || process.env.OPENAI_API_KEY) : null;
    if (!allowPaid) {
      const blocked = [
        (resolvedCredentials.openai?.apiKey || process.env.OPENAI_API_KEY) && 'OpenAI',
        (resolvedCredentials.replicate?.apiKey || process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY) && 'Replicate',
        (resolvedCredentials.elevenLabs?.apiKey || process.env.ELEVENLABS_API_KEY) && 'ElevenLabs'
      ].filter(Boolean);
      if (blocked.length) this.logger.info(`FREE_MEDIA_ONLY: paid media providers not used (${blocked.join(', ')})`);
    }
    
    if (openaiKey) {
      this.openai = new OpenAI({ apiKey: openaiKey });
      this.logger.info('OpenAI service initialized');
    } else {
      this.logger.info('OpenAI media provider not configured');
    }
    
    // Gemini media generation (images + native TTS) — free-tier alternative to OpenAI
    const geminiKey = resolvedCredentials.gemini?.apiKey || process.env.GEMINI_API_KEY;
    if (geminiKey) {
      try {
        const { GoogleGenAI } = require('@google/genai');
        this.gemini = new GoogleGenAI({ apiKey: geminiKey });
        this.logger.info('Gemini media service initialized (images + TTS)');
      } catch (error) {
        this.logger.warn('Failed to initialize Gemini media service:', error.message);
      }
    }
    
    // ElevenLabs configuration
    this.elevenLabsApiKey = allowPaid ? (resolvedCredentials.elevenLabs?.apiKey || process.env.ELEVENLABS_API_KEY) : null;
    this.elevenLabsVoiceId = allowPaid ? (resolvedCredentials.elevenLabs?.voiceId || process.env.ELEVENLABS_VOICE_ID) : null;
    this.elevenLabsModel = process.env.ELEVENLABS_TTS_MODEL || 'eleven_v3';
    
    // Kept under FREE_MEDIA_ONLY for its free utilities (e.g. uploaded-video
    // validation in scene repair); its provider generation is skipped below.
    this.mediaGeneration = options.mediaGeneration || (this.db
      ? new MediaGenerationService(this.db, resolvedCredentials, { logger: this.logger })
      : null);
  }

  async generateTTSAudio(text, outputPath) {
    this.logger.info('Generating TTS audio...');
    this.lastNarrationResult = null;

    // Ordered provider chain. Paid providers only exist when FREE_MEDIA_ONLY is
    // off. A configured local voice (LOCAL_TTS_COMMAND, e.g. Piper) is the free
    // last resort when the Gemini free tier is exhausted or unavailable.
    const attempts = [];
    if (this.elevenLabsApiKey && this.elevenLabsVoiceId) {
      attempts.push({ provider: 'elevenlabs', model: this.elevenLabsModel, run: () => this.generateElevenLabsTTS(text, outputPath) });
    } else if (this.openai) {
      attempts.push({ provider: 'openai', model: 'gpt-4o-mini-tts', run: () => this.generateOpenAITTS(text, outputPath) });
    } else if (this.gemini) {
      attempts.push({
        provider: 'gemini',
        model: process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-tts',
        run: () => this.generateGeminiTTS(text, outputPath)
      });
    }
    const localCommand = String(process.env.LOCAL_TTS_COMMAND || '').trim();
    if (localCommand) {
      attempts.push({
        provider: 'local-tts',
        model: process.env.LOCAL_TTS_LABEL || 'local-command',
        run: () => this.generateLocalCommandTTS(text, outputPath, localCommand)
      });
    }

    // One narrator for the whole channel: a fallback engine speaks with a different voice, so by
    // default only the first (primary) voice may narrate. If it fails, the job fails closed and is
    // retried on a later run instead of publishing a Short with another narrator.
    // NARRATOR_LOCK=false re-enables the fallback chain (owner decision only).
    if (attempts.length > 1 && String(process.env.NARRATOR_LOCK ?? 'true').trim().toLowerCase() !== 'false') {
      this.logger.info(`Narrator lock on: using only ${attempts[0].provider}; fallback voices skipped (${attempts.slice(1).map(item => item.provider).join(', ')})`);
      attempts.length = 1;
    }

    const record = (status, attempt, generatedPath, extra = {}) => {
      this.lastNarrationResult = {
        status,
        path: generatedPath || null,
        provider: attempt.provider,
        model: attempt.model,
        externalTaskId: null,
        generatedAt: new Date().toISOString(),
        simulated: status !== 'ready' && status !== 'failed',
        cost: {
          provider: attempt.provider,
          amount: attempt.provider === 'local-tts' ? 0 : null,
          currency: null,
          invoiceRequired: !['simulation', 'local-tts'].includes(attempt.provider)
        },
        ...extra
      };
    };

    if (!attempts.length) {
      const generatedPath = await this.simulateTTSGeneration(text, outputPath);
      const usable = await this.isUsableAudioFile(generatedPath);
      record(usable ? 'ready' : 'unavailable', { provider: 'simulation', model: null }, generatedPath);
      return generatedPath;
    }

    for (let index = 0; index < attempts.length; index++) {
      const attempt = attempts[index];
      const hasFallback = index < attempts.length - 1;
      try {
        const generatedPath = await attempt.run();
        const usable = await this.isUsableAudioFile(generatedPath);
        if (usable || !hasFallback) {
          record(usable ? 'ready' : 'unavailable', attempt, generatedPath,
            index > 0 ? { fallbackFrom: attempts.slice(0, index).map(item => item.provider) } : {});
          if (usable && index > 0) this.logger.warn(`Narration produced by fallback voice ${attempt.provider} (${attempt.model})`);
          return generatedPath;
        }
        this.logger.warn(`${attempt.provider} returned unusable narration audio; trying the next free voice`);
      } catch (error) {
        if (!hasFallback) {
          record('failed', attempt, null, { error: error.message });
          this.logger.error('TTS generation failed:', error);
          throw error;
        }
        this.logger.warn(`${attempt.provider} narration failed (${error.message}); trying the next free voice`);
      }
    }
    return null;
  }

  /**
   * Run a locally installed TTS engine. LOCAL_TTS_COMMAND is split on whitespace
   * (no shell is involved) and must contain {text} (path to a UTF-8 text file)
   * and {wav} (output path), e.g.
   *   python3 -m piper -m en_US-ljspeech-high --data-dir /home/ubuntu/piper-voices --input-file {text} -f {wav}
   */
  async generateLocalCommandTTS(text, outputPath, commandTemplate) {
    const tokens = String(commandTemplate).split(/\s+/).filter(Boolean);
    if (!tokens.length || !tokens.includes('{text}') || !tokens.includes('{wav}')) {
      throw new Error('LOCAL_TTS_COMMAND must include the {text} and {wav} placeholders');
    }
    const os = require('os');
    const { execFile } = require('child_process');
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-tts-'));
    const textPath = path.join(workDir, 'narration.txt');
    const wavPath = path.join(workDir, 'narration.wav');
    try {
      await fs.writeFile(textPath, String(text || ''), 'utf8');
      const argv = tokens.map(token => token === '{text}' ? textPath : token === '{wav}' ? wavPath : token);
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

  async generateElevenLabsTTS(text, outputPath) {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${this.elevenLabsVoiceId}`;
    
    const data = {
      text: text,
      model_id: this.elevenLabsModel,
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.8,
        style: 0.0,
        use_speaker_boost: true
      }
    };

    const response = await axios({
      method: 'POST',
      url: url,
      data: data,
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': this.elevenLabsApiKey
      },
      responseType: 'stream'
    });

    const writer = require('fs').createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        this.logger.info('ElevenLabs TTS generation complete');
        resolve(outputPath);
      });
      writer.on('error', reject);
    });
  }

  async generateOpenAITTS(text, outputPath) {
    const response = await this.openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "coral",
      input: text,
      speed: 1.0
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(outputPath, buffer);

    this.logger.info('OpenAI TTS generation complete');
    return outputPath;
  }

  async generateGeminiTTS(text, outputPath) {
    const model = process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-tts';
    const voiceName = process.env.GEMINI_TTS_VOICE || 'Kore';

    const response = await this.gemini.models.generateContent({
      model,
      contents: [{ parts: [{ text }] }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName }
          }
        }
      }
    });

    const audioData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!audioData) {
      throw new Error('Gemini TTS returned no audio data');
    }

    // Gemini returns raw PCM (24kHz, mono, 16-bit); encode to the requested container via FFmpeg
    const pcmPath = outputPath + '.pcm';
    await fs.writeFile(pcmPath, Buffer.from(audioData, 'base64'));
    await runFFmpeg(['-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcmPath, outputPath]);
    await fs.unlink(pcmPath).catch(() => {});

    this.logger.info('Gemini TTS generation complete');
    return outputPath;
  }

  async generateVisualAssets(prompt, style = "ethereal", count = 1) {
    this.logger.info(`Generating ${count} visual assets with style: ${style}`);

    try {
      const enhancedPrompt = this.enhanceVisualPrompt(prompt, style);
      // The built-in Dark Stickman renderer needs no credentials, so a missing or
      // revoked external image key must not downgrade horror beats to simulated
      // placeholders that fail the production gate.
      const localStickmanAvailable = this.isLocalStickmanRendererEnabled() && this.isStickmanPrompt(enhancedPrompt);
      if (!this.openai && !this.gemini && !localStickmanAvailable) {
        return await this.simulateVisualAssets(prompt, style, count);
      }

      const localPaths = [];

      for (let i = 0; i < count; i++) {
        const unique = `${Date.now()}_${i}_${Math.random().toString(36).slice(2, 10)}`;
        const imagePath = path.join(__dirname, '..', 'data', 'assets', `visual_${unique}.png`);
        await this.generateImage(enhancedPrompt, imagePath);
        localPaths.push(imagePath);
      }

      this.logger.info(`Generated ${localPaths.length} visual assets`);
      return localPaths;
    } catch (error) {
      this.logger.error('Visual asset generation failed:', error);
      return await this.simulateVisualAssets(prompt, style, count);
    }
  }

  async generateImage(prompt, imagePath) {
    await fs.mkdir(path.dirname(imagePath), { recursive: true });
    this.lastImageResult = null;

    const useLocalStickman = this.isLocalStickmanRendererEnabled() && this.isStickmanPrompt(prompt);
    if (useLocalStickman) {
      return this.generateLocalStickmanImage(prompt, imagePath);
    }

    try {
      let result;
      let provider;
      let model;
      if (this.openai) {
        result = await this.generateOpenAIImage(prompt, imagePath);
        provider = 'openai';
        model = 'gpt-image-2';
      } else if (this.gemini) {
        result = await this.generateGeminiImage(prompt, imagePath);
        provider = 'gemini';
        model = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
      } else {
        throw new Error('No external image generation provider configured');
      }
      this.lastImageResult = { status: 'ready', path: result, provider, model, generatedAt: new Date().toISOString() };
      return result;
    } catch (error) {
      if (this.isLocalStickmanRendererEnabled() && /horror|stickman/i.test(String(prompt || ''))) {
        this.logger.warn(`External image generation unavailable; using local Dark Stickman renderer: ${error.message}`);
        return this.generateLocalStickmanImage(prompt, imagePath);
      }
      throw error;
    }
  }

  isLocalStickmanRendererEnabled() {
    return !/^(0|false|no)$/i.test(String(process.env.LOCAL_STICKMAN_RENDERER || 'true'));
  }

  isStickmanPrompt(prompt) {
    return /stickman|stick figure|dark stick|psychological horror/i.test(String(prompt || ''));
  }

  async generateLocalStickmanImage(prompt, imagePath) {
    const { svg, meta } = buildStickmanScene(prompt);
    // Remember the beat prompt so the optional animator (ANIMATED_SCENES) can redraw this beat in motion.
    if (!this.stickmanPrompts) this.stickmanPrompts = new Map();
    this.stickmanPrompts.set(path.resolve(imagePath), prompt);
    await sharp(Buffer.from(svg)).png().toFile(imagePath);
    const stats = await fs.stat(imagePath);
    if (!stats.isFile() || stats.size < 100) throw new Error('Local Dark Stickman renderer returned an invalid image');
    this.lastImageResult = {
      status: 'ready',
      path: imagePath,
      provider: 'local-stickman',
      model: 'sharp-svg-v3',
      ...meta,
      generatedAt: new Date().toISOString(),
      simulated: false
    };
    this.logger.info(`Local Dark Stickman scene rendered (${meta.pose} / ${meta.environment})`);
    return imagePath;
  }

  async generateOpenAIImage(prompt, imagePath) {
    const response = await this.openai.images.generate({
      model: "gpt-image-2",
      prompt: prompt,
      n: 1,
      size: "1024x1536",
      quality: "high",
    });

    if (response.data[0].b64_json) {
      const buffer = Buffer.from(response.data[0].b64_json, 'base64');
      await fs.writeFile(imagePath, buffer);
    } else {
      await this.downloadImage(response.data[0].url, imagePath);
    }

    return imagePath;
  }

  async generateGeminiImage(prompt, imagePath) {
    const model = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';

    const response = await this.gemini.models.generateContent({
      model,
      contents: prompt,
      config: {
        responseModalities: ['IMAGE'],
        imageConfig: {
          aspectRatio: process.env.GEMINI_IMAGE_ASPECT_RATIO || '9:16',
          imageSize: '1K'
        }
      }
    });

    const parts = response.candidates?.[0]?.content?.parts || [];
    const imageParts = parts.filter(part =>
      part.inlineData?.data && (!part.inlineData.mimeType || part.inlineData.mimeType.startsWith('image/'))
    );
    const renderedImages = imageParts.filter(part => part.thought !== true);
    const imagePart = (renderedImages.length ? renderedImages : imageParts).at(-1);
    if (!imagePart) {
      throw new Error('Gemini image generation returned no image data');
    }

    const imageBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
    const metadata = await sharp(imageBuffer, { failOn: 'error' }).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error('Gemini image generation returned an invalid image asset');
    }

    const extension = path.extname(imagePath).toLowerCase();
    const output = sharp(imageBuffer, { failOn: 'error' });
    if (extension === '.jpg' || extension === '.jpeg') {
      await output.jpeg({ quality: 92 }).toFile(imagePath);
    } else if (extension === '.webp') {
      await output.webp({ quality: 92 }).toFile(imagePath);
    } else {
      await output.png().toFile(imagePath);
    }
    return imagePath;
  }

  enhanceVisualPrompt(prompt, style) {
    const styleEnhancements = {
      ethereal: "ethereal, dreamy, mystical, soft lighting, floating particles, cosmic background",
      modern: "modern, clean, minimalist, professional, sleek design, contemporary",
      animated: "animated style, cartoon, vibrant colors, expressive, dynamic",
      cinematic: "cinematic lighting, dramatic, movie poster style, high contrast",
      abstract: "abstract art, geometric shapes, gradient colors, artistic composition",
      "photorealistic cinematic documentary realism": "photorealistic cinematic documentary realism, physically plausible materials, natural environmental light, credible real-world scale",
      "dark stickman psychological horror": "minimal dark stickman horror illustration, black stick figure with consistent proportions, near-black charcoal or dark navy environment, restrained deep-red accent only when useful, high-contrast silhouette, cinematic shadow, claustrophobic composition, psychological horror, minimal detail, same recurring character design"
    };

    const normalizedStyle = String(style || '').trim().toLowerCase();
    const enhancement = styleEnhancements[normalizedStyle] || String(style || '').trim() || styleEnhancements["dark stickman psychological horror"];
    if (/documentary|photorealistic|realism/i.test(normalizedStyle)) {
      return `${prompt}, ${enhancement}, high quality, vertical 9:16 composition, no text, no logos, no fantasy effects`;
    }
    return `${prompt}, ${enhancement}, high quality, vertical 9:16 composition, no text, no logos, no comedy, no bright colorful cartoon aesthetic, no gore`;
  }

  async downloadImage(url, outputPath) {
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream'
    });

    const writer = require('fs').createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  }

  async generateVideo(script, visualAssets, audioPath, outputPath, options = {}) {
    this.logger.info('Generating video from assets...');
    this.lastVideoResult = null;
    try {
      if (options.forceImageTimeline === true && Array.isArray(visualAssets) && visualAssets.length) {
        const produced = await this.generateHybridVideo(
          [],
          visualAssets,
          audioPath,
          outputPath,
          options.estimatedDuration || this.calculateScriptDuration(script),
          { signal: options.signal, imageTimeline: options.imageTimeline || null }
        );
        this.lastVideoResult = {
          requestedProvider: 'local-stickman',
          actualProvider: 'slideshow',
          model: 'local-ffmpeg-vertical',
          mode: 'dark-stickman-image-timeline',
          generatedSeconds: Number(options.estimatedDuration || 0),
          timeline: this.lastImageTimeline || null,
          motionError: this.lastTimelineMotionError || null,
          animation: this.lastAnimationResult || null,
          tasks: [],
          scenes: visualAssets.map((asset, index) => ({ index, path: asset, provider: 'synthetic-original', model: 'image' }))
        };
        return produced;
      }

      if (this.mediaGeneration && options.productionId && !this.freeMediaOnly) {
        const generated = await this.mediaGeneration.generateClips({
          jobId: options.jobId || null,
          productionId: options.productionId,
          script,
          visualAssets,
          outputDir: path.dirname(outputPath)
        });
        if (generated.clips.length) {
          const produced = await this.generateHybridVideo(
            generated.clips,
            visualAssets,
            audioPath,
            outputPath,
            options.estimatedDuration || this.calculateScriptDuration(script),
            { signal: options.signal }
          );
          this.lastVideoResult = {
            requestedProvider: generated.requestedProvider,
            actualProvider: generated.actualProvider,
            model: generated.model,
            mode: generated.settings.mode,
            generatedSeconds: generated.clips.reduce((total, clip) => total + clip.duration, 0),
            tasks: generated.clips.map(clip => ({ scene: clip.index, taskId: clip.taskId, provider: clip.provider, model: clip.model })),
            scenes: generated.clips.map(clip => ({
              index: clip.index, label: clip.label, prompt: clip.prompt, duration: clip.duration,
              path: clip.path, taskId: clip.taskId, provider: clip.provider, model: clip.model
            }))
          };
          return produced;
        }
      }

      const produced = await this.generateSlideshowVideo(script, visualAssets, audioPath, outputPath);
      this.lastVideoResult = { requestedProvider: 'slideshow', actualProvider: 'slideshow', model: 'local-ffmpeg', mode: 'slideshow', generatedSeconds: 0, tasks: [], scenes: [] };
      return produced;
    } catch (error) {
      if (error?.code === 'JOB_CANCELLED') throw error;
      // The Logger's console line only shows the message string, so put the real
      // reason inline. Previously the stack alone went to the file transport and
      // the console printed "Video generation failed:" with no detail.
      const reason = error && error.message ? error.message : String(error);
      this.logger.error(`Video provider generation failed; using the local slideshow: ${reason}`, error);
      try {
        const produced = await this.generateSlideshowVideo(script, visualAssets, audioPath, outputPath);
        this.lastVideoResult = {
          requestedProvider: this.lastVideoResult?.requestedProvider || 'configured-provider',
          actualProvider: 'slideshow', model: 'local-ffmpeg', mode: 'fallback', generatedSeconds: 0,
          fallbackReason: reason, tasks: [], scenes: []
        };
        return produced;
      } catch (fallbackError) {
        if (fallbackError?.code === 'JOB_CANCELLED') throw fallbackError;
        this.logger.error(`Local slideshow fallback failed: ${fallbackError.message}`, fallbackError);
        const produced = await this.simulateVideoGeneration(script, visualAssets, audioPath, outputPath);
        this.lastVideoResult = {
          requestedProvider: 'configured-provider', actualProvider: 'simulation', model: null,
          mode: 'simulation', generatedSeconds: 0, fallbackReason: `${reason}; ${fallbackError.message}`, tasks: [], scenes: []
        };
        return produced;
      }
    }
  }

  async generateHybridVideo(clips, visualAssets, audioPath, outputPath, totalDuration, options = {}) {
    if (!(await checkFFmpeg())) throw new Error(ffmpegInstallHint());
    const validImages = await this.filterLocalImageAssets(visualAssets);
    const segments = clips.map(clip => ({ type: 'video', path: clip.path, duration: clip.duration }));
    const generatedDuration = segments.reduce((sum, item) => sum + item.duration, 0);
    const remaining = Math.max(0, this.parseDurationSeconds(totalDuration) - generatedDuration);
    const timeline = this.buildImageTimeline(options.imageTimeline, validImages, remaining);
    this.lastTimelineMotionError = null;
    this.lastImageTimeline = timeline
      ? timeline.map(item => ({ path: item.path, duration: Number(item.duration.toFixed(3)), motion: item.motion }))
      : null;
    this.lastAnimationResult = null;
    if (timeline) {
      segments.push(...(await this.animateStillTimeline(timeline, { signal: options.signal })));
    } else if (remaining && validImages.length) {
      const perImage = Math.max(2, remaining / validImages.length);
      for (const imagePath of validImages) segments.push({ type: 'image', path: imagePath, duration: perImage });
    }
    if (!segments.length) throw new Error('No usable provider clips or still images were generated');

    const visualPath = outputPath.replace(/\.mp4$/i, '_hybrid_visual.mp4');
    await this.renderMediaTimeline(segments, visualPath, { signal: options.signal });
    const expectedDuration = Math.max(1, this.parseDurationSeconds(totalDuration));
    await this.addAudioToVideo(visualPath, audioPath, outputPath, {
      loopVideo: true,
      maxDurationSeconds: expectedDuration + 0.75,
      signal: options.signal
    });
    await fs.unlink(visualPath).catch(() => {});
    return outputPath;
  }

  /**
   * Narration-synced still timeline: each beat keeps the share of runtime its
   * narration needs (scaled to the measured audio) instead of an equal split,
   * and gets a camera move chosen by its role in the story.
   */
  buildImageTimeline(imageTimeline, validImages, totalSeconds) {
    if (!Array.isArray(imageTimeline) || !imageTimeline.length || !(totalSeconds > 0)) return null;
    const usable = new Set(validImages);
    const beats = imageTimeline.filter(beat => beat && usable.has(beat.path));
    if (beats.length !== imageTimeline.length) return null;
    const planned = beats.reduce((sum, beat) => sum + Math.max(0.5, Number(beat.duration) || 0), 0);
    if (!(planned > 0)) return null;
    const scale = totalSeconds / planned;
    const middleMoves = ['drift-right', 'pull-out', 'drift-left', 'push-in'];
    return beats.map((beat, index) => ({
      type: 'image',
      path: beat.path,
      duration: Math.max(2, (Math.max(0.5, Number(beat.duration) || 0)) * scale),
      motion: beat.motion || (index === 0
        ? 'push-in-fast'
        : index === beats.length - 1
          ? 'creep-in'
          : middleMoves[(index - 1) % middleMoves.length])
    }));
  }

  /**
   * ANIMATED_SCENES=true: redraw each local Dark Stickman beat as a moving clip of the same length
   * (same character, same composition; see utils/stickman-animation.js). Animation is cosmetic, so a
   * beat that fails, or any beat after the time budget is spent, keeps its still and camera move.
   */
  async animateStillTimeline(timeline, options = {}) {
    if (!isAnimationEnabled() || !Array.isArray(timeline) || !timeline.length) return timeline;
    const budgetMs = Math.max(30, Number(process.env.ANIMATED_SCENES_MAX_SECONDS) || 480) * 1000;
    const started = Date.now();
    const beats = [];
    const segments = [];
    for (const item of timeline) {
      const prompt = this.stickmanPrompts?.get(path.resolve(item.path));
      const keep = reason => {
        segments.push(item);
        beats.push({ path: item.path, animated: false, reason });
      };
      if (!prompt) { keep('not a local Dark Stickman scene'); continue; }
      if (Date.now() - started > budgetMs) { keep('animation time budget spent'); continue; }
      try {
        const clipPath = item.path.replace(/\.[a-z0-9]+$/i, '') + '_anim.mp4';
        const clip = await renderBeatClip(prompt, item.duration, clipPath, { signal: options.signal });
        segments.push({ type: 'video', path: clip.path, duration: item.duration });
        beats.push({ path: item.path, animated: true, clip: clip.path, frames: clip.frames, fps: clip.fps,
          cutaway: clip.cutaway, characterHash: clip.characterHash, renderMs: clip.renderMs });
      } catch (error) {
        if (error?.code === 'JOB_CANCELLED') throw error;
        this.logger.warn(`Beat animation failed; keeping the still for this beat: ${error.message}`);
        keep(String(error.message || error).slice(0, 200));
      }
    }
    const animated = beats.filter(beat => beat.animated).length;
    this.lastAnimationResult = { enabled: true, animatedBeats: animated, totalBeats: beats.length, renderMs: Date.now() - started, beats };
    this.logger.info(`Animated ${animated}/${beats.length} Dark Stickman beats in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return segments;
  }

  stillMotionFilter(motion, duration) {
    const d = Math.max(0.5, Number(duration) || 1).toFixed(2);
    // zoompan always emits a fixed 1080x1920 frame, so frame geometry and aspect
    // never vary inside a segment (per-frame scaling broke concat in CI).
    // Pre-scaling 1.5x keeps the slow zoom free of integer-pixel jitter.
    const frames = Math.max(1, Math.round(Number(d) * 30));
    const zoom = (amount, outward = false) => {
      const progress = outward ? `(1-on/${frames})` : `(on/${frames})`;
      return `scale=1620:2880,zoompan=z='1+${amount}*${progress}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=30`;
    };
    switch (motion) {
      case 'push-in-fast': return zoom(0.12);
      case 'push-in': return zoom(0.07);
      case 'creep-in': return zoom(0.05);
      case 'pull-out': return zoom(0.08, true);
      case 'drift-right': return `scale=1188:2112,crop=1080:1920:x='(iw-ow)*t/${d}':y='(ih-oh)/2'`;
      case 'drift-left': return `scale=1188:2112,crop=1080:1920:x='(iw-ow)*(1-t/${d})':y='(ih-oh)/2'`;
      default: return null;
    }
  }

  async renderMediaTimeline(segments, outputPath, options = {}) {
    const animated = segments.some(segment => segment.type === 'image' && segment.motion && segment.motion !== 'none');
    if (animated && AIVideoGenerator.stillMotionUnsupported) {
      this.lastTimelineMotionError = `skipped: ${AIVideoGenerator.stillMotionUnsupported}`;
      if (Array.isArray(this.lastImageTimeline)) this.lastImageTimeline = this.lastImageTimeline.map(item => ({ ...item, motion: 'none' }));
      return this.renderMediaTimelineOnce(segments.map(segment => ({ ...segment, motion: 'none' })), outputPath, options);
    }
    if (!animated) return this.renderMediaTimelineOnce(segments, outputPath, options);
    try {
      return await this.renderMediaTimelineOnce(segments, outputPath, options);
    } catch (error) {
      if (error?.code === 'JOB_CANCELLED') throw error;
      // Camera motion is cosmetic: never lose a Short because a filter is not
      // supported by the installed FFmpeg build. Keep the synced timing.
      const lines = String(error?.stderr || error?.message || error).split('\n').map(line => line.trim()).filter(Boolean);
      const significant = lines.filter(line => /error|invalid|undefined|failed|cannot|unable|no such|not supported|mismatch/i.test(line));
      const reason = [...new Set([...significant.slice(0, 4), ...lines.slice(-1)])].join(' | ').slice(0, 600);
      this.logger.warn(`Still-motion render failed; rendering the synced timeline without motion: ${reason}`);
      this.lastTimelineMotionError = reason;
      // Remember for this process so later Shorts do not pay for a failed render.
      AIVideoGenerator.stillMotionUnsupported = reason || 'motion filter failed';
      if (Array.isArray(this.lastImageTimeline)) {
        this.lastImageTimeline = this.lastImageTimeline.map(item => ({ ...item, motion: 'none' }));
      }
      return this.renderMediaTimelineOnce(segments.map(segment => ({ ...segment, motion: 'none' })), outputPath, options);
    }
  }

  async renderMediaTimelineOnce(segments, outputPath, options = {}) {
    const args = ['-y'];
    for (const segment of segments) {
      if (segment.type === 'image') args.push('-loop', '1', '-t', Number(segment.duration).toFixed(2), '-framerate', '30', '-i', segment.path);
      else args.push('-stream_loop', '-1', '-i', segment.path);
    }
    const filters = segments.map((segment, index) => {
      const motion = segment.type === 'image' ? this.stillMotionFilter(segment.motion, segment.duration) : null;
      return `[${index}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,${motion ? `${motion},` : ''}fps=30,format=yuv420p,setsar=1,trim=duration=${Number(segment.duration).toFixed(2)},setpts=PTS-STARTPTS[v${index}]`;
    });
    filters.push(`${segments.map((_, index) => `[v${index}]`).join('')}concat=n=${segments.length}:v=1:a=0[vout]`);
    args.push(
      '-filter_complex', filters.join(';'),
      '-map', '[vout]',
      '-c:v', 'libx264',
      '-preset', process.env.FFMPEG_PRESET || 'veryfast',
      '-crf', process.env.FFMPEG_CRF || '20',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      outputPath
    );
    await runFFmpeg(args, { signal: options.signal });
    return outputPath;
  }

  async filterLocalImageAssets(visualAssets = []) {
    const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
    const images = [];
    for (const asset of visualAssets) {
      if (typeof asset !== 'string' || !imageExtensions.has(path.extname(asset).toLowerCase())) continue;
      try {
        await fs.access(asset);
        images.push(asset);
      } catch (_error) { /* ignore missing assets */ }
    }
    return images;
  }

  parseDurationSeconds(value) {
    if (Number.isFinite(Number(value))) return Math.max(0, Number(value));
    const parts = String(value || '').split(':').map(Number);
    if (parts.length === 2 && parts.every(Number.isFinite)) return Math.max(0, parts[0] * 60 + parts[1]);
    if (parts.length === 3 && parts.every(Number.isFinite)) return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
    return 0;
  }

  async generateSlideshowVideo(script, visualAssets, audioPath, outputPath) {
    this.logger.info('Creating slideshow video...');

    if (!(await checkFFmpeg())) {
      throw new Error(ffmpegInstallHint());
    }

    const { chromium } = require('playwright');
    const browser = await chromium.launch();
    const slidesDir = path.join(path.dirname(outputPath), 'slides');

    try {
      const page = await browser.newPage();
      await page.setViewportSize({ width: 1080, height: 1920 });

      // Create HTML for slideshow (only real image files can be embedded)
      const imageAssets = await this.filterImageAssets(visualAssets);
      await page.setContent(this.createSlideshowHTML(script, imageAssets));

      // Freeze CSS transitions/animations so each still is captured fully rendered
      await page.addStyleTag({ content: '* { transition: none !important; animation: none !important; }' });
      await page.waitForTimeout(1000); // Wait for assets to load

      // Capture ONE still per slide instead of screenshotting at 30fps —
      // FFmpeg turns the stills into a crossfaded video in seconds.
      const slideCount = await page.evaluate(() => document.querySelectorAll('.slide').length);
      await fs.mkdir(slidesDir, { recursive: true });

      const stills = [];
      for (let i = 0; i < slideCount; i++) {
        await page.evaluate((index) => {
          document.querySelectorAll('.slide').forEach((slide, s) => {
            slide.classList.toggle('active', s === index);
          });
        }, i);

        const stillPath = path.join(slidesDir, `slide_${String(i).padStart(3, '0')}.png`);
        await page.screenshot({ path: stillPath });
        stills.push(stillPath);
      }

      const videoPath = outputPath.replace('.mp4', '_visual.mp4');
      const duration = this.calculateScriptDuration(script);
      await this.renderSlidesToVideo(stills, duration, videoPath);

      // Add audio
      await this.addAudioToVideo(videoPath, audioPath, outputPath);

      return outputPath;
    } finally {
      await browser.close().catch(() => {});
      await this.cleanupDirectory(slidesDir);
    }
  }

  async renderSlidesToVideo(stills, totalDuration, videoPath) {
    if (stills.length === 0) {
      throw new Error('No slides to render');
    }

    const fade = 0.5;
    const perSlide = Math.max(2, totalDuration / stills.length);

    const args = ['-y'];
    for (const still of stills) {
      args.push('-loop', '1', '-t', perSlide.toFixed(2), '-framerate', '30', '-i', still);
    }

    if (stills.length === 1) {
      args.push('-vf', 'format=yuv420p', '-c:v', 'libx264', videoPath);
      await runFFmpeg(args);
      return videoPath;
    }

    // Chain crossfades: transition k starts fade seconds before slide k ends
    const filters = [];
    let prev = '[0:v]';
    for (let i = 1; i < stills.length; i++) {
      const out = `[v${i}]`;
      const offset = (i * (perSlide - fade)).toFixed(2);
      filters.push(`${prev}[${i}:v]xfade=transition=fade:duration=${fade}:offset=${offset}${out}`);
      prev = out;
    }
    filters.push(`${prev}format=yuv420p[vfinal]`);

    args.push(
      '-filter_complex', filters.join(';'),
      '-map', '[vfinal]',
      '-c:v', 'libx264',
      '-r', '30',
      videoPath
    );

    await runFFmpeg(args);
    return videoPath;
  }

  async filterImageAssets(visualAssets = []) {
    const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
    const mimeTypes = {
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp'
    };
    const images = [];

    for (const asset of visualAssets) {
      if (typeof asset !== 'string' || !imageExtensions.has(path.extname(asset).toLowerCase())) {
        continue;
      }

      try {
        const imageBuffer = await fs.readFile(asset);
        const metadata = await sharp(imageBuffer, { failOn: 'error' }).metadata();
        const mimeType = mimeTypes[metadata.format];
        if (mimeType && metadata.width && metadata.height) {
          images.push(`data:${mimeType};base64,${imageBuffer.toString('base64')}`);
        }
      } catch (_error) {
        // Skip missing or invalid image files
      }
    }

    return images;
  }

  createSlideshowHTML(script, visualAssets) {
    return `
<!DOCTYPE html>
<html>
<head>
    <style>
        body {
            margin: 0;
            padding: 0;
            width: 1080px;
            height: 1920px;
            background: #07090d;
            font-family: 'Arial', sans-serif;
            overflow: hidden;
        }
        
        .slide {
            position: absolute;
            width: 100%;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            transition: opacity 2s ease-in-out;
        }
        
        .slide.active {
            opacity: 1;
        }
        
        .content {
            text-align: center;
            color: white;
            max-width: 80%;
        }
        
        h1 {
            font-size: 72px;
            margin-bottom: 30px;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.5);
        }
        
        h2 {
            font-size: 48px;
            margin-bottom: 20px;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.5);
        }
        
        p {
            font-size: 36px;
            line-height: 1.4;
            text-shadow: 1px 1px 2px rgba(0,0,0,0.5);
        }
        
        .background-image {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            object-fit: cover;
            opacity: 0.3;
            z-index: -1;
        }
        
        .particles {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            z-index: -1;
        }
        
        .particle {
            position: absolute;
            background: rgba(255,255,255,0.8);
            border-radius: 50%;
            animation: float 6s ease-in-out infinite;
        }
        
        @keyframes float {
            0%, 100% { transform: translateY(0px); }
            50% { transform: translateY(-20px); }
        }
    </style>
</head>
<body>
    <div class="particles"></div>
    
    <!-- Title Slide -->
    <div class="slide active">
        ${visualAssets[0] ? `<img class="background-image" src="${visualAssets[0]}" />` : ''}
        <div class="content">
            <h1>${script.title}</h1>
            <p>Horror Stickman</p>
        </div>
    </div>
    
    ${this.generateContentSlides(script, visualAssets).join('')}
    
    <!-- Subscribe Slide -->
    <div class="slide">
        <div class="content">
            <h2>Follow for more nightmares.</h2>
            <p>Original Dark Stickman horror.</p>
        </div>
    </div>
    
    <script>
        // Create floating particles
        function createParticles() {
            const container = document.querySelector('.particles');
            for (let i = 0; i < 20; i++) {
                const particle = document.createElement('div');
                particle.className = 'particle';
                particle.style.left = Math.random() * 100 + '%';
                particle.style.top = Math.random() * 100 + '%';
                particle.style.width = (Math.random() * 4 + 2) + 'px';
                particle.style.height = particle.style.width;
                particle.style.animationDelay = Math.random() * 6 + 's';
                container.appendChild(particle);
            }
        }
        
        let currentSlide = 0;
        const slides = document.querySelectorAll('.slide');
        
        function advanceAnimation() {
            slides[currentSlide].classList.remove('active');
            currentSlide = (currentSlide + 1) % slides.length;
            slides[currentSlide].classList.add('active');
        }
        
        window.advanceAnimation = advanceAnimation;
        createParticles();
    </script>
</body>
</html>`;
  }

  generateContentSlides(script, visualAssets) {
    const slides = [];
    
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach((section, index) => {
        const assetIndex = Math.min(index + 1, visualAssets.length - 1);
        
        slides.push(`
        <div class="slide">
            ${visualAssets[assetIndex] ? `<img class="background-image" src="${visualAssets[assetIndex]}" />` : ''}
            <div class="content">
                <h2>${section.title}</h2>
                ${this.formatSectionContent(section)}
            </div>
        </div>`);
      });
    }
    
    return slides;
  }

  formatSectionContent(section) {
    if (section.items && Array.isArray(section.items)) {
      return section.items.slice(0, 3).map(item => 
        `<p>${item.number}. ${item.title}</p>`
      ).join('');
    }
    
    if (section.steps && Array.isArray(section.steps)) {
      return section.steps.slice(0, 3).map(step => 
        `<p>${step.title}</p>`
      ).join('');
    }
    
    if (typeof section.content === 'string') {
      return `<p>${section.content.slice(0, 200)}${section.content.length > 200 ? '...' : ''}</p>`;
    }
    
    return '<p>Content coming soon...</p>';
  }

  calculateScriptDuration(script) {
    // Estimate duration based on word count (average 150 words per minute)
    let totalWords = 0;
    
    if (script.hook) totalWords += script.hook.text.split(' ').length;
    if (script.introduction) {
      totalWords += (script.introduction.greeting || '').split(' ').length;
      totalWords += (script.introduction.topicIntro || '').split(' ').length;
    }
    
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach(section => {
        if (typeof section.content === 'string') {
          totalWords += section.content.split(' ').length;
        }
        if (section.items) {
          section.items.forEach(item => {
            totalWords += (item.title + ' ' + item.description).split(' ').length;
          });
        }
        if (section.steps) {
          section.steps.forEach(step => {
            totalWords += (step.title + ' ' + step.description).split(' ').length;
          });
        }
      });
    }
    
    if (script.conclusion) {
      totalWords += script.conclusion.finalThought.split(' ').length;
    }
    
    // Convert to duration (150 words per minute)
    return Math.max(30, Math.ceil((totalWords / 150) * 60));
  }

  async addAudioToVideo(videoPath, audioPath, outputPath, options = {}) {
    const hasRealAudio = await this.isUsableAudioFile(audioPath);

    if (!hasRealAudio) {
      if (options.allowSilent === true) {
        this.logger.warn('Creating an intentionally silent video from an operator-confirmed override.');
        if (videoPath !== outputPath) await fs.copyFile(videoPath, outputPath);
        return outputPath;
      }
      const error = new Error('Narration audio is required. Regenerate narration or explicitly confirm an intentional silent video.');
      error.code = 'NARRATION_REQUIRED';
      throw error;
    }

    // FFmpeg cannot write to its own input, so mux to a temp file when paths collide
    const muxPath = outputPath === videoPath
      ? outputPath.replace(/\.mp4$/i, '_muxed.mp4')
      : outputPath;

    let audioDuration = null;
    let videoDuration = null;
    try {
      audioDuration = await getMediaDuration(audioPath);
    } catch (_error) {
      // The explicit bound below remains available when duration probing is unavailable.
    }
    try {
      videoDuration = await getMediaDuration(videoPath);
    } catch (_error) {
      // If video duration cannot be measured, preserve the caller's loop preference.
    }

    const shouldLoopVideo = options.loopVideo === true && (
      !Number.isFinite(videoDuration) ||
      !Number.isFinite(audioDuration) ||
      videoDuration + 0.25 < audioDuration
    );
    const videoInput = shouldLoopVideo ? ['-stream_loop', '-1', '-i', videoPath] : ['-i', videoPath];

    const explicitMax = Number(options.maxDurationSeconds);
    const derivedMax = Number.isFinite(audioDuration) && audioDuration > 0 ? audioDuration + 0.25 : null;
    const maxDurationSeconds = Number.isFinite(explicitMax) && explicitMax > 0
      ? (Number.isFinite(derivedMax) ? Math.max(explicitMax, derivedMax) : explicitMax)
      : derivedMax;
    const durationBound = Number.isFinite(maxDurationSeconds) && maxDurationSeconds > 0
      ? ['-t', maxDurationSeconds.toFixed(3)]
      : [];

    if (shouldLoopVideo && !durationBound.length) {
      const error = new Error('Looped video/audio mux requires a finite duration bound');
      error.code = 'MUX_DURATION_REQUIRED';
      throw error;
    }

    await runFFmpeg([
      '-y',
      ...videoInput,
      '-i', audioPath,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-shortest',
      ...durationBound,
      muxPath
    ], { signal: options.signal });

    if (muxPath !== outputPath) {
      await fs.rename(muxPath, outputPath);
    }

    this.logger.info('Audio added to video successfully');
    return outputPath;
  }

  async isUsableAudioFile(audioPath) {
    if (typeof audioPath !== 'string' || audioPath.endsWith('.info')) {
      return false;
    }

    try {
      const stats = await fs.stat(audioPath);
      return stats.isFile() && stats.size > 0;
    } catch (error) {
      return false;
    }
  }

  async cleanupDirectory(dirPath) {
    try {
      const files = await fs.readdir(dirPath);
      for (const file of files) {
        await fs.unlink(path.join(dirPath, file));
      }
      await fs.rmdir(dirPath);
    } catch (error) {
      this.logger.warn('Cleanup failed:', error.message);
    }
  }

  async generateThumbnail(script, style = "cinematic documentary", options = {}) {
    this.logger.info('Generating custom thumbnail...');

    try {
      if (!this.openai && !this.gemini) {
        return await this.simulateThumbnailGeneration(script, style);
      }

      const prompt = String(options.prompt || '').trim() || [
        `Premium cinematic documentary YouTube thumbnail for "${script.title}"`,
        `${style} style`,
        'one dominant real-world subject',
        'photorealistic, believable lighting, physically plausible scale',
        'clean composition readable at mobile size',
        'no text, no arrows, no circles, no collage, no fantasy glow, no watermark'
      ].join(', ');
      const thumbnailPath = path.join(__dirname, '..', 'uploads', 'thumbnails', `thumbnail_${Date.now()}.png`);

      await this.generateImage(prompt, thumbnailPath);
      const metadata = await sharp(thumbnailPath).metadata();

      return {
        path: thumbnailPath,
        dimensions: { width: metadata.width, height: metadata.height },
        fileSize: await this.getFileSize(thumbnailPath)
      };
    } catch (error) {
      this.logger.error('Thumbnail generation failed:', error);
      return await this.simulateThumbnailGeneration(script, style);
    }
  }

  async getFileSize(filePath) {
    const stats = await fs.stat(filePath);
    return stats.size;
  }

  // Simulation methods for when APIs are not available
  async simulateTTSGeneration(text, outputPath) {
    this.logger.info('Simulating TTS generation...');
    
    const infoPath = outputPath + '.info';
    await fs.writeFile(infoPath, JSON.stringify({
      message: 'AI TTS audio would be generated here',
      text: text.substring(0, 100) + '...',
      timestamp: new Date().toISOString()
    }, null, 2));
    
    return infoPath;
  }

  async simulateVisualAssets(prompt, style, count) {
    this.logger.info(`Simulating ${count} visual assets...`);
    
    const paths = [];
    for (let i = 0; i < count; i++) {
      const assetPath = path.join(__dirname, '..', 'data', 'assets', `visual_sim_${Date.now()}_${i}.info`);
      
      await fs.writeFile(assetPath, JSON.stringify({
        message: 'AI visual asset would be generated here',
        prompt: prompt,
        style: style,
        timestamp: new Date().toISOString()
      }, null, 2));
      
      paths.push(assetPath);
    }
    
    return paths;
  }

  async simulateVideoGeneration(script, visualAssets, audioPath, outputPath) {
    this.logger.info('Simulating video generation...');
    
    const infoPath = outputPath + '.info';
    await fs.writeFile(infoPath, JSON.stringify({
      message: 'AI video would be generated here',
      script: script.title,
      visualAssets: visualAssets.length,
      audioPath: audioPath,
      timestamp: new Date().toISOString()
    }, null, 2));
    
    return infoPath;
  }

  async simulateThumbnailGeneration(script, style) {
    this.logger.info('Simulating thumbnail generation...');
    
    const thumbnailPath = path.join(__dirname, '..', 'uploads', 'thumbnails', `thumbnail_sim_${Date.now()}.info`);
    await fs.mkdir(path.dirname(thumbnailPath), { recursive: true });
    
    await fs.writeFile(thumbnailPath, JSON.stringify({
      message: 'AI thumbnail would be generated here',
      title: script.title,
      style: style,
      timestamp: new Date().toISOString()
    }, null, 2));
    
    return {
      path: thumbnailPath,
      dimensions: { width: 1792, height: 1024 },
      fileSize: 1024,
      simulated: true
    };
  }
}

module.exports = { AIVideoGenerator };
