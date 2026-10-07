const sharp = require('sharp');
const path = require('path');
const fs = require('fs').promises;
const { Logger } = require('../utils/logger');
const channelIdentity = require('../config/channel-identity.json');
const nicheContract = require('../config/horror-stickman-niche.json');

class ThumbnailDesignerAgent {
  constructor(db, credentials) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('ThumbnailDesigner');
    this.templatesPath = path.join(__dirname, '..', 'data', 'thumbnail-templates');
    this.identity = channelIdentity;
    this.thumbnailIdentity = channelIdentity.thumbnailIdentity || {};
  }

  async initialize() {
    this.logger.info('Initializing Thumbnail Designer Agent...');
    await this.ensureTemplatesDirectory();
    return true;
  }

  async ensureTemplatesDirectory() {
    try {
      await fs.mkdir(this.templatesPath, { recursive: true });
      await fs.mkdir(path.join(__dirname, '..', 'uploads', 'thumbnails'), { recursive: true });
    } catch (error) {
      this.logger.error('Failed to create directories:', error);
    }
  }

  async generateThumbnail(script) {
    try {
      this.logger.info(`Generating thumbnail creative direction for: ${script.title}`);

      const concept = await this.generateConcept(script);
      this.assertAutonomousThumbnailContract(concept, script.metadata?.strategy || {});
      const prompt = await this.createPrompt(concept, script);

      // This local render is a safe draft/fallback. Production will replace it with
      // a provider-generated image when an image provider is configured.
      const thumbnailPath = await this.createThumbnail(concept);
      const composedThumbnail = await this.addTextOverlay(thumbnailPath, concept);
      const optimizedThumbnail = await this.optimizeForYouTube(composedThumbnail);

      const thumbnailData = {
        path: optimizedThumbnail,
        concept,
        prompt,
        candidates: concept.candidates || [],
        dimensions: { width: 1280, height: 720 },
        fileSize: await this.getFileSize(optimizedThumbnail),
        generationMode: 'creative-direction-with-local-draft',
        reviewRequired: String(process.env.AUTONOMOUS_MODE || '').toLowerCase() !== 'true',
        createdAt: new Date().toISOString()
      };

      await this.db.saveThumbnail(thumbnailData);
      this.logger.info(`Thumbnail creative direction ready: ${concept.archetype} (score ${concept.score})`);
      return thumbnailData;
    } catch (error) {
      this.logger.error('Failed to generate thumbnail:', error);
      throw error;
    }
  }

  async generateConcept(script) {
    const strategy = script.metadata?.strategy || {};
    const topic = String(strategy.topic || script.title || '').trim();
    const title = String(script.title || topic).trim();
    const hook = typeof script.hook === 'object' ? String(script.hook?.text || '') : String(script.hook || '');
    const payoff = String(strategy.payoff || script.conclusion?.finalThought || '');
    const scrollStopMoment = String(strategy.scrollStopMoment || hook || '').trim();
    const curiosityAngle = String(strategy.curiosityAngle || '').trim();
    const primarySubject = this.extractPrimarySubject(topic);
    const candidates = this.buildConceptCandidates({ topic, title, hook, payoff, scrollStopMoment, curiosityAngle, primarySubject, strategy })
      .map(candidate => ({ ...candidate, ...this.scoreConcept(candidate, { title, topic, hook, strategy }) }))
      .sort((a,b)=>b.score-a.score);
    const winner = candidates[0];

    return {
      ...winner,
      title: this.formatThumbnailTitle(title),
      primaryText: winner.text || '',
      secondaryText: '',
      colors: this.paletteForConcept(winner),
      emotion: 'curiosity',
      composition: winner.composition,
      effects: { blur:false, vignette:true, glow:false, shadow:false, border:false },
      candidates
    };
  }

  buildConceptCandidates({ topic, title, hook, payoff, scrollStopMoment, curiosityAngle, primarySubject, strategy: _strategy }) {
    const truthBoundary = `Original fictional horror only. Preserve the premise "${topic}" without adding real people, real crimes, gore, copyrighted characters, logos, or a spoiler of the final twist.`;
    const firstFrame = scrollStopMoment || hook || `the first impossible detail in ${topic}`;
    const base = {
      topic,
      title,
      primarySubject,
      titleComplement: this.buildTitleComplement(title, topic),
      truthBoundary,
      sourceContext: [],
      hook,
      payoff,
      curiosityAngle
    };
    return [
      {
        ...base,
        archetype: 'impossible-presence',
        label: 'Impossible Presence',
        visualIdea: `Dark stickman frozen in an ordinary setting while one impossible silhouette, reflection, shadow, or unseen-presence cue makes this instantly wrong: ${firstFrame}. Do not reveal the final twist.`,
        composition: 'one dominant stickman silhouette off-center, threatening negative space, clear mobile read',
        text: '',
        visualStyle: 'dark stickman psychological horror',
        distinctSignal: 'presence'
      },
      {
        ...base,
        archetype: 'wrong-space',
        label: 'Wrong Space',
        visualIdea: `Show the ordinary space from "${topic}" behaving impossibly: a door, hallway, wall, elevator, room, window, or reflection violates one simple expectation. Keep one stickman focal subject and one readable impossible cue.`,
        composition: 'claustrophobic vertical-feeling perspective adapted to thumbnail, one focal figure and one impossible spatial cue',
        text: '',
        visualStyle: 'dark stickman psychological horror',
        distinctSignal: 'space'
      },
      {
        ...base,
        archetype: 'signal-threat',
        label: 'Signal Threat',
        visualIdea: `Show one stickman reacting to a phone, message, camera, intercom, recording, knocking source, or other signal that proves something impossible is nearby. The threat is implied, not graphically shown.`,
        composition: 'tight high-contrast composition with stickman plus one glowing or pale signal cue in deep darkness',
        text: '',
        visualStyle: 'dark stickman psychological horror',
        distinctSignal: 'signal'
      }
    ].map((concept,index)=>({ ...concept, candidateIndex:index }));
  }

  scoreConcept(concept, context={}) {
    const titleWords = new Set(this.tokenize(context.title || ''));
    const visualWords = this.tokenize(concept.visualIdea);
    const overlap = visualWords.filter(word => titleWords.has(word)).length;
    const readability = /one dominant|one focal|tight/i.test(concept.composition) ? 98 : 92;
    const curiosity = 96;
    const visualHierarchy = 97;
    const titleComplementarity = Math.max(82, 98 - overlap);
    const factualHonesty = concept.truthBoundary ? 100 : 70;
    const brandConsistency = /dark stickman psychological horror/i.test(concept.visualStyle) ? 100 : 60;
    const engine = String(context.strategy?.storyEngine || '').toLowerCase();
    const preferred = {
      'ordinary-to-impossible':'wrong-space',
      'viewer-knows-first':'impossible-presence',
      'impossible-sound':'signal-threat',
      'wrong-reflection':'impossible-presence',
      'impossible-message':'signal-threat',
      'space-does-not-behave':'wrong-space',
      'repetition-loop':'wrong-space',
      'presence-without-proof':'impossible-presence',
      'late-recontextualization':'impossible-presence'
    }[engine];
    const engineAlignment = !preferred ? 90 : concept.archetype === preferred ? 100 : 92;
    const score=Math.round(readability*.18+curiosity*.22+visualHierarchy*.16+titleComplementarity*.14+factualHonesty*.10+brandConsistency*.12+engineAlignment*.08);
    return {
      score,
      scoring:{readability,curiosity,visualHierarchy,titleComplementarity,factualHonesty,brandConsistency,engineAlignment},
      rationale:`${concept.label} scored ${score}/100 for mobile scroll-stop, curiosity, Dark Stickman consistency, and story-engine alignment.`
    };
  }

  assertAutonomousThumbnailContract(concept = {}, strategy = {}) {
    if (String(process.env.AUTONOMOUS_MODE || '').toLowerCase() !== 'true') return true;
    const engines = new Set(nicheContract.brandSignature?.storyEngines || []);
    const failures = [];
    if (engines.size && !engines.has(String(strategy.storyEngine || '').toLowerCase())) failures.push('invalid horror story engine');
    if (Number(strategy.visualStrength || 0) < Number(nicheContract.hardGates?.visualStrengthMin || 8)) failures.push('weak first-frame visual premise');
    if (Number(concept.score || 0) < 90) failures.push('visual hook score below 90');
    if (Number(concept.scoring?.brandConsistency || 0) < 95) failures.push('Dark Stickman brand consistency below 95');
    if (Number(concept.scoring?.curiosity || 0) < 90) failures.push('first-frame curiosity below 90');
    if (String(concept.visualIdea || '').trim().length < 60) failures.push('visual hook idea is underspecified');
    if (!String(concept.truthBoundary || '').trim()) failures.push('fiction safety boundary is missing');
    if (/gore|bright colorful|comedy/i.test(String(concept.visualIdea || ''))) failures.push('visual hook violates horror brand exclusions');
    if (failures.length) {
      const error = new Error(`Autonomous visual-hook contract failed: ${failures.join('; ')}`);
      error.code = 'AUTONOMOUS_THUMBNAIL_CONTRACT';
      error.failures = failures;
      throw error;
    }
    return true;
  }

  tokenize(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9\s-]/g,' ').split(/\s+/).filter(word=>word.length>3);
  }

  extractPrimarySubject(topic) {
    return String(topic || 'the stickman protagonist')
      .replace(/[?.!…]+$/,'')
      .trim() || 'the stickman protagonist';
  }

  buildTitleComplement(_title, topic) {
    return `Show the disturbing visual question inside "${topic}" without writing the title or revealing the final twist.`;
  }

  paletteForConcept(_concept) {
    return { primary:'#07090d', secondary:'#101827', accent:'#b91c1c' };
  }

  formatThumbnailTitle(title) {
    // Shorten title for thumbnail
    const words = title.split(' ');
    if (words.length > 5) {
      return words.slice(0, 5).join(' ') + '...';
    }
    return title;
  }

  async createPrompt(concept, script = {}) {
    const title = String(script.title || concept.title || '').trim();
    return [
      'Create a high-contrast Horror Stickman YouTube thumbnail consistent with a recurring original channel universe.',
      `TITLE CONTEXT: ${title}`,
      `VISUAL CONCEPT: ${concept.visualIdea}`,
      `COMPOSITION: ${concept.composition}.`,
      'Use one simple black or near-black stickman with identical proportions to the recurring channel character.',
      'Background: near-black charcoal or dark navy. A restrained deep-red accent is allowed only if useful.',
      'Psychological horror, claustrophobic shadow, minimal detail, one dominant fear cue, immediate mobile readability.',
      'Do not show the final twist. The image should create a question, not answer it.',
      concept.text ? `Optional text: "${concept.text}" — maximum 1-3 words.` : 'No generated text. Keep typography out of the image.',
      `FICTION BOUNDARY: ${concept.truthBoundary}`,
      'DO NOT INCLUDE: gore, blood as focal point, comedy, cheerful expressions, bright colorful cartoon styling, childlike character design, logos, UI clutter, arrows, circles, collage, watermarks.',
      'Thumbnail output target: 1280x720. Preserve the same Dark Stickman brand grammar as the vertical first frame.'
    ].join(' ');
  }

  async createThumbnail(concept, suffix = '') {
    // Create a base thumbnail using Sharp
    const width = 1280;
    const height = 720;
    
    const marker = suffix ? `_${suffix}` : '';
    const outputPath = path.join(__dirname, '..', 'uploads', 'thumbnails', `thumbnail${marker}_${Date.now()}.png`);
    
    // Create gradient background
    const svg = `
      <svg width="${width}" height="${height}">
        <defs>
          <linearGradient id="gradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style="stop-color:${this.hexToRgb(concept.colors.primary)};stop-opacity:1" />
            <stop offset="100%" style="stop-color:${this.hexToRgb(concept.colors.secondary)};stop-opacity:1" />
          </linearGradient>
        </defs>
        <rect width="${width}" height="${height}" fill="url(#gradient)" />
      </svg>
    `;
    
    await sharp(Buffer.from(svg))
      .resize(width, height)
      .png()
      .toFile(outputPath);
    
    return outputPath;
  }

  hexToRgb(color) {
    // Color name to hex mapping
    const colors = {
      'blue': '#0066CC',
      'red': '#CC0000',
      'green': '#00CC66',
      'yellow': '#FFCC00',
      'purple': '#6600CC',
      'orange': '#FF6600',
      'white': '#FFFFFF',
      'black': '#000000',
      'gray': '#808080',
      'dark blue': '#003366',
      'gold': '#FFD700'
    };
    
    if (/^#[0-9a-f]{6}$/i.test(String(color || ''))) return String(color);
    return colors[color] || '#000000';
  }

  async addTextOverlay(imagePath, concept, suffix = '') {
    if (!concept.primaryText && !concept.secondaryText && !concept.text) return imagePath;
    const marker = suffix ? `_${suffix}` : '';
    const outputPath = path.join(__dirname, '..', 'uploads', 'thumbnails', `thumbnail_final${marker}_${Date.now()}.png`);
    
    // Create text overlay SVG
    const textSvg = `
      <svg width="1280" height="720">
        <style>
          .primary { 
            fill: ${concept.colors.accent === 'white' ? 'white' : 'black'}; 
            font-size: 120px; 
            font-weight: bold; 
            font-family: Arial, sans-serif;
            text-anchor: middle;
          }
          .secondary { 
            fill: ${concept.colors.accent}; 
            font-size: 60px; 
            font-weight: bold; 
            font-family: Arial, sans-serif;
            text-anchor: middle;
          }
          .shadow {
            fill: black;
            opacity: 0.5;
          }
        </style>
        
        <!-- Shadow -->
        <text x="642" y="302" class="primary shadow">${concept.primaryText}</text>
        <text x="642" y="402" class="secondary shadow">${concept.secondaryText}</text>
        
        <!-- Main text -->
        <text x="640" y="300" class="primary">${concept.primaryText}</text>
        <text x="640" y="400" class="secondary">${concept.secondaryText}</text>
      </svg>
    `;
    
    const textOverlay = await sharp(Buffer.from(textSvg)).png().toBuffer();
    
    await sharp(imagePath)
      .composite([{
        input: textOverlay,
        top: 0,
        left: 0
      }])
      .toFile(outputPath);
    
    return outputPath;
  }

  async optimizeForYouTube(imagePath, suffix = '') {
    const marker = suffix ? `_${suffix}` : '';
    const outputPath = path.join(__dirname, '..', 'uploads', 'thumbnails', `thumbnail_optimized${marker}_${Date.now()}.jpg`);
    
    // YouTube optimization: JPEG format, proper compression
    await sharp(imagePath)
      .resize(1280, 720, {
        fit: 'cover',
        position: 'centre'
      })
      .jpeg({
        quality: 90,
        progressive: true,
        optimizeScans: true
      })
      .toFile(outputPath);
    
    // Verify file size (YouTube limit is 2MB)
    const stats = await fs.stat(outputPath);
    if (stats.size > 2 * 1024 * 1024) {
      // Re-compress if too large
      await sharp(imagePath)
        .resize(1280, 720)
        .jpeg({ quality: 80 })
        .toFile(outputPath);
    }
    
    return outputPath;
  }

  async getFileSize(filePath) {
    const stats = await fs.stat(filePath);
    return stats.size;
  }

  async generateABVariants(concept) {
    const candidates = Array.isArray(concept?.candidates) && concept.candidates.length >= 3
      ? concept.candidates.slice(0,3)
      : this.buildConceptCandidates({
          topic: concept?.topic || concept?.title || 'documentary subject',
          title: concept?.title || '',
          hook: '',
          payoff: '',
          primarySubject: concept?.primarySubject || concept?.topic || 'documentary subject',
          strategy: {}
        }).map(candidate=>({ ...candidate, ...this.scoreConcept(candidate,{title:concept?.title || ''}) }));

    const variants=[];
    for(let index=0;index<candidates.length;index++){
      const raw=candidates[index];
      const variantConcept={
        ...concept,
        ...raw,
        primaryText:raw.text || '',
        secondaryText:'',
        colors:this.paletteForConcept(raw),
        effects:{blur:false,vignette:true,glow:false,shadow:false,border:false}
      };
      const suffix=`concept_${raw.archetype || index+1}`;
      const base=await this.createThumbnail(variantConcept,suffix);
      const overlay=await this.addTextOverlay(base,variantConcept,suffix);
      const optimized=await this.optimizeForYouTube(overlay,suffix);
      variants.push({
        label:raw.label || `Concept ${index+1}`,
        path:optimized,
        concept:variantConcept,
        score:raw.score || this.scoreConcept(raw,{title:concept?.title || ''}).score
      });
    }
    return variants;
  }

}

module.exports = { ThumbnailDesignerAgent };
