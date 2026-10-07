const { Logger } = require('../utils/logger');
const { AITextService } = require('../utils/ai-text-service');
const channelIdentity = require('../config/channel-identity.json');
const nicheContract = require('../config/horror-stickman-niche.json');
const { beatBalanceIssues, maxBeatWordShare } = require('../utils/beat-balance');
const { parseJsonResponse } = require('../utils/json-response');
const storyStructures = require('../config/story-structures.json');
const { editorRubricForWriter } = require('../utils/creative-review');

function structureBrief(id) {
  const found = (storyStructures.structures || []).find(item => item.id === String(id || '').toLowerCase());
  return found ? `${found.name}. ${found.shape} ${found.twist}` : 'tell it as one person, one ordinary task, one wrong detail that gets worse, one ending that changes what the first line meant';
}

// Two original examples of the target quality (shape, rhythm, voice). They show HOW to write; the writer must not reuse their content.
const QUALITY_EXAMPLES = `QUALITY EXAMPLES (study the rhythm, the person, the choice and the ending; never reuse their story, objects or words)
Example A (115 words, "the rule" shape). Hook: The handbook had one rule about phone three. Beats: 1. Never answer it. My manager circled the line in red and would not say why. 2. On Thursday it rang at two in the morning. I let it ring until my ears hurt. 3. Then it stopped, and the desk phone beside me lit up. The screen showed my own extension. 4. I told myself it was a fault. I picked up anyway, because nobody else was there to stop me. 5. A calm voice said, you are late for your shift. I looked at the clock, then at the camera above the door. 6. On the monitor, I was already sitting at this desk, with the phone at my ear, nodding.
Example B (110 words, "the detail that does not fit" shape). Hook: My roommate has not blinked in three weeks. Beats: 1. I noticed at dinner. He watched the television and his eyes never closed. 2. I told myself he was tired. Then I counted. Ten minutes, and not once. 3. That night I sat on the stairs outside his door. He was not sleeping. I could hear him counting. 4. Slowly, in a whisper, he counted to ten, again and again. Then he stopped and said my name. 5. I did not answer. In the morning he made coffee and asked why I looked so tired. 6. I ran for the front door. Every window across the street was lit, and every neighbour stood watching our house. None of them blinked.`;

