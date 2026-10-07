// Offline: the fact-check gate and the grounded writer, on the recorded real Mary Celeste article.
const assert = require('assert');
const { fixtureHttp } = require('./dark-history-probe');
const { planFootage } = require('../utils/dark-history/footage');
const { attributionText } = require('../utils/dark-history/attribution');
const { checkFacts, checkFactsDeterministic, sentencesOf } = require('../utils/dark-history/fact-check');
const { writeGroundedScript, buildDescription, proseIssues } = require('../utils/dark-history/grounded-writer');
const { parseJsonResponse } = require('../utils/json-response');

const words = s => s.split(/\s+/).length;

(async () => {
  const plan = await planFootage('Mary Celeste', { http: fixtureHttp });
  const story = { plan: { title: plan.article.title, extract: plan.article.extract, beats: plan.beats }, attribution: attributionText(plan.article, plan.beats) };

  // A faithful draft built from real source sentences (8-22 words each, ~15 words per beat).
  const faithful = story.plan.beats.map(beat => {
    const sentence = sentencesOf(beat.text).filter(s => words(s) >= 12 && !/[;–—]/.test(s)).sort((a, b) => words(a) - words(b))[0];
    assert.ok(sentence, `a usable source sentence exists in ${beat.heading}`);
    return { narration: sentence, evidence: [sentence] };
  });
  const draft = beats => ({ title: 'The Ship Found Empty', beats: beats.map(b => ({ ...b })) });
  const clean = { unsupported: [] };
  const verifyWith = answer => async () => JSON.stringify(answer);
  const check = (beats, verify = verifyWith(clean)) => checkFacts(draft(beats), story, { verify, parseJson: parseJsonResponse });

  assert.strictEqual(checkFactsDeterministic(draft(faithful), story).passed, true, JSON.stringify(checkFactsDeterministic(draft(faithful), story).issues));
  assert.strictEqual((await check(faithful)).passed, true);

  const mutate = (index, patch) => faithful.map((b, i) => (i === index ? { ...b, ...patch } : b));
  const rejects = async (beats, pattern, verify) => {
    const result = await check(beats, verify);
    assert.strictEqual(result.passed, false, `must reject: ${pattern}`);
    assert.match(result.issues.join(' | '), pattern);
  };

  // Everything that is not in the source is rejected.
  await rejects(mutate(1, { narration: `${faithful[1].narration} Forty-two sailors vanished.` }), /amount "Forty-two|number|amount "forty/i);
  await rejects(mutate(1, { narration: `${faithful[1].narration} It happened in 1873.` }), /number "1873"/);
  await rejects(mutate(2, { narration: `${faithful[2].narration} Captain Zebulon Smith screamed.` }), /Zebulon/);
  await rejects(mutate(0, { narration: `${faithful[0].narration} He whispered "we are doomed forever".` }), /invented quotation/);
  await rejects(mutate(3, { evidence: ['The captain secretly poisoned the entire crew before leaving.'] }), /not found verbatim/);
  await rejects(mutate(3, { evidence: [] }), /no evidence/);
  await rejects(mutate(3, { evidence: ['The ship sailed.'] }), /not found verbatim/); // too short to prove anything
  await rejects(faithful.slice(0, 3), /one beat per footage beat/);

  // The LLM verifier: unsupported sentence rejects, an unusable answer rejects, no verifier or an error rejects (fail closed).
  await rejects(faithful, /does not support/, verifyWith({ unsupported: ['2.1'] }));
  await rejects(faithful, /unusable answer/, verifyWith({ nope: true }));
  await rejects(faithful, /unavailable/, async () => { throw new Error('429 quota'); });
  assert.match((await checkFacts(draft(faithful), story, {})).issues[0], /no LLM verifier/);

  // Prose editor: word budget, hook, art style words.
  assert.ok(proseIssues(draft(faithful.slice(0, 1))).some(n => /words; it must be/.test(n)));
  assert.ok(proseIssues(draft(mutate(2, { narration: 'It was a drawing of a ship that sailed on and on and on today.' }))).some(n => /visual style/.test(n)));

  // Writer loop: a draft with an invented fact is sent back with the fact-check notes; the corrected draft passes.
  const bad = mutate(1, { narration: `${faithful[1].narration} Forty-two sailors vanished.` });
  const replies = [JSON.stringify(draft(bad)), JSON.stringify(draft(faithful)), JSON.stringify(draft(faithful))];
  const prompts = [];
  const llm = { generateText: async prompt => {
    prompts.push(prompt);
    return /strict fact-checker/.test(prompt) ? JSON.stringify(clean) : replies.shift();
  } };
  const script = await writeGroundedScript({ story, llm, maxRevisions: 2 });
  assert.strictEqual(script.beats.length, story.plan.beats.length);
  assert.ok(prompts.some(p => /FACT-CHECK NOTES/.test(p) && /amount "Forty"/.test(p)), 'the rewrite prompt carries the fact-check issue');
  assert.ok(script.metadata.creativeReview.attempts.length >= 2);

  // Attribution reaches the description unchanged; an over-long one is rejected, never truncated.
  assert.ok(script.description.includes(story.attribution));
  assert.ok(script.description.startsWith(script.hook));
  assert.throws(() => buildDescription(script, { attribution: 'x'.repeat(5000) }), /limit/);
  assert.throws(() => buildDescription(script, { attribution: '' }), /attribution missing/);

  // No draft passes: the job is rejected (fail closed), nothing is published from an unverified script.
  const liar = { generateText: async prompt => (/strict fact-checker/.test(prompt) ? JSON.stringify(clean) : JSON.stringify(draft(bad))) };
  await assert.rejects(() => writeGroundedScript({ story, llm: liar, maxRevisions: 1 }), error => error.code === 'CREATIVE_REVIEW_REJECTED' && /fact-check/.test(error.message));

  // The VM sample report counts LLM calls and failures, so a dead provider is visible instead of silent.
  const { instrument, toMarkdown } = require('./dark-history-judge-sample');
  const probe = instrument({ generateText: async () => { throw new Error('429 quota'); } });
  await probe.generateText('x').catch(() => {});
  assert.deepStrictEqual([probe.stats.calls, probe.stats.failed], [1, 1]);
  assert.match(toMarkdown([{ title: 'T', editorPlacedOnly: { eligible: false, beats: 1 }, withJudge: { eligible: false, beats: 0, reason: 'r', shareAlike: false }, beats: [], judged: [], llm: probe.stats }]), /failed: 1 \(429 quota\)/);

  console.log('dark-history writer tests passed');
})().catch(error => { console.error(error); process.exit(1); });
