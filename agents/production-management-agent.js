const path = require('path');
const fs = require('fs').promises;
const { Logger } = require('../utils/logger');
const { AIVideoGenerator } = require('../utils/ai-video-generator');
const { SceneRepairService } = require('../utils/scene-repair-service');
const { runFFmpeg, getMediaDuration } = require('../utils/ffmpeg');
const { ambientEnabled, mixHorrorAudio } = require('../utils/audio-mix');
const { detectSpeechWindow, buildCaptionCues, cuesToSrt } = require('../utils/speech-timing');
const channelIdentity = require('../utils/channel-identity');

class ProductionManagementAgent {
  constructor(db, credentials) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('ProductionManagement');
    this.pipeline = [];
    this.assets = new Map();
    this.aiVideoGenerator = new AIVideoGenerator(credentials, { db });
    this.sceneRepair = new SceneRepairService(db, this.aiVideoGenerator, { logger: this.logger });
    this.freeMediaOnly = !/^(0|false|no)$/i.test(String(process.env.FREE_MEDIA_ONLY || 'true'));
    this.identity = channelIdentity;
  }

  async initialize() {
    this.logger.info('Initializing Production Management Agent...');
    await this.setupDirectories();
    await this.loadPipeline();
    return true;
  }

  async setupDirectories() {
    const dirs = [
      'data/production',
      'data/assets',
      'data/videos',
      'data/audio',
      'data/scripts',
      'temp/processing'
    ];

    for (const dir of dirs) {
      await fs.mkdir(path.join(__dirname, '..', dir), { recursive: true });
    }
  }

  async loadPipeline() {
    try {
      const pipeline = await this.db.getProductionPipeline();
      this.pipeline = pipeline || [];
    } catch (error) {
      this.logger.warn('No existing pipeline found, starting fresh');
    }
  }

  async processContent(contentData) {
    try {
      this.logger.info('Processing content for production...');
      
      const { strategy, script, thumbnail, seo, jobId = null, abortSignal = null } = contentData;
      
      // Create production entry
      const productionId = this.generateProductionId();
      
      const productionData = {
        id: productionId,
        strategy,
        script,
        thumbnail,
        seo,
        status: 'processing',
        assets: {
          script: await this.processScript(script),
          thumbnail: await this.processThumbnail(thumbnail, script),
          audio: null, // Will be generated later
          video: null, // Will be generated later
          captions: null // Will be generated later
        },
        timeline: {
          created: new Date().toISOString(),
          scriptReady: new Date().toISOString(),
          thumbnailReady: new Date().toISOString(),
          audioGenerated: null,
          videoGenerated: null,
          captionsGenerated: null,
          readyForUpload: null
        },
        scheduledPublishTime: this.calculatePublishTime(strategy),
        priority: this.calculatePriority(strategy),
        contentType: strategy?.fictional === true ? 'short' : (strategy?.contentType || 'short'),
        estimatedDuration: strategy?.fictional === true
          ? Math.max(20, Math.min(45, Number(script.duration) || Math.ceil(Number(script.metadata?.spokenWordCount || 105) / 2.7)))
          : script.duration,
        createdAt: new Date().toISOString()
      };
      productionData.jobId = jobId;
      
      // Add to pipeline
      this.pipeline.push(productionData);
      
      // Save to database
      await this.db.saveProductionData(productionData);
      
      // Generate video content
      await this.generateVideoContent(productionData, { signal: abortSignal });

      // The initial thumbnail is only creative direction; promote the first rendered
      // Dark Stickman frame into the production thumbnail.
      await this.promoteThumbnail(productionData, { signal: abortSignal });
      
      // Generate audio narration
      await this.generateAudioNarration(productionData);
      
      // Generate captions
      await this.generateCaptions(productionData);
      
      // Final assembly
      await this.assembleVideo(productionData, { signal: abortSignal });

      // Persist a scene-addressable production manifest for selective review and repair.
      // Keep the saved manifest on the production object as well so the first
      // quality review evaluates the same scene state the editor will later see.
      productionData.scenes = await this.sceneRepair.initializeProduction(
        productionData,
        this.aiVideoGenerator.lastVideoResult || {},
        { signal: abortSignal }
      );

      // Mark as ready — or simulated, when no real video could be produced
      const simulated = Boolean(productionData.assets.finalVideo?.simulated);
      if (simulated) {
        productionData.status = 'simulated';
        this.logger.warn(`Content ${productionId} produced PLACEHOLDER assets only — it will NOT be uploaded. Check your AI provider keys and FFmpeg installation.`);
      } else {
        productionData.status = 'ready';
        productionData.timeline.readyForUpload = new Date().toISOString();
      }

      await this.db.updateProductionData(productionData);

      this.logger.info(`Content processing complete: ${productionId} (status: ${productionData.status})`);
      return productionData;
    } catch (error) {
      this.logger.error('Failed to process content:', error);
      throw error;
    }
  }

  generateProductionId() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    const extra = Math.random().toString(36).substring(2, 15);
    return `prod_${timestamp}_${random}_${extra}`;
  }

  async processScript(script) {
    const scriptPath = path.join(__dirname, '..', 'data', 'scripts', `${Date.now()}_script.json`);
    
    // Create formatted script for TTS
    const ttsScript = this.formatScriptForTTS(script);
    
    // Save script files
    await fs.writeFile(scriptPath, JSON.stringify(script, null, 2));
    await fs.writeFile(
      scriptPath.replace('.json', '_tts.txt'), 
      ttsScript
    );
    
    return {
      originalPath: scriptPath,
      ttsPath: scriptPath.replace('.json', '_tts.txt'),
      duration: script.duration,
      sections: script.mainContent.sections.length
    };
  }

  formatScriptForTTS(script) {
    const segments = this.buildNarrationSegments(script);
    return segments
      .map(segment => segment.text)
      .filter(Boolean)
      .join('\n\n')
      .trim();
  }

  buildNarrationSegments(script) {
    const segments = [];
    const push = (role, text, duration = null) => {
      const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
      if (cleaned) segments.push({ role, text: cleaned, duration });
    };

    push('hook', script.hook?.text || script.hook, this.parseDurationSeconds(script.hook?.duration));

    if (script.introduction) {
      push(
        'setup',
        [script.introduction.topicIntro, script.introduction.valueProposition, script.introduction.credibility]
          .filter(Boolean)
          .join(' '),
        this.parseDurationSeconds(script.introduction.duration)
      );
    }

    let storyStarted = false;
    for (const section of script.mainContent?.sections || []) {
      let text = '';
      if (Array.isArray(section.content)) {
        text = section.content.filter(line => typeof line === 'string' && !line.startsWith('[')).join(' ');
      } else if (typeof section.content === 'string') {
        text = section.content;
      } else if (Array.isArray(section.steps)) {
        text = section.steps.map(step => [step.title, step.description, step.tip].filter(Boolean).join('. ')).join(' ');
      } else if (Array.isArray(section.items)) {
        text = section.items.map(item => [item.title, item.description].filter(Boolean).join('. ')).join(' ');
      }
      if (!storyStarted) {
        text = this.stripRepeatedHook(text, script.hook?.text || script.hook);
        storyStarted = true;
      }
      push('story', text, Number(section.duration) || null);
    }

    if (script.conclusion) {
      push(
        'payoff',
        [...(Array.isArray(script.conclusion.recap) ? script.conclusion.recap : []), script.conclusion.finalThought]
          .filter(Boolean)
          .join(' '),
        this.parseDurationSeconds(script.conclusion.duration)
      );
    }

    push('cta', script.callToAction?.subscribe || script.callToAction?.text, this.parseDurationSeconds(script.callToAction?.duration));
    return segments;
  }

  /**
   * The writer sometimes repeats the hook as the first words of the first beat. The hook is
   * already narrated as its own segment, so reading it twice adds seconds the runtime gate
   * then counts against the 45 s window.
   */
  stripRepeatedHook(text, hook) {
    const body = String(text || '').replace(/\s+/g, ' ').trim();
    const opening = String(hook || '').replace(/\s+/g, ' ').trim();
    if (!opening || !body) return body;
    if (body.toLowerCase().startsWith(opening.toLowerCase())) {
      return body.slice(opening.length).replace(/^\s+/, '');
    }
    return body;
  }

  parseDurationSeconds(value) {
    if (Number.isFinite(Number(value))) return Number(value);
    const text = String(value || '').trim();
    const range = text.match(/(\d+):(\d+)\s*-\s*(\d+):(\d+)/);
    if (range) {
      const start = Number(range[1]) * 60 + Number(range[2]);
      const end = Number(range[3]) * 60 + Number(range[4]);
      return Math.max(0, end - start);
    }
    const seconds = text.match(/(\d+(?:\.\d+)?)\s*seconds?/i);
    return seconds ? Number(seconds[1]) : null;
  }

  async processThumbnail(thumbnail, script) {
    if (this.freeMediaOnly) {
      // The ThumbnailDesignerAgent supplies creative direction only. In free-only
      // production we do not call any synthetic/paid image provider here; the first
      // rendered Dark Stickman frame is promoted after scene rendering.
      return {
        path: thumbnail.path,
        originalPath: thumbnail.path,
        dimensions: thumbnail.dimensions || { width: 1280, height: 720 },
        fileSize: thumbnail.fileSize || 0,
        generatedWith: 'creative-direction-draft',
        concept: thumbnail.concept,
        prompt: thumbnail.prompt,
        productionReady: false,
        reviewRequired: true
      };
    }

    try {
      // Generate from the creative-direction brief selected by ThumbnailDesignerAgent.
      const thumbnailScript = thumbnail.script || script || { title: thumbnail.title || 'Untitled Video' };
      const aiThumbnail = await this.aiVideoGenerator.generateThumbnail(
        thumbnailScript,
        thumbnail.concept?.visualStyle || 'cinematic documentary',
        { prompt: thumbnail.prompt, concept: thumbnail.concept }
      );
      
      return {
        path: aiThumbnail.path,
        originalPath: thumbnail.path,
        dimensions: aiThumbnail.dimensions,
        fileSize: aiThumbnail.fileSize,
        generatedWith: 'AI',
        concept: thumbnail.concept,
        prompt: thumbnail.prompt,
        reviewRequired: true
      };
    } catch (error) {
      this.logger.error('AI thumbnail generation failed:', error);
      
      // Fallback to original processing
      const productionThumbnailPath = path.join(
        __dirname, '..', 'data', 'assets', 
        `thumbnail_${Date.now()}.jpg`
      );
      
      if (thumbnail.path && await fs.access(thumbnail.path).then(() => true).catch(() => false)) {
        const originalBuffer = await fs.readFile(thumbnail.path);
        await fs.writeFile(productionThumbnailPath, originalBuffer);
      } else {
        // Create placeholder
        await fs.writeFile(productionThumbnailPath + '.placeholder', 'Thumbnail placeholder');
      }
      
      return {
        path: productionThumbnailPath,
        originalPath: thumbnail.path,
        dimensions: thumbnail.dimensions || { width: 1280, height: 720 },
        fileSize: thumbnail.fileSize || 0,
        generatedWith: 'local-draft-fallback',
        concept: thumbnail.concept,
        prompt: thumbnail.prompt,
        reviewRequired: true
      };
    }
  }

  async promoteThumbnail(productionData, options = {}) {
    const current = productionData.assets?.thumbnail || {};
    const scenes = productionData.assets?.video?.scenePlan || [];

    if (productionData.strategy?.fictional === true) {
      const firstFrame = scenes.find(scene =>
        scene?.assetPath &&
        scene.simulated !== true &&
        /\.(png|jpe?g|webp)$/i.test(String(scene.assetPath))
      );
      if (!firstFrame) {
        current.productionReady = false;
        current.thumbnailError = 'No generated Dark Stickman first frame is available';
        productionData.assets.thumbnail = current;
        return current;
      }
      const outputPath = path.join(__dirname, '..', 'data', 'assets', `thumbnail_${productionData.id}.jpg`);
      try {
        await runFFmpeg([
          '-y',
          '-i', firstFrame.assetPath,
          '-frames:v', '1',
          '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black',
          '-q:v', '2',
          outputPath
        ], { timeoutMs: 120000, signal: options.signal });
        const stat = await fs.stat(outputPath);
        productionData.assets.thumbnail = {
          ...current,
          path: outputPath,
          dimensions: { width: 1280, height: 720 },
          fileSize: stat.size,
          generatedWith: 'horror-first-frame',
          sourceSceneIndex: firstFrame.index,
          sourceAssetPath: firstFrame.assetPath,
          mediaClass: 'synthetic-fiction',
          visualTruthfulness: 'fictional',
          productionReady: true,
          reviewRequired: false,
          thumbnailError: null
        };
        return productionData.assets.thumbnail;
      } catch (error) {
        current.productionReady = false;
        current.thumbnailError = error.message;
        productionData.assets.thumbnail = current;
        return current;
      }
    }

    current.productionReady = false;
    current.thumbnailError = 'Only original fictional Dark Stickman productions can be promoted to a production thumbnail';
    productionData.assets.thumbnail = current;
    return current;
  }

  calculatePublishTime(strategy) {
    return strategy.bestPublishTime || null;
  }

  calculatePriority(strategy) {
    const explicit = Number(strategy.priority);
    return Number.isFinite(explicit) ? Math.max(0, Math.min(100, explicit)) : 50;
  }

  async generateHorrorStickmanVideoContent(productionData, options = {}) {
    this.logger.info('Building Dark Stickman horror visual plan...');
    const scenePlan = this.createHorrorStickmanScenePlan(productionData.script, productionData.strategy, productionData.estimatedDuration);
    const visualStyle = 'dark stickman psychological horror';
    const visualAssets = [];
    const sceneAssets = [];

    for (const scene of scenePlan) {
      if (options.signal?.aborted) {
        const error = new Error('Horror Stickman generation cancelled');
        error.code = 'JOB_CANCELLED';
        throw error;
      }
      const generated = await this.aiVideoGenerator.generateVisualAssets(scene.prompt, visualStyle, 1);
      const assetPath = generated[0] || null;
      let usable = false;
      if (assetPath && !String(assetPath).endsWith('.info')) {
        try {
          const stat = await fs.stat(assetPath);
          usable = stat.isFile() && stat.size > 0 && /\.(png|jpe?g|webp)$/i.test(assetPath);
        } catch (_error) {
          usable = false;
        }
      }
      if (usable) visualAssets.push(assetPath);
      // Evidence from the built-in renderer: which reference character, pose and place.
      const rendered = usable && this.aiVideoGenerator.lastImageResult?.provider === 'local-stickman'
        ? this.aiVideoGenerator.lastImageResult : null;
      sceneAssets.push({
        ...scene,
        visual: rendered ? {
          characterVersion: rendered.characterVersion,
          characterHash: rendered.characterHash,
          pose: rendered.pose,
          environment: rendered.environment,
          composition: rendered.composition,
          props: rendered.props,
          renderer: rendered.model
        } : null,
        assetPath: usable ? assetPath : null,
        mediaType: usable ? 'image' : null,
        provider: usable ? 'synthetic-original' : null,
        mediaClass: usable ? 'synthetic-fiction' : null,
        assetOrigin: usable ? 'generated' : null,
        rightsConfirmed: usable,
        exactVisualClaim: false,
        visualTruthfulness: 'fictional',
        simulated: !usable
      });
    }

    const completeCoverage = sceneAssets.length >= 4 && sceneAssets.every(scene => !scene.simulated);
    productionData.assets.video = {
      visualAssets,
      stockClips: [],
      provenance: [],
      scenePlan: sceneAssets,
      duration: productionData.estimatedDuration,
      format: 'mp4',
      resolution: '1080x1920',
      fps: 30,
      generatedWith: completeCoverage ? 'AI-stickman' : 'AI-stickman-partial',
      simulated: !completeCoverage,
      visualStyle,
      fictional: true
    };
    productionData.containsSyntheticMedia = true;
    if (completeCoverage) productionData.timeline.videoGenerated = new Date().toISOString();
    else this.logger.warn('Dark Stickman image generation did not cover every beat; production remains fail-closed.');
    return visualAssets;
  }

  createHorrorStickmanScenePlan(script, strategy = {}, estimatedDuration = 35) {
    const sections = (script.mainContent?.sections || []).slice(0, 7);
    const hook = String(script.hook?.text || script.hook || '').replace(/\s+/g, ' ').trim();
    const totalDuration = Math.max(20, Math.min(45, Number(estimatedDuration) || 35));
    const characterSignature = 'same recurring adult stickman: circular head, thin black limbs, no detailed face except two tiny pale eyes only when fear requires it, identical proportions in every scene';
    const palette = 'near-black charcoal and dark navy environment, restrained deep-red accent only when narratively useful';
    const entries = sections.map((section, index) => {
      const body = (Array.isArray(section.content) ? section.content : [section.content])
        .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      return {
        section,
        narration: index === 0 ? [hook, body].filter(Boolean).join(' ') : body,
        index
      };
    });
    const totalWords = Math.max(1, entries.reduce((sum, entry) => sum + entry.narration.split(/\s+/).filter(Boolean).length, 0));

    return entries.map((entry, index) => {
      const words = entry.narration.split(/\s+/).filter(Boolean).length;
      const duration = Math.max(3, totalDuration * (words / totalWords));
      const visualQuery = String(entry.section.visualQuery || strategy.visualVariety?.[index] || strategy.scrollStopMoment || strategy.topic || '')
        .replace(/\s+/g, ' ').trim();
      const firstFrame = index === 0
        ? 'This is the first scroll-stop frame: make the impossible threat readable instantly before any explanation.'
        : 'Advance the threat into a materially different visual state from the previous beat.';
      return {
        index,
        role: index === 0 ? 'hook' : (index === entries.length - 1 ? 'twist' : 'story'),
        label: String(entry.section.title || `Beat ${index + 1}`).trim(),
        parentLabel: String(entry.section.title || `Beat ${index + 1}`).trim(),
        narration: entry.narration,
        duration,
        visualIntent: visualQuery,
        allocationQuery: visualQuery,
        referenceQuery: '',
        requiredAny: entry.section.visualRequiredAny || ['stickman'],
        forbiddenAny: entry.section.visualForbiddenAny || ['bright', 'comedy', 'gore', 'childlike cartoon'],
        factualBoundary: 'Original fictional horror. Do not depict real people, real crimes, logos, copyrighted horror characters, graphic injury, or readable text.',
        sourceUrls: [],
        prompt: [
          'HORROR STICKMAN BRAND LOCK:',
          characterSignature + '.',
          palette + '.',
          'Minimal dark stickman horror illustration, high-contrast silhouette, cinematic shadow, claustrophobic composition, psychological unease, sparse detail.',
          'Vertical 9:16 composition designed for a YouTube Short.',
          firstFrame,
          `BEAT POSITION: ${index + 1} of ${entries.length}`,
          `SCENE: ${visualQuery}`,
          `STORY BEAT: ${entry.narration}`,
          'Use one dominant fear cue. Preserve the same character proportions and visual language as every other scene.',
          'No comedy, no cheerful expression, no bright colorful cartoon aesthetic, no gore, no text, no captions inside the generated image, no logos, no collage.'
        ].join('\n')
      };
    });
  }

  async generateVideoContent(productionData, options = {}) {
    if (productionData.strategy?.fictional === true || productionData.script?.metadata?.fictional === true) {
      return this.generateHorrorStickmanVideoContent(productionData, options);
    }
    // Only original fictional Dark Stickman productions are supported; the legacy
    // documentary/stock-footage pipeline was removed.
    throw new Error('Unsupported production: only original fictional Dark Stickman Shorts can be produced');
  }

  async generateAudioNarration(productionData) {
    this.logger.info('Generating AI audio narration...');
    
    try {
      const audioPath = path.join(__dirname, '..', 'data', 'audio', `${productionData.id}_narration.mp3`);
      
      // Read the TTS script
      const ttsText = await fs.readFile(productionData.assets.script.ttsPath, 'utf8');
      
      // Generate audio using AI TTS and retain the provider evidence returned by the generator.
      const generatedPath = await this.aiVideoGenerator.generateTTSAudio(ttsText, audioPath);
      const evidence = this.aiVideoGenerator.lastNarrationResult || {};
      const usable = await this.aiVideoGenerator.isUsableAudioFile(generatedPath);

      let measuredDuration = null;
      if (usable) {
        try {
          measuredDuration = await getMediaDuration(generatedPath);
          if (productionData.strategy?.fictional === true && measuredDuration > 44.25) {
            measuredDuration = await this.normalizeHorrorNarrationDuration(generatedPath, measuredDuration);
          }
        } catch (error) {
          // A narration that cannot fit the 20-45 s window is a production failure: carrying
          // it forward only renders a video the runtime gate is certain to reject.
          if (error.code === 'NARRATION_RUNTIME_CONTRACT') throw error;
          this.logger.warn(`Could not normalize/measure narration duration; using the script estimate: ${error.message}`);
        }
      }

      productionData.assets.audio = {
        path: generatedPath,
        duration: measuredDuration || productionData.estimatedDuration,
        measuredDuration: measuredDuration || null,
        format: 'mp3',
        generatedWith: 'AI',
        quality: usable ? 'high' : null,
        status: usable ? 'ready' : 'unavailable',
        simulated: !usable,
        provider: evidence.provider || null,
        model: evidence.model || null,
        externalTaskId: evidence.externalTaskId || null,
        generatedAt: evidence.generatedAt || new Date().toISOString(),
        cost: evidence.cost || {},
        error: usable ? null : 'No live narration provider returned usable audio',
        intentionalSilence: false
      };

      if (usable) productionData.timeline.audioGenerated = new Date().toISOString();
      return generatedPath;
    } catch (error) {
      if (error.code === 'NARRATION_RUNTIME_CONTRACT') throw error;
      this.logger.error('AI audio generation failed:', error);
      return await this.simulateAudioGeneration(productionData, error);
    }
  }

  async normalizeHorrorNarrationDuration(audioPath, measuredDuration) {
    const targetDuration = 43.5;
    const sourceDuration = Number(measuredDuration);
    if (!Number.isFinite(sourceDuration) || sourceDuration <= 44.25) return sourceDuration;

    const tempo = sourceDuration / targetDuration;
    if (!Number.isFinite(tempo) || tempo <= 1 || tempo > 1.35) {
      const error = new Error(
        `Horror narration runtime ${sourceDuration.toFixed(2)}s cannot be normalized safely into the 20-45s Shorts window`
      );
      error.code = 'NARRATION_RUNTIME_CONTRACT';
      throw error;
    }

    const normalizedPath = audioPath.replace(/\.mp3$/i, '_runtime_normalized.mp3');
    await runFFmpeg([
      '-y',
      '-i', audioPath,
      '-filter:a', `atempo=${tempo.toFixed(5)}`,
      '-vn',
      '-c:a', 'libmp3lame',
      '-q:a', '2',
      normalizedPath
    ], { timeoutMs: 120000 });

    const normalizedDuration = await getMediaDuration(normalizedPath);
    if (!Number.isFinite(normalizedDuration) || normalizedDuration < 20 || normalizedDuration > 44.5) {
      await fs.unlink(normalizedPath).catch(() => {});
      const error = new Error(
        `Normalized Horror narration duration ${Number(normalizedDuration || 0).toFixed(2)}s is outside the safe 20-44.5s window`
      );
      error.code = 'NARRATION_RUNTIME_CONTRACT';
      throw error;
    }

    await fs.unlink(audioPath).catch(() => {});
    await fs.rename(normalizedPath, audioPath);
    this.logger.info(
      `Normalized Horror narration runtime from ${sourceDuration.toFixed(2)}s to ${normalizedDuration.toFixed(2)}s (tempo ${tempo.toFixed(3)}x)`
    );
    return normalizedDuration;
  }

  async generateCaptions(productionData) {
    this.logger.info('Generating captions...');
    
    const captionsPath = path.join(__dirname, '..', 'data', 'captions', `${productionData.id}_captions.srt`);
    
    // Generate SRT captions based on script timing
    const captions = await this.createSRTCaptions(productionData);
    
    await fs.mkdir(path.dirname(captionsPath), { recursive: true });
    await fs.writeFile(captionsPath, captions);
    
    productionData.assets.captions = {
      path: captionsPath,
      format: 'srt',
      language: 'en',
      autoGenerated: true
    };
    
    productionData.timeline.captionsGenerated = new Date().toISOString();
    
    return captionsPath;
  }

  async createSRTCaptions(productionData) {
    const segments = this.buildNarrationSegments(productionData.script);
    const words = segments.flatMap(segment => segment.text.split(/\s+/).filter(Boolean));
    if (words.length === 0) return '';

    const estimatedDuration = Math.max(
      1,
      Number(productionData.assets?.audio?.measuredDuration) ||
      Number(productionData.assets?.audio?.duration) ||
      Number(productionData.estimatedDuration) ||
      segments.reduce((sum, segment) => sum + (Number(segment.duration) || 0), 0) ||
      Math.ceil(words.length / 2.5)
    );
    // Horror Shorts: place captions inside the real speech window (voice onset to end,
    // weighted by word length and sentence pauses). Any failure keeps the even split below.
    const narrationPath = productionData.assets?.audio?.path;
    if (productionData.strategy?.fictional === true && narrationPath && productionData.assets?.audio?.simulated !== true) {
      try {
        const speech = await detectSpeechWindow(narrationPath);
        const cues = buildCaptionCues(words, { start: speech.speechStart, end: speech.speechEnd }, 4);
        if (cues.length) {
          this.logger.info(`Captions aligned to speech ${speech.speechStart.toFixed(2)}s-${speech.speechEnd.toFixed(2)}s (${cues.length} cues, ${speech.pauses.length} pauses)`);
          return cuesToSrt(cues);
        }
      } catch (error) {
        this.logger.warn(`Speech-aligned captions unavailable; using the even word split: ${error.message}`);
      }
    }
    const secondsPerWord = estimatedDuration / words.length;
    const wordsPerCaption = productionData.strategy?.fictional === true ? 4 : 7;
    let srt = '';
    let index = 1;

    const formatSRTTime = seconds => {
      const totalMs = Math.max(0, Math.round(seconds * 1000));
      const hours = Math.floor(totalMs / 3600000);
      const minutes = Math.floor((totalMs % 3600000) / 60000);
      const secs = Math.floor((totalMs % 60000) / 1000);
      const ms = totalMs % 1000;
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
    };

    for (let offset = 0; offset < words.length; offset += wordsPerCaption) {
      const captionWords = words.slice(offset, offset + wordsPerCaption);
      const start = offset * secondsPerWord;
      const end = Math.min(estimatedDuration, (offset + captionWords.length) * secondsPerWord);
      srt += `${index}\n${formatSRTTime(start)} --> ${formatSRTTime(end)}\n${captionWords.join(' ')}\n\n`;
      index += 1;
    }

    return srt;
  }

  async burnCaptionsIntoVideo(videoPath, captionsPath, options = {}) {
    if (!videoPath || !captionsPath) throw new Error('Burn-in captions require both video and SRT paths');
    const captionedPath = videoPath.replace(/\.mp4$/i, '_captioned.mp4');
    const escaped = path.resolve(captionsPath)
      .replace(/\\/g, '/')
      .replace(/:/g, '\\:')
      .replace(/'/g, "\\'");
    const filter = `subtitles='${escaped}':force_style='FontName=Arial,FontSize=22,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=3,Shadow=0,Alignment=2,MarginV=210'`;
    await runFFmpeg([
      '-y',
      '-i', videoPath,
      '-vf', filter,
      '-c:v', 'libx264',
      '-preset', process.env.FFMPEG_PRESET || 'veryfast',
      '-crf', process.env.FFMPEG_CRF || '20',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      captionedPath
    ], { timeoutMs: Number(process.env.FFMPEG_CAPTION_TIMEOUT_MS) || 420000, signal: options.signal });
    await fs.unlink(videoPath).catch(() => {});
    await fs.rename(captionedPath, videoPath);
    return videoPath;
  }

  /**
   * Mix narration + ambient bed + stingers. The twist stab lands where the final
   * beat starts, using the same scaled beat durations the picture timeline uses.
   * A failed mix is recorded (QA then blocks the upload) and the bare narration is
   * returned so assembly can still finish and the failure stays inspectable.
   */
  async buildHorrorAudioMix(productionData, scenePlan, options = {}) {
    const narrationPath = productionData.assets.audio.path;
    const outputPath = path.join(path.dirname(narrationPath), `${productionData.id}_mix.wav`);
    const beats = (Array.isArray(scenePlan) ? scenePlan : []).filter(scene => scene && scene.simulated !== true);
    const durations = beats.map(scene => Math.max(0, Number(scene.duration) || 0));
    const total = durations.reduce((sum, value) => sum + value, 0);
    const twistAt = beats.length > 1 && durations[durations.length - 1] > 0
      ? Math.max(0, total - durations[durations.length - 1])
      : null;
    try {
      const mix = await mixHorrorAudio({
        narrationPath,
        outputPath,
        seed: productionData.strategy?.topic || productionData.id,
        twistAt,
        signal: options.signal
      });
      productionData.assets.audio.mix = mix;
      this.logger.info(`Audio mix ready: ${mix.palette} bed, ${mix.stingers.length} stinger(s), ${mix.final.lufs} LUFS`);
      return mix.path;
    } catch (error) {
      if (error?.code === 'JOB_CANCELLED') throw error;
      this.logger.warn(`Audio mix failed; the quality gate will block this Short: ${error.message}`);
      productionData.assets.audio.mix = { status: 'failed', error: String(error.message || error).slice(0, 300), generatedAt: new Date().toISOString() };
      return narrationPath;
    }
  }

  async assembleVideo(productionData, options = {}) {
    this.logger.info('Assembling final AI-generated video...');
    
    try {
      const finalVideoPath = path.join(__dirname, '..', 'data', 'videos', `${productionData.id}_final.mp4`);
      const narrationReady = await this.aiVideoGenerator.isUsableAudioFile(productionData.assets.audio?.path);
      if (!narrationReady && productionData.assets.audio?.intentionalSilence !== true) {
        this.logger.warn('Final assembly is blocked until narration succeeds or the operator explicitly confirms an intentional silent video.');
        return await this.simulateVideoAssembly(productionData, 'Narration is missing');
      }

      // Fail closed when the visual plan is incomplete, so no render time is wasted on
      // a video that could never pass review.
      const videoPlan = productionData.assets.video || {};
      if (videoPlan.simulated === true || ['unavailable', 'simulation'].includes(videoPlan.generatedWith)) {
        const missingScenes = Array.isArray(videoPlan.scenePlan)
          ? videoPlan.scenePlan.filter(scene => scene.simulated || !scene.assetPath).length
          : 0;
        const reason = missingScenes
          ? `Visual coverage is incomplete (${missingScenes} scene${missingScenes === 1 ? '' : 's'} missing)`
          : 'Visual coverage is incomplete';
        this.logger.warn(`Final assembly blocked: ${reason}.`);
        return await this.simulateVideoAssembly(productionData, reason);
      }

      const audioDuration = Number(productionData.assets.audio?.measuredDuration || productionData.assets.audio?.duration) || null;
      const scenePlan = Array.isArray(videoPlan.scenePlan) ? videoPlan.scenePlan : [];
      const rawPlannedTotal = scenePlan.reduce((sum, scene) => sum + Math.max(0, Number(scene.duration) || 0), 0);
      const fallbackTotal = this.parseDurationSeconds(productionData.estimatedDuration) || rawPlannedTotal || audioDuration || 1;
      const targetDuration = audioDuration || fallbackTotal;
      const durationScale = rawPlannedTotal > 0 ? targetDuration / rawPlannedTotal : 1;
      const plannedDurationByScene = new Map(
        scenePlan.map(scene => [
          Number(scene.index),
          Math.max(2, (Number(scene.duration) || targetDuration / Math.max(1, scenePlan.length)) * durationScale)
        ])
      );
      if (Array.isArray(videoPlan.scenePlan)) {
        videoPlan.scenePlan = videoPlan.scenePlan.map(scene => ({
          ...scene,
          duration: plannedDurationByScene.get(Number(scene.index)) || Number(scene.duration) || 5
        }));
      }

      // Horror Shorts get a loudness-normalized voice over a seeded ambient bed with a
      // hook thud and a twist stab. The video is muxed from that mix; QA re-measures it.
      let muxAudioPath = productionData.assets.audio.path;
      if (productionData.strategy?.fictional === true && ambientEnabled() && productionData.assets.audio?.intentionalSilence !== true) {
        muxAudioPath = await this.buildHorrorAudioMix(productionData, videoPlan.scenePlan, options);
      }

      // Use the measured narration duration and the scene plan to build one visual
      // timeline that covers the full voice track.
      const producedPath = await this.aiVideoGenerator.generateVideo(
        productionData.script,
        productionData.assets.video.visualAssets || [],
        muxAudioPath,
        finalVideoPath,
        {
          jobId: productionData.jobId,
          productionId: productionData.id,
          estimatedDuration: targetDuration,
          // Keep each beat on screen for its own narration instead of an equal split.
          imageTimeline: productionData.strategy?.fictional === true
            ? (videoPlan.scenePlan || [])
              .filter(scene => scene.assetPath && !scene.simulated)
              .map(scene => ({ path: scene.assetPath, duration: scene.duration, role: scene.role }))
            : null,
          forceImageTimeline: productionData.strategy?.fictional === true,
          signal: options.signal
        }
      );

      // The generator falls back to a placeholder .info file when it cannot render
      if (!producedPath || path.extname(producedPath).toLowerCase() !== '.mp4') {
        return await this.simulateVideoAssembly(productionData);
      }

      if (productionData.strategy?.fictional === true) {
        await this.burnCaptionsIntoVideo(finalVideoPath, productionData.assets.captions?.path, options);
      }

      // Get file stats
      const stats = await fs.stat(finalVideoPath);
      
      let measuredFinalDuration = null;
      try {
        measuredFinalDuration = await getMediaDuration(finalVideoPath);
      } catch (error) {
        this.logger.warn(`Could not measure final video duration: ${error.message}`);
      }
      const providerEvidence = this.aiVideoGenerator.lastVideoResult || { actualProvider: 'slideshow', model: 'local-ffmpeg' };
      const finalGeneratedWith = providerEvidence.actualProvider === 'slideshow'
        ? 'local-assembly'
        : providerEvidence.actualProvider || 'local-assembly';

      productionData.assets.finalVideo = {
        path: finalVideoPath,
        fileSize: stats.size,
        duration: measuredFinalDuration || productionData.assets.audio?.measuredDuration || productionData.estimatedDuration,
        measuredDuration: measuredFinalDuration,
        generatedWith: finalGeneratedWith,
        resolution: productionData.strategy?.fictional === true ? '1080x1920' : '1920x1080',
        format: 'mp4',
        captionsBurnedIn: productionData.strategy?.fictional === true,
        provider: providerEvidence
      };
      productionData.containsSyntheticMedia = Boolean(
        productionData.assets.video?.generatedWith === 'AI' ||
        (
          this.aiVideoGenerator.lastVideoResult?.actualProvider &&
          !['slideshow', 'simulation'].includes(this.aiVideoGenerator.lastVideoResult.actualProvider)
        )
      );
      
      this.logger.info('AI video assembly complete');
      return finalVideoPath;
    } catch (error) {
      if (error?.code === 'JOB_CANCELLED') throw error;
      this.logger.error('AI video assembly failed:', error);
      // Fallback to simulation; keep the real cause so the job error can name it.
      return await this.simulateVideoAssembly(productionData, error?.message || String(error));
    }
  }

  // Fallback simulation methods
  async simulateAudioGeneration(productionData, failure = null) {
    const audioPath = path.join(__dirname, '..', 'data', 'audio', `${productionData.id}_narration.mp3`);
    
    await fs.writeFile(audioPath + '.info', JSON.stringify({
      message: 'AI TTS audio would be generated here',
      timestamp: new Date().toISOString()
    }, null, 2));
    
    productionData.assets.audio = {
      path: audioPath + '.info',
      duration: productionData.estimatedDuration,
      format: 'mp3',
      status: 'unavailable',
      simulated: true,
      provider: this.aiVideoGenerator.lastNarrationResult?.provider || 'simulation',
      model: this.aiVideoGenerator.lastNarrationResult?.model || null,
      externalTaskId: this.aiVideoGenerator.lastNarrationResult?.externalTaskId || null,
      generatedAt: this.aiVideoGenerator.lastNarrationResult?.generatedAt || new Date().toISOString(),
      cost: this.aiVideoGenerator.lastNarrationResult?.cost || { billed: false },
      error: failure?.message || this.aiVideoGenerator.lastNarrationResult?.error || 'No live narration provider is configured',
      intentionalSilence: false
    };
    
    return audioPath + '.info';
  }

  async simulateVideoAssembly(productionData, reason = null) {
    const finalVideoPath = path.join(__dirname, '..', 'data', 'videos', `${productionData.id}_final.mp4`);
    
    const assemblyInstructions = {
      message: 'AI video would be assembled here',
      blockedReason: reason,
      assets: productionData.assets,
      timestamp: new Date().toISOString()
    };
    
    await fs.writeFile(
      finalVideoPath + '.assembly.json',
      JSON.stringify(assemblyInstructions, null, 2)
    );
    
    productionData.assets.finalVideo = {
      path: finalVideoPath + '.assembly.json',
      fileSize: 0,
      duration: productionData.estimatedDuration,
      simulated: true,
      blockedReason: reason
    };
    
    return finalVideoPath + '.assembly.json';
  }
}

module.exports = { ProductionManagementAgent };