class ScriptWriterAgent {
  constructor(db, credentials) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('ScriptWriter');
    this.templates = this.loadTemplates();
    this.aiTextService = new AITextService(credentials?.credentials || credentials || {});
    this.identity = channelIdentity;
  }

  async initialize() {
    this.logger.info('Initializing Script Writer Agent...');
    return true;
  }

  loadTemplates() {
    return {
      tutorial: {
        structure: ['hook', 'introduction', 'problem', 'solution_steps', 'demonstration', 'recap', 'cta'],
        tone: 'educational',
        pacing: 'moderate'
      },
      explainer: {
        structure: ['hook', 'context', 'mechanism', 'escalation', 'turning_point', 'payoff', 'implications', 'cta'],
        tone: 'cinematic, precise, and curious',
        pacing: 'progressive'
      },
      list: {
        structure: ['hook', 'introduction', 'list_items', 'bonus_item', 'summary', 'cta'],
        tone: 'engaging',
        pacing: 'quick'
      },
      review: {
        structure: ['hook', 'introduction', 'overview', 'pros', 'cons', 'comparison', 'verdict', 'cta'],
        tone: 'analytical',
        pacing: 'detailed'
      },
      story: {
        structure: ['hook', 'setup', 'conflict', 'mechanism', 'escalation', 'turning_point', 'payoff', 'cta'],
        tone: 'dark restrained psychological horror narration',
        pacing: 'fast tension build with controlled escalation'
      }
    };
  }

  async generateScript(strategy, options = {}) {
    try {
      this.logger.info(`Generating script for: ${strategy.topic}`);
      const template = this.templates[strategy.contentType.toLowerCase()] || this.templates.explainer;
      const script = await this.generateScriptWithAI(strategy, template, options);
      if (!script) {
        const error = new Error('The live script provider returned no production script');
        error.code = 'SCRIPT_PROVIDER_EMPTY';
        throw error;
      }
      script.fullScript = this.formatFullScript(script);
      await this.db.saveScript(script);
      this.logger.info(`Production script generated: ${script.title}`);
      return script;
    } catch (error) {
      this.logger.error('Failed to generate production script:', error);
      throw error;
    }
  }

  async generateScriptWithAI(strategy, _template, options = {}) {
    if (!this.aiTextService.isAvailable()) {
      return this.buildDeterministicHorrorFallback(
        strategy,
        'No live AI text provider is available for Horror Stickman script generation'
      );
    }

    const wordRange = this.targetNarrationWordRange(strategy);
    const targetWords = 115;
    const prompt = `You are the Script Writer Agent of the Horror Stickman channel.
Your only objective is to write an original 20-45 second psychological horror Short with exceptional retention.
Follow these rules strictly.

BRAND
- Dark Stickman visual universe.
- Deep, restrained, low-tone narration.
- Psychological unease over gore.
- No comedy, bright tone, childlike language, fake true-story framing, real-person accusations, or copyrighted horror characters.

APPROVED STRATEGY
Premise: ${strategy.topic}
Hook concept: ${strategy.hook || ''}
Everyday anchor: ${strategy.everydayAnchor || ''}
Fear mechanism: ${strategy.fearMechanism || strategy.curiosityAngle || ''}
Escalation: ${JSON.stringify(strategy.escalationLadder || [])}
Twist/payoff: ${strategy.payoff || ''}
Visual beats: ${JSON.stringify(strategy.visualVariety || [])}
Story engine: ${strategy.storyEngine || ''}
Story structure: ${structureBrief(strategy.storyStructure)}
Audience: ${strategy.targetAudience || this.identity.audience}

HARD SCRIPT CONTRACT
- 90-140 spoken words total; aim for about ${targetWords}.
- Hook is the first 5-12 spoken words and must land in the first 1-1.5 seconds.
- 4-7 story beats total.
- Keep the beats evenly sized: no single beat may carry more than ${Math.round(maxBeatWordShare() * 100)}% of all spoken words (the hook counts toward beat 1), because each beat is one on-screen image and must not stay up too long.
- Build tension immediately; no greeting, explanation, lore dump, or generic setup.
- Escalate at least twice.
- Preserve the approved central premise and twist boundary.
- The final beat must deliver the approved twist/climax or a disturbing unresolved image.
- Use short, natural spoken English.
- Every beat must create a visibly different Dark Stickman state.
- No graphic gore. No jokes. No “you won’t believe”. No fake urgency.
- “Follow for more” is optional, never mandatory.
- Do not invent factual claims. This is original fiction, so claims must be [].
- Do not label the story “true”, “real”, or “based on a true story”.

NARRATOR AND VOICE
- One narrator, always the same: calm, low, slow, close to the listener. No character voices.
- Write for the ear, because one text-to-speech voice reads every character: no quoted dialogue (report what was said inside the narration), no abbreviations, no digits or symbols (write the time as words), no ALL CAPS, no ellipses, no parentheses, no emoji, no stage directions or sound cues inside the narration.
- Use full stops for pauses. Tension rises through shorter sentences, never through exclamation marks.
- The hook is spoken exactly once. Beat 1 continues after the hook and must NOT repeat or paraphrase it.
- Concrete over abstract: name the object, the sound, the number, the place in the room. Avoid emotion adjectives such as terrifying or creepy; say what the person sees and hears.
- Never open with "In this video", "Have you ever" or "Today", and never end with "thanks for watching".

VISUAL BEATS
- Each beat shows ONE clear action by the same stickman (turn, step, reach, open, hold, recoil) in one place, with one prop or detail that matters (door, phone, mirror, lamp, window).
- Show the moment before the event or its aftermath at a distance. Never depict injury, blood, or a person being harmed; a closed door, an empty chair, a stopped clock or a shadow stands in for it.
- A beat must look different from its neighbours (different place, distance or pose).
- No real people, brands, logos, or real places tied to a crime. Sounds inside the story are diegetic only (footsteps, a knock, wind, room tone, a phone buzz); never mention music.

${editorRubricForWriter()}

${QUALITY_EXAMPLES}

Before returning, evaluate hook strength, tension, twist, originality, and brand consistency. If any is weak, revise internally. Return scores only, not private chain-of-thought.

Return ONLY valid JSON:
{
  "title":"specific curiosity+fear title under 100 characters",
  "hook":"5-12 word spoken opening",
  "sections":[
    {
      "title":"Beat label",
      "content":["spoken narration for this beat"],
      "duration":6,
      "visualQuery":"specific vertical Dark Stickman scene: one action, one place, one prop",
      "visualRequiredAny":["stickman","specific object/location cue"],
      "visualForbiddenAny":["bright","comedy","gore","childlike cartoon"]
    }
  ],
  "cta":"",
  "claims":[],
  "scores":{"hook":1,"tension":1,"twist":1,"originality":1,"brand":1}
}`;

    let lastError = null;
    let lastCount = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const repair = attempt === 1 ? '' : `
REPAIR PASS ${attempt - 1}:
The previous candidate ${lastCount ? `had ${lastCount} spoken words` : 'failed one or more hard gates'}.
${lastError?.message ? `Specific problems to fix: ${String(lastError.message).slice(0, 700)}\n` : ''}Rewrite the complete JSON. Keep the approved premise and twist. Aim for 105-125 spoken words, strengthen the first line, remove exposition, and make each of 4-7 beats visually distinct. Do not add filler.`;
        const editorBrief = options.revisionBrief
          ? `\nEDITOR REVISION BRIEF (a skeptical editor rejected the previous draft; fix every point):\n${options.revisionBrief}\n`
          : '';
        const response = await this.aiTextService.generateText(prompt + editorBrief + repair, {
          task: 'script',
          maxTokens: 2200,
          temperature: attempt === 1 ? 0.82 : 0.68,
          responseMimeType: 'application/json',
          // The first draft broke a hard gate: ask a different provider for the repair instead of the same one.
          skipPrimary: attempt > 1
        });
        const parsed = this.parseAIJsonResponse(response);
        const hookObject = this.normalizeAIHook(parsed.hook);
        // The model often repeats the hook as the first words of beat 1 although the prompt forbids it; the
        // hook is spoken once, so remove the echo here instead of paying a rewrite for it.
        const sections = this.stripHookEcho(hookObject.text, this.normalizeAISections(parsed.sections, strategy));
        if (!parsed.title || !parsed.hook || sections.length < 4) {
          throw new Error('AI horror script response missing required fields');
        }
        const candidate = {
          title: String(parsed.title).trim().slice(0, 100),
          hook: hookObject,
          introduction: { type: 'none', greeting: '', topicIntro: '', valueProposition: '', credibility: '', duration: '0 seconds' },
          mainContent: { sections },
          conclusion: { type: 'none', recap: [], finalThought: '', duration: '0 seconds' },
          callToAction: this.normalizeAICTA(parsed.cta),
          keywords: strategy.keywords || [],
          claims: [],
          metadata: {
            strategy,
            fictional: true,
            scores: parsed.scores || {},
            generatedAt: new Date().toISOString(),
            version: '2.0-horror-shorts',
            generationSource: 'ai'
          }
        };
        candidate.fullScript = this.formatFullScript(candidate);
        candidate.metadata.spokenWordCount = this.countSpokenWords(candidate);
        lastCount = candidate.metadata.spokenWordCount;
        const issues = this.scriptContractIssues(candidate);
        if (!issues.length && lastCount >= wordRange.min && lastCount <= wordRange.max) {
          this.logger.info(`Using Horror Stickman script via ${this.aiTextService.providerName} (${lastCount} spoken words)`);
          return candidate;
        }
        lastError = new Error(issues.join('; ') || `spoken words ${lastCount} outside ${wordRange.min}-${wordRange.max}`);
      } catch (error) {
        lastError = error;
      }
    }
    try {
      return this.buildDeterministicHorrorFallback(
        strategy,
        lastError?.message || 'all bounded AI script attempts failed'
      );
    } catch (fallbackError) {
      const error = new Error(
        `Horror Stickman script failed after bounded repair and deterministic fallback: ${fallbackError.message}`
      );
      error.code = 'AUTONOMOUS_SCRIPT_CONTRACT';
      throw error;
    }
  }

  buildDeterministicHorrorFallback(strategy, reason = 'provider fallback') {
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const clipWords = (value, maxWords) => clean(value)
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, maxWords)
      .join(' ')
      .replace(/[,:;—-]+$/g, '');
    const sentence = value => {
      const text = clean(value).replace(/[.!?]+$/g, '');
      if (!text) return '';
      return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
    };

    let hookText = clipWords(strategy.hook || strategy.topic, 12);
    let hookWords = hookText.split(/\s+/).filter(Boolean).length;
    if (hookWords < 5) {
      hookText = clipWords(`Something was wrong with ${strategy.everydayAnchor || strategy.topic}`, 12);
      hookWords = hookText.split(/\s+/).filter(Boolean).length;
    }
    if (hookWords < 5) hookText = 'Something inside the room was already waiting';
    hookText = sentence(hookText);

    const beats = (Array.isArray(strategy.visualVariety) ? strategy.visualVariety : [])
      .map(clean).filter(Boolean).slice(0, 7);
    const escalations = (Array.isArray(strategy.escalationLadder) ? strategy.escalationLadder : [])
      .map(clean).filter(Boolean).slice(0, 3);

    const setup = sentence(clipWords(strategy.everydayAnchor || strategy.topic, 10));
    const mechanism = sentence(`Then ${clipWords(strategy.fearMechanism || strategy.curiosityAngle || 'one impossible detail reacted to them', 10)}`);
    const escalationOne = sentence(clipWords(escalations[0] || beats[1] || 'the anomaly repeated when they moved again', 13));
    const escalationTwo = sentence(clipWords(escalations[1] || beats[2] || 'the impossible detail moved closer', 13));
    const recognition = sentence(clipWords(beats[Math.max(0, beats.length - 2)] || strategy.curiosityAngle || strategy.fearMechanism, 12));
    const payoff = sentence(clipWords(strategy.payoff || 'the final image revealed the threat was already inside the safe space', 18));

    const sectionTexts = [
      `${setup} ${mechanism}`.trim(),
      `${escalationOne} The pattern did not stop when they froze.`.trim(),
      `${escalationTwo} Now the safe distance between them and it was gone.`.trim(),
      `${recognition} The detail from the opening suddenly looked deliberate.`.trim(),
      `${payoff} The last frame held on the impossible detail.`.trim()
    ];

    const visualDefaults = [
      strategy.everydayAnchor || strategy.topic,
      beats[1] || escalations[0] || strategy.fearMechanism,
      beats[2] || escalations[1] || strategy.curiosityAngle,
      beats[Math.max(0, beats.length - 2)] || strategy.fearMechanism,
      beats[beats.length - 1] || strategy.payoff
    ];

    const sections = sectionTexts.map((content, index) => ({
      type: 'horror_beat',
      title: ['Setup', 'First Escalation', 'Closer', 'Recognition', 'Twist'][index],
      content: [content],
      duration: 7,
      visualQuery: clipWords(
        `${visualDefaults[index] || strategy.topic}, same recurring adult dark stickman, vertical 9:16 psychological horror`,
        20
      ).slice(0, 140),
      visualRequiredAny: ['stickman', 'dark environment'],
      visualForbiddenAny: ['bright', 'comedy', 'gore', 'childlike cartoon']
    }));

    const candidate = {
      title: clipWords(strategy.idea || strategy.topic || 'Dark Stickman Horror', 12).slice(0, 100),
      hook: this.normalizeAIHook(hookText),
      introduction: { type: 'none', greeting: '', topicIntro: '', valueProposition: '', credibility: '', duration: '0 seconds' },
      mainContent: { sections },
      conclusion: { type: 'none', recap: [], finalThought: '', duration: '0 seconds' },
      callToAction: this.normalizeAICTA(''),
      keywords: strategy.keywords || ['horror', 'scary story', 'stickman horror'],
      claims: [],
      metadata: {
        strategy,
        fictional: true,
        generatedAt: new Date().toISOString(),
        version: '2.0-horror-shorts',
        generationSource: 'deterministic-fallback',
        fallbackReason: clean(reason).slice(0, 500)
      }
    };

    const reserveLines = [
      'They stopped moving, but the impossible detail reacted anyway.',
      'Nothing else changed, which made the pattern impossible to dismiss.',
      'They backed away, and the same warning appeared closer than before.',
      'For a second everything looked normal, then the wrong detail returned.',
      'The silence after it changed felt more threatening than the sound.'
    ];
    let reserveIndex = 0;
    candidate.metadata.spokenWordCount = this.countSpokenWords(candidate);
    while (candidate.metadata.spokenWordCount < 95 && reserveIndex < reserveLines.length) {
      // Feed the lightest beat (the hook counts toward beat 1) so the fallback stays balanced.
      const load = candidate.mainContent.sections.map((section, i) =>
        String((i === 0 ? `${hookText} ` : '') + section.content.join(' ')).split(/\s+/).filter(Boolean).length);
      const sectionIndex = 1 + load.slice(1).indexOf(Math.min(...load.slice(1)));
      candidate.mainContent.sections[sectionIndex].content[0] += ` ${reserveLines[reserveIndex]}`;
      reserveIndex += 1;
      candidate.metadata.spokenWordCount = this.countSpokenWords(candidate);
    }

    candidate.fullScript = this.formatFullScript(candidate);
    const issues = this.scriptContractIssues(candidate);
    const range = this.targetNarrationWordRange(strategy);
    if (
      issues.length ||
      candidate.metadata.spokenWordCount < range.min ||
      candidate.metadata.spokenWordCount > range.max
    ) {
      throw new Error(
        `deterministic fallback failed the same script contract: ${issues.join('; ') || `${candidate.metadata.spokenWordCount} spoken words`}`
      );
    }

    this.logger?.warn?.(
      `Using deterministic Horror Stickman script fallback (${candidate.metadata.spokenWordCount} spoken words): ${clean(reason).slice(0, 180)}`
    );
    return candidate;
  }

  targetNarrationWordRange(_strategy = {}) {
    return { min: 90, max: 140 };
  }

  countSpokenWords(script = {}) {
    const text = [
      script.hook?.text || script.hook,
      script.introduction?.topicIntro,
      script.introduction?.valueProposition,
      ...(script.mainContent?.sections || []).flatMap(section =>
        Array.isArray(section.content) ? section.content : [section.content]
      ),
      ...(Array.isArray(script.conclusion?.recap) ? script.conclusion.recap : []),
      script.conclusion?.finalThought,
      script.callToAction?.subscribe || script.callToAction?.text
    ].filter(Boolean).join(' ');
    return text.split(/\s+/).filter(Boolean).length;
  }

  parseAIJsonResponse(response) {
    return parseJsonResponse(response);
  }

  /** Remove the hook when beat 1 starts by repeating it word for word. Leaves the beat alone if nothing would remain. */
  stripHookEcho(hookText, sections) {
    const tokens = String(hookText || '').toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
    if (tokens.length < 3 || !Array.isArray(sections) || !sections.length) return sections;
    const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^[^\\p{L}\\p{N}']*${tokens.map(escape).join("[^\\p{L}\\p{N}']+")}[^\\p{L}\\p{N}']*`, 'iu');
    const first = sections[0];
    const lines = Array.isArray(first.content) ? [...first.content] : [];
    if (!lines.length || !pattern.test(lines[0])) return sections;
    const rest = lines[0].replace(pattern, '').trim();
    const content = rest ? [rest, ...lines.slice(1)] : lines.slice(1);
    if (!content.length) return sections;
    const wordCount = content.join(' ').split(/\s+/).filter(Boolean).length;
    return [{ ...first, content, duration: Math.max(2, Math.min(first.duration, Math.ceil(wordCount / 2.7))) }, ...sections.slice(1)];
  }

  normalizeAIHook(hook) {
    const text = typeof hook === 'object' && hook !== null ? hook.text : hook;
    return {
      type: 'horror_hook',
      text: String(text || '').trim().replace(/\s+/g, ' '),
      duration: '0:00-0:02'
    };
  }

  normalizeAISections(sections, strategy) {
    if (!Array.isArray(sections)) return [];
    return sections
      .slice(0, 7)
      .map((section, index) => {
        const rawContent = Array.isArray(section.content)
          ? section.content
          : [section.content || section.summary || section.description];
        const content = rawContent.map(value => String(value || '').trim()).filter(Boolean);
        const wordCount = content.join(' ').split(/\s+/).filter(Boolean).length;
        const spokenDuration = Math.max(2, Math.ceil(wordCount / 2.7));
        const required = Array.isArray(section.visualRequiredAny)
          ? section.visualRequiredAny.map(v => String(v).trim()).filter(Boolean).slice(0, 6)
          : ['stickman'];
        if (!required.some(v => /stickman/i.test(v))) required.unshift('stickman');
        const forbidden = Array.isArray(section.visualForbiddenAny)
          ? section.visualForbiddenAny.map(v => String(v).trim()).filter(Boolean).slice(0, 8)
          : [];
        for (const token of ['bright', 'comedy', 'gore', 'childlike cartoon']) {
          if (!forbidden.some(v => v.toLowerCase() === token)) forbidden.push(token);
        }
        return {
          type: 'horror_beat',
          title: String(section.title || `Beat ${index + 1}`).trim().slice(0, 120),
          content,
          duration: Math.max(2, Math.min(10, Number(section.duration) || spokenDuration)),
          visualQuery: String(section.visualQuery || `${strategy.topic}, dark stickman horror beat ${index + 1}`)
            .replace(/\s+/g, ' ').trim().slice(0, 140),
          visualRequiredAny: required,
          visualForbiddenAny: forbidden
        };
      })
      .filter(section => section.content.length > 0);
  }

  scriptContractIssues(script = {}) {
    const issues = [];
    const hookText = String(script.hook?.text || script.hook || '').trim();
    const hookWords = hookText.split(/\s+/).filter(Boolean).length;
    if (hookWords < 5 || hookWords > 12) issues.push(`hook must be 5-12 spoken words, got ${hookWords}`);
    if (/^(welcome|today we|in this video|have you ever wondered|imagine if|let's|we're going to)/i.test(hookText)) {
      issues.push('hook starts with generic setup instead of immediate horror');
    }

    const strategy = script.metadata?.strategy || {};
    const gates = nicheContract.hardGates || {};
    const numericChecks = [
      ['nicheFit', gates.nicheFitMin],
      ['visualStrength', gates.visualStrengthMin],
      ['curiosityGap', gates.curiosityGapMin],
      ['visualVarietyScore', gates.visualVarietyMin],
      ['retentionPotential', gates.retentionPotentialMin],
      ['originalityScore', gates.originalityMin],
      ['brandFit', gates.brandFitMin]
    ].filter(([, min]) => Number.isFinite(Number(min)));
    for (const [field, min] of numericChecks) {
      if (!Number.isFinite(Number(strategy[field])) || Number(strategy[field]) < Number(min)) {
        issues.push(`strategy lost Horror Stickman ${field} gate before scripting`);
      }
    }

    const engines = new Set(nicheContract.brandSignature?.storyEngines || []);
    if (engines.size && !engines.has(String(strategy.storyEngine || '').toLowerCase())) {
      issues.push('strategy has no valid Horror Stickman story engine');
    }
    if (String(strategy.payoff || '').trim().length < 16) issues.push('approved twist/payoff is too weak');

    const sections = script.mainContent?.sections || [];
    if (sections.length < 4 || sections.length > 7) issues.push(`script must contain 4-7 visual beats, got ${sections.length}`);
    const wordCount = this.countSpokenWords(script);
    if (wordCount < 90 || wordCount > 140) issues.push(`script must contain 90-140 spoken words, got ${wordCount}`);
    issues.push(...beatBalanceIssues(script));

    const visualQueries = sections.map(section => String(section.visualQuery || '').toLowerCase().trim()).filter(Boolean);
    if (new Set(visualQueries).size < Math.min(4, sections.length)) issues.push('visual beats are too repetitive');
    const concrete = sections.filter(section =>
      String(section.visualQuery || '').length >= 20 &&
      Array.isArray(section.visualRequiredAny) &&
      section.visualRequiredAny.some(value => /stickman/i.test(String(value)))
    );
    if (concrete.length < Math.min(4, sections.length)) issues.push('at least four beats need concrete Dark Stickman visual prompts');

    const joined = [hookText, ...sections.flatMap(section => section.content || [])].join(' ');
    if (/\b(you won['’]?t believe|shocking truth|true story|based on a true story|welcome back)\b/i.test(joined)) {
      issues.push('script contains banned generic/fake-true-story language');
    }
    if (/\b(dismember|decapitat|entrails|guts spilling|graphic gore)\b/i.test(joined)) {
      issues.push('script depends on graphic gore');
    }
    if ((script.claims || []).length) issues.push('original fiction must not declare factual provenance claims');

    const scores = script.metadata?.scores || {};
    for (const key of ['hook','tension','twist','originality','brand']) {
      if (scores[key] !== undefined && Number(scores[key]) < 8) issues.push(`${key} self-score below 8/10`);
    }
    return issues;
  }

  normalizeAICTA(cta) {
    const text = typeof cta === 'object' && cta !== null ? (cta.text || cta.subscribe || '') : cta;
    const cleaned = String(text || '').trim().replace(/\s+/g, ' ');
    return {
      type: 'call_to_action',
      subscribe: cleaned,
      like: '',
      comment: '',
      nextVideo: '',
      duration: cleaned ? '2 seconds' : '0 seconds'
    };
  }

  formatFullScript(script) {
    return [
      script.hook?.text || script.hook,
      ...(script.mainContent?.sections || []).flatMap(section =>
        Array.isArray(section.content) ? section.content : [section.content]
      ),
      script.callToAction?.subscribe || script.callToAction?.text
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

}

module.exports = { ScriptWriterAgent };
