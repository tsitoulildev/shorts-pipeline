// Writer: a beat that still fails after two rewrites is skipped and the WHOLE script is reviewed again without it (verifier and pictures included; at least 4 beats stay);
// a full-script reply cut off by the token limit is asked for a third time; the prompts carry the source-fidelity rules. No gate changes.
const assert = require('assert');
delete process.env.MISTRAL_API_KEY; // the tests must never reach a real vision provider, whatever .env says
const { fixtureHttp } = require('./dark-history-probe');
const { planFootage } = require('../utils/dark-history/footage');
const { attributionText } = require('../utils/dark-history/attribution');
const { sentencesOf } = require('../utils/dark-history/fact-check');
const { writeGroundedScript, buildPrompt, buildBeatPrompt, parseBeatReply, supportedTitle } = require('../utils/dark-history/grounded-writer');

const words = s => s.split(/\s+/).length;
const quiet = { info() {}, warn() {} };

(async () => {
  const plan = await planFootage('Mary Celeste', { http: fixtureHttp });
  const story = { article_url: plan.article.url, plan: { title: plan.article.title, extract: plan.article.extract, beats: plan.beats }, attribution: attributionText(plan.article, plan.beats) };
  const faithful = story.plan.beats.map(beat => {
    const sentence = sentencesOf(beat.text).filter(s => words(s) >= 12 && !/[;–—]/.test(s)).sort((a, b) => words(a) - words(b))[0];
    return { narration: sentence, evidence: [sentence] };
  });
  assert.ok(faithful.length >= 6, 'the recorded story has enough beats');
  const draftJson = beats => JSON.stringify({ title: 'The Ship Found Empty', beats: beats.map(b => ({ ...b })) });
  const judgeCalls = [];
  const imageFit = { judge: async ({ prompt }) => { judgeCalls.push(prompt); return JSON.stringify({ mismatch: [] }); }, readImage: async () => ({ mimeType: 'image/jpeg', data: 'AAAA' }) };

  // ---- 1. a beat that always fails: rewritten twice, then skipped; the final review sees the script without it ----
  const bad = faithful[2].narration;
  const marker = bad.slice(0, 40); // the fake verifier flags any text of this beat, however the writer rewords it
  const verifierPrompts = [];
  let beatRewrites = 0;
  let fullWrites = 0;
  const stubborn = {
    generateText: async prompt => {
      if (/strict fact-checker/.test(prompt)) {
        verifierPrompts.push(prompt);
        return JSON.stringify({ unsupported: prompt.includes(marker) ? ['3.1'] : [] });
      }
      if (/fixing single beats/.test(prompt)) { beatRewrites += 1; const worded = bad + ' ' + ['Indeed.', 'Truly.'][beatRewrites - 1]; return JSON.stringify({ beats: { 3: { narration: worded, evidence: [bad] } } }); }
      fullWrites += 1;
      return draftJson(faithful);
    }
  };
  const script = await writeGroundedScript({ story, llm: stubborn, imageFit, maxRevisions: 3, repair: false, logger: quiet });
  assert.equal(fullWrites, 1, 'one full draft');
  assert.equal(beatRewrites, 2, 'the beat was rewritten twice, not three times');
  assert.equal(script.beats.length, faithful.length - 1, 'the failing beat is gone');
  assert.ok(!script.beats.some(b => b.narration.includes(marker)));
  assert.ok(script.beats.length >= 4);
  assert.equal(script.metadata.creativeReview.passed, true);
  assert.equal(script.metadata.creativeReview.facts.passed, true);
  const last = verifierPrompts[verifierPrompts.length - 1];
  assert.ok(!last.includes(marker), 'the last verifier prompt no longer contains the skipped beat');
  for (const b of faithful.filter((_, i) => i !== 2)) assert.ok(last.includes(b.narration), 'the verifier read every other beat again: ' + b.narration.slice(0, 40));
  assert.ok(verifierPrompts.length >= 4, 'the verifier ran on every attempt, including the one without the beat');
  assert.ok(judgeCalls.length > 0, 'the picture check ran too');

  // ---- 2. at least 4 beats stay narrated: with only 4 beats nothing is skipped and the script is rejected ----
  const story4 = { ...story, plan: { ...story.plan, beats: story.plan.beats.slice(0, 4) } };
  story4.attribution = attributionText(plan.article, story4.plan.beats);
  const bad4 = faithful[2].narration;
  let rewrites4 = 0;
  const stubborn4 = {
    generateText: async prompt => {
      if (/strict fact-checker/.test(prompt)) return JSON.stringify({ unsupported: prompt.includes(bad4.slice(0, 40)) ? ['3.1'] : [] });
      if (/fixing single beats/.test(prompt)) { rewrites4 += 1; return JSON.stringify({ beats: { 3: { narration: bad4 + ' ' + 'Indeed. Truly. Surely.'.split(' ')[rewrites4 % 3], evidence: [bad4] } } }); }
      return draftJson(faithful.slice(0, 4));
    }
  };
  await assert.rejects(() => writeGroundedScript({ story: story4, llm: stubborn4, imageFit, maxRevisions: 3, repair: false, logger: quiet }), error => error.code === 'CREATIVE_REVIEW_REJECTED', 'a 4-beat story cannot drop a beat');

  // ---- 3. a full-script reply cut off by the token limit is asked for a third time ----
  let calls = 0;
  const cutOff = {
    lastCall: null,
    generateText: async function generateText(prompt) {
      if (/strict fact-checker/.test(prompt)) return JSON.stringify({ unsupported: [] });
      calls += 1;
      cutOff.lastCall = { model: 'model-' + calls, finishReason: calls <= 2 ? 'length' : 'stop' };
      return calls <= 2 ? '{"title":"cut' : draftJson(faithful);
    }
  };
  const third = await writeGroundedScript({ story, llm: cutOff, imageFit, maxRevisions: 0, repair: false, logger: quiet });
  assert.equal(calls, 3, 'asked three times');
  assert.equal(third.beats.length, faithful.length);

  // ---- 3b. a reply whose beat names no evidence is asked again ("no evidence sentences" was the most frequent failure cause on 2026-10-13) ----
  let draftCalls = 0;
  const bareThenGood = {
    generateText: async prompt => {
      if (/strict fact-checker/.test(prompt)) return JSON.stringify({ unsupported: [] });
      draftCalls += 1;
      const beats = faithful.map(b => ({ narration: b.narration, evidence: b.evidence }));
      if (draftCalls === 1) beats[1] = { narration: faithful[1].narration, evidence_ids: [] };
      return JSON.stringify({ title: 'The Ship Found Empty', beats });
    }
  };
  const asked = await writeGroundedScript({ story, llm: bareThenGood, imageFit, maxRevisions: 0, repair: false, logger: quiet });
  assert.equal(draftCalls, 2, 'the bare draft was not reviewed, it was asked for again');
  assert.equal(asked.beats.length, faithful.length);
  const previous = { beats: faithful.map(b => ({ ...b, skip: false, evidenceIds: [], images: [] })) };
  assert.throws(() => parseBeatReply(JSON.stringify({ beats: { 2: { narration: faithful[1].narration, evidence_ids: [] } } }), new Set([2]), story, previous), /no title.beats/);
  assert.throws(() => parseBeatReply(JSON.stringify({ beats: { 2: { narration: faithful[1].narration } } }), new Set([2]), story, previous), /no title.beats/);
  assert.ok(parseBeatReply(JSON.stringify({ beats: { 2: { narration: faithful[1].narration, evidence: [faithful[1].evidence[0]] } } }), new Set([2]), story, previous)[2].evidence.length === 1);

  // ---- 3c. a title may only say what the article says: a word the source does not have replaces the title by the article's own title ----
  const kept = supportedTitle('The Ship Found Empty', story, '');
  assert.equal(kept.replaced, false);
  const invented = supportedTitle('Zorbulated Ship Found Empty', story, '');
  assert.deepEqual([invented.replaced, invented.unsupported, invented.title], [true, ['zorbulated'], 'Mary Celeste']);
  assert.equal(supportedTitle('Vanished Without a Trace', { plan: { title: 'HMS Repulse (1892)', extract: 'HMS Repulse was a battleship. She was sold for scrap.' } }, '').title, 'HMS Repulse');
  assert.equal(supportedTitle('Facts and details', { plan: { title: 'X', extract: 'It sank.' } }, '').replaced, false, 'generic words and short words are free');
  const retitled = await writeGroundedScript({ story, llm: { generateText: async prompt => (/strict fact-checker/.test(prompt) ? JSON.stringify({ unsupported: [] }) : JSON.stringify({ title: 'Zorbulated Ship Found Empty', beats: faithful.map(b => ({ narration: b.narration, evidence: b.evidence })) })) }, imageFit, maxRevisions: 0, repair: false, logger: quiet });
  assert.equal(retitled.title, 'Mary Celeste');
  assert.deepEqual(retitled.metadata.titleReplaced.unsupported, ['zorbulated']);

  // ---- 4. the prompts carry the source-fidelity rules ----
  const rules = [/ONLY if it is written in the very sentence you cite/, /Never merge two facts/, /young woman.* is not a .teenage girl/, /may have.* stay in the sentence/, /MUST list evidence_ids/];
  const full = buildPrompt(story, null, null, []);
  const beatPrompt = buildBeatPrompt(story, new Set([2]), '- beat 2: x', { beats: faithful.map(b => ({ ...b, skip: false })) }, []);
  for (const rule of rules) { assert.match(full, rule); assert.match(beatPrompt, rule); }
  console.log('writer attempts: ok');
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
