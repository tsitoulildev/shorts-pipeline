// Offline: the fact-check gate and the grounded writer, on the recorded real Mary Celeste article.
const assert = require('assert');
const { fixtureHttp } = require('./dark-history-probe');
const { planFootage } = require('../utils/dark-history/footage');
const { attributionText } = require('../utils/dark-history/attribution');
const { checkFacts, checkFactsDeterministic, sentencesOf } = require('../utils/dark-history/fact-check');
const { writeGroundedScript, storyForScript, buildDescription, buildPrompt, proseIssues } = require('../utils/dark-history/grounded-writer');
const { parseJsonResponse } = require('../utils/json-response');

const words = s => s.split(/\s+/).length;

(async () => {
  const plan = await planFootage('Mary Celeste', { http: fixtureHttp });
  const story = { article_url: plan.article.url, plan: { title: plan.article.title, extract: plan.article.extract, beats: plan.beats }, attribution: attributionText(plan.article, plan.beats) };

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
  // Seen on the VM with a real model: the reply came wrapped in an array. That is the same answer, not an unusable one.
  assert.strictEqual((await check(faithful, async () => JSON.stringify([clean]))).passed, true);
  await rejects(faithful, /does not support/, async () => JSON.stringify([{ unsupported: ['2.1'] }]));
  await rejects(faithful, /unusable answer/, async () => JSON.stringify({ unsupported: 'none' }));
  await rejects(faithful, /unusable answer/, async () => '[]');
  // The verifier gives its reason per sentence and the reason reaches the writer's revision notes.
  await rejects(faithful, /adds a motive/, async () => JSON.stringify({ unsupported: [{ id: '2.1', reason: 'adds a motive' }] }));
  // The verifier judges each sentence against the beat's EVIDENCE (the verbatim source sentences the deterministic stage
  // already proved), not against the first 900 characters of the passage, which can miss the sentence the writer used.
  const seen = [];
  await check(faithful, async prompt => { seen.push(prompt); return JSON.stringify(clean); });
  assert.ok(seen[0].includes('strict fact-checker') && /EVIDENCE/.test(seen[0]));
  faithful.forEach(b => assert.ok(seen[0].includes(b.evidence[0]), 'the prompt carries every beat\'s evidence'));
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

  // A beat may be skipped when its passage adds nothing to the story: no narration, its picture and credit leave the video.
  // (Wikipedia sections are arbitrary: the real Mary Celeste draft had to cram a section about a later wreck into a 40 s story.)
  const skip = { skip: true, narration: '', evidence: [] };
  const skipAt = (index, beats = faithful) => beats.map((b, i) => (i === index ? skip : b));
  assert.strictEqual((await check(skipAt(1))).passed, true, 'one skipped beat is fine');
  await rejects(skipAt(1).map((b, i) => (i === 1 ? { ...b, narration: 'It was cold.' } : b)), /beat 2: a skipped beat must have no narration/);
  await rejects(faithful.map((b, i) => (i < faithful.length - 3 ? skip : b)), /at least 4 beats must be narrated/);
  const seenSkip = [];
  await check(skipAt(1), async prompt => { seenSkip.push(prompt); return JSON.stringify(clean); });
  assert.ok(!seenSkip[0].includes('BEAT 2 ') && seenSkip[0].includes('BEAT 3 '), 'the verifier is not asked about a skipped beat');
  assert.ok(/"skip":true/.test(buildPrompt(story, null)) && /at least 4 beats must stay/.test(buildPrompt(story, null)));
  const skipDraft = JSON.stringify({ title: 'The Ship Found Empty', beats: skipAt(1).map(b => (b.skip ? { skip: true } : { narration: b.narration, evidence: b.evidence })) });
  const skipped = await writeGroundedScript({ story, llm: { generateText: async prompt => (/strict fact-checker/.test(prompt) ? JSON.stringify(clean) : skipDraft) }, maxRevisions: 0 });
  assert.strictEqual(skipped.beats.length, story.plan.beats.length - 1);
  assert.deepStrictEqual(skipped.sourceBeatIndexes, story.plan.beats.map((_, i) => i).filter(i => i !== 1));
  const used = storyForScript(story, skipped);
  assert.strictEqual(used.plan.beats.length, skipped.beats.length);
  skipped.beats.forEach((b, i) => assert.deepStrictEqual(b.images.map(x => x.sha256), used.plan.beats[i].images.map(x => x.sha256), 'script beat i shows the images of story beat i'));
  const titleOf = beat => beat.images[0].title.replace(/.(jpe?g|png)$/i, '');
  assert.ok(!used.attribution.includes(titleOf(story.plan.beats[1])), 'the picture that is not shown is not credited');
  assert.ok(used.attribution.includes(titleOf(story.plan.beats[0])) && used.attribution.includes(titleOf(story.plan.beats[2])));
  assert.ok(skipped.description.includes(used.attribution) && !skipped.description.includes(titleOf(story.plan.beats[1])));
  assert.strictEqual(storyForScript(story, { sourceBeatIndexes: story.plan.beats.map((_, i) => i) }), story, 'nothing skipped: the story is unchanged');
  // the documentary gate's fact re-check accepts the pruned pair, and still rejects a pruned script paired with the full story
  const { checkFactsDeterministic: recheck } = require('../utils/dark-history/fact-check');
  assert.strictEqual(recheck(skipped, used).passed, true);
  assert.strictEqual(recheck(skipped, story).passed, false);

  // A reply that is not the JSON asked for is asked once more; a second bad reply loses the attempt (nothing is invented).
  let replies2 = ['{"title":"x"}', JSON.stringify(draft(faithful))];
  const flaky = { generateText: async prompt => (/strict fact-checker/.test(prompt) ? JSON.stringify(clean) : replies2.shift()) };
  assert.strictEqual((await writeGroundedScript({ story, llm: flaky, maxRevisions: 0 })).beats.length, faithful.length);
  replies2 = ['{"title":"x"}', 'not json', JSON.stringify(draft(faithful))];
  await assert.rejects(() => writeGroundedScript({ story, llm: flaky, maxRevisions: 0 }), /no title.beats|JSON/i);

  // Seen on the VM: every rewrite fixed the flagged beat and broke another one, so three attempts never converged.
  // A rewrite now gets the previous draft and may change ONLY the beats the notes name; the others are restored as they were.
  const broken = mutate(1, { narration: `${faithful[1].narration} Forty-two sailors vanished.` });
  const fixedButBreaksAnother = faithful.map((b, i) => (i === 2 ? { ...b, narration: `${b.narration} In 1999 it happened again.` } : b));
  const seq = [JSON.stringify(draft(broken)), JSON.stringify(draft(fixedButBreaksAnother))];
  const rewritePrompts = [];
  const converge = { generateText: async prompt => {
    if (/strict fact-checker/.test(prompt)) return JSON.stringify(clean);
    rewritePrompts.push(prompt);
    return seq.shift();
  } };
  const converged = await writeGroundedScript({ story, llm: converge, maxRevisions: 1 });
  assert.strictEqual(converged.beats[2].narration, faithful[2].narration, 'a beat the notes did not name is restored from the previous draft');
  assert.strictEqual(converged.beats[1].narration, faithful[1].narration, 'the flagged beat was rewritten');
  assert.ok(/PREVIOUS DRAFT/.test(rewritePrompts[1]) && rewritePrompts[1].includes(broken[1].narration), 'the rewrite prompt carries the previous draft');
  assert.ok(!/approved premise|Rewrite the full script/.test(rewritePrompts[1]), 'no horror wording in a documentary rewrite');

  // Seen on the VM: the model spelled dates out ("eighteen seventy-two"), which no source sentence contains; the prompt asks for digits.
  assert.ok(/as digits exactly as the evidence has them/.test(require('../utils/dark-history/grounded-writer').buildPrompt(story, null)));

  // Attribution reaches the description unchanged; an over-long one is rejected, never truncated.
  assert.ok(script.description.includes(story.attribution));
  assert.ok(script.description.startsWith(script.hook));
  assert.throws(() => buildDescription(script, { attribution: 'x'.repeat(5000) }), /limit/);
  assert.throws(() => buildDescription(script, { attribution: '' }), /attribution missing/);

  // No draft passes: the job is rejected (fail closed), nothing is published from an unverified script.
  const liar = { generateText: async prompt => (/strict fact-checker/.test(prompt) ? JSON.stringify(clean) : JSON.stringify(draft(bad))) };
  await assert.rejects(() => writeGroundedScript({ story, llm: liar, maxRevisions: 1 }), error => error.code === 'CREATIVE_REVIEW_REJECTED' && /fact-check/.test(error.message));

  // The VM sample report separates thrown errors, invalid/cut answers and provider truncation, per provider and model.
  const { instrument, toMarkdown } = require('./dark-history-judge-sample');
  const answers = [
    { text: '{"relevant":[1]}', call: { provider: 'Groq', model: 'llama', finishReason: 'stop' } },
    { text: '{ "', call: { provider: 'Google Gemini', model: 'gemini-x', finishReason: 'MAX_TOKENS' } },
    { text: 'not json at all', call: { provider: 'Groq', model: 'llama', finishReason: 'stop' } },
    { throws: new Error('429 quota'), call: { provider: 'Mistral', model: 'm', finishReason: null } }
  ];
  const fake = { lastCall: null, async generateText() { const a = answers.shift(); this.lastCall = a.call; if (a.throws) throw a.throws; return a.text; } };
  const probe = instrument(fake, reply => { try { return Array.isArray(JSON.parse(reply).relevant); } catch (_e) { return false; } });
  for (let i = 0; i < 4; i += 1) await probe.generateText('x', { maxTokens: 200 }).catch(() => {});
  assert.deepStrictEqual([probe.stats.calls, probe.stats.failed, probe.stats.invalid, probe.stats.truncated], [4, 1, 2, 1]);
  assert.deepStrictEqual(probe.stats.providers['Groq / llama'], { calls: 2, failed: 0, invalid: 1, truncated: 0, finishReasons: { stop: 2 } });
  assert.strictEqual(probe.stats.providers['Google Gemini / gemini-x'].truncated, 1);
  const md = toMarkdown([{ title: 'T', editorPlacedOnly: { eligible: false, beats: 1 }, withJudge: { eligible: false, beats: 0, reason: 'r', shareAlike: false }, beats: [], judged: [], llm: probe.stats }]);
  assert.match(md, /Measured LLM calls \(counted, not estimated\)/);
  assert.match(md, /- T: 4 calls \(1 threw, 2 invalid, 1 cut at the token limit\)/);
  assert.match(md, /by provider Groq \/ llama: 2 answers, 0 threw, 1 invalid, 0 truncated/);
  assert.match(md, /failed \(threw\): 1; invalid answers \(bad\/cut JSON\): 2; cut by the provider at the token limit: 1/);
  assert.match(md, /Google Gemini \/ gemini-x: 1 answers, 0 threw, 1 invalid, 1 truncated/);

  // Contact sheet: every beat with image, license and source; dropped passages with the reason; HTML-escaped.
  const { contactSheetHtml } = require('../utils/dark-history/contact-sheet');
  const html = contactSheetHtml([{ title: 'Story <1>', editorPlacedOnly: { eligible: true }, withJudge: { eligible: true, reason: 'ok', shareAlike: true },
    beats: [{ heading: 'Intro', text: 'Text', images: [{ title: 'A.jpg', license: 'CC BY-SA 4.0', author: 'Ann', fileUrl: 'https://upload.wikimedia.org/a.jpg', descriptionUrl: 'https://commons.wikimedia.org/wiki/File:A.jpg', source: 'LLM-approved' }] }],
    diagnostics: [{ heading: 'Intro', ownedTitles: [], screened: [], approved: [] }, { heading: 'Lost', ownedTitles: [], screened: ['X.jpg'], approved: [] }] }]);
  assert.ok(html.includes('Story &lt;1&gt;') && html.includes('CC BY-SA 4.0') && html.includes('approved by the LLM judge') && html.includes('src="https://upload.wikimedia.org/a.jpg"'));
  assert.ok(/1 passage\(s\) left out/.test(html) && html.includes('Lost') && html.includes('rejected: X.jpg'));

  console.log('dark-history writer tests passed');
})().catch(error => { console.error(error); process.exit(1); });
