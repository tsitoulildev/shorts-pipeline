// Offline: the fact-check gate and the grounded writer, on the recorded real Mary Celeste article.
const assert = require('assert');
delete process.env.MISTRAL_API_KEY; // the tests must never reach a real vision provider, whatever .env says
const { fixtureHttp } = require('./dark-history-probe');
const { planFootage } = require('../utils/dark-history/footage');
const { attributionText } = require('../utils/dark-history/attribution');
const { checkFacts, checkFactsDeterministic, sentencesOf } = require('../utils/dark-history/fact-check');
const { writeGroundedScript, storyForScript, buildDescription, buildPrompt, proseIssues } = require('../utils/dark-history/grounded-writer');
const { parseJsonResponse } = require('../utils/json-response');

const words = s => s.split(/\s+/).length;
const fitOk = { judge: async () => JSON.stringify({ mismatch: [] }), readImage: async () => ({ mimeType: 'image/jpeg', data: 'AAAA' }) };

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
  // Seen on the VM: the writer repeated the same slightly-off evidence on all four attempts. The issue now shows the closest sentence of
  // the source so the next draft can copy it. A near miss (one word changed) points at the right sentence.
  const real = story.plan.beats[3].text.split(/(?<=[.!?])\s+/).map(sentence => sentence.trim()).find(sentence => sentence.split(/\s+/).length >= 8);
  const nearMiss = real.replace(/\b(\w{5,})\b/, 'altered');
  const hinted = await check(mutate(3, { evidence: [nearMiss] }));
  assert.ok(hinted.issues.some(issue => issue.includes('closest source sentence: "') && issue.includes(real.slice(0, 40))), hinted.issues.join(' | '));
  const unrelated = await check(mutate(3, { evidence: ['Zebras graze quietly beside purple mountains at dawn today.'] }));
  assert.ok(unrelated.issues.some(issue => /not found verbatim/.test(issue) && !/closest source sentence/.test(issue)), 'no hint when nothing is close');
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
  // a real model answered with the list of flagged items directly: that is a verdict, and it rejects
  await rejects(faithful, /beat 2: the source does not support .*adds a cause/, async () => JSON.stringify([{ id: '2.1', reason: 'adds a cause' }]));
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
  const script = await writeGroundedScript({ story, imageFit: fitOk, llm, maxRevisions: 2, repair: false });
  assert.strictEqual(script.beats.length, story.plan.beats.length);
  assert.ok(prompts.some(p => /FACT-CHECK NOTES/.test(p) && /amount "Forty"/.test(p)), 'the rewrite prompt carries the fact-check issue');
  assert.ok(script.metadata.creativeReview.attempts.length >= 2);

  // One round shows every problem: the verifier still runs when a beat failed a deterministic check, on the other beats.
  // (Seen on the VM: each attempt peeled off one layer, deterministic first, then the verifier, and three attempts were not enough.)
  const twoProblems = [];
  const both = await check(mutate(1, { narration: `${faithful[1].narration} Forty-two sailors vanished.` }), async prompt => { twoProblems.push(prompt); return JSON.stringify({ unsupported: [{ id: '3.1', reason: 'adds a cause' }] }); });
  assert.strictEqual(both.passed, false);
  assert.ok(/beat 2: amount "Forty/.test(both.issues.join('|')) && /beat 3: the source does not support/.test(both.issues.join('|')), both.issues.join(' | '));
  assert.ok(twoProblems.length === 1 && !twoProblems[0].includes('BEAT 2 ') && twoProblems[0].includes('BEAT 3 '), 'the beat with a deterministic issue is not shown to the verifier');
  // a verifier that cannot answer does not hide the deterministic issues
  const down = await check(mutate(1, { narration: `${faithful[1].narration} Forty-two sailors vanished.` }), async () => { throw new Error('429'); });
  assert.ok(/amount "Forty/.test(down.issues.join('|')) && /unavailable/.test(down.issues.join('|')));
  // every beat flagged deterministically: no verifier call is needed
  let calls = 0;
  const allBad = await check(faithful.map(b => ({ ...b, evidence: ['Not a sentence of the source at all.'] })), async () => { calls += 1; return JSON.stringify(clean); });
  assert.strictEqual(allBad.passed, false);
  assert.strictEqual(calls, 0);

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
  const skipped = await writeGroundedScript({ story, imageFit: fitOk, llm: { generateText: async prompt => (/strict fact-checker/.test(prompt) ? JSON.stringify(clean) : skipDraft) }, maxRevisions: 0 });
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
  assert.strictEqual((await writeGroundedScript({ story, imageFit: fitOk, llm: flaky, maxRevisions: 0 })).beats.length, faithful.length);
  replies2 = ['{"title":"x"}', 'not json', JSON.stringify(draft(faithful))];
  await assert.rejects(() => writeGroundedScript({ story, imageFit: fitOk, llm: flaky, maxRevisions: 0 }), /no title.beats|JSON/i);

  // Picture fit: a vision model looks at the pictures with the narrations (one request, all beats). Seen on the VM: a waterspout photo
  // sat under "pirates would have looted the ship" because the section it came from discusses theories.
  const fitMod = require('../utils/dark-history/image-fit');
  assert.deepStrictEqual(fitMod.mismatchesOf({ mismatch: [] }), []);
  assert.deepStrictEqual(fitMod.mismatchesOf([{ mismatch: [{ beat: 2 }] }]), [{ beat: 2 }]);
  assert.strictEqual(fitMod.mismatchesOf({ nope: 1 }), null);
  // per-beat verdicts: only fits === true passes, a beat without a verdict is a mismatch, a bare array is accepted
  assert.deepStrictEqual(fitMod.mismatchesOf({ beats: [{ beat: 1, fits: true }, { beat: 2, shows: 'a waterspout', subject: 'pirates', fits: false }] }, [1, 2, 3]).map(m => m.beat), [2, 3]);
  assert.match(fitMod.mismatchesOf([{ beat: 2, shows: 'a waterspout', subject: 'pirates', fits: false }], [2])[0].reason, /shows a waterspout, the narration is about pirates/);
  assert.deepStrictEqual(fitMod.mismatchesOf([{ beat: 1, fits: 'yes' }], [1]).map(m => m.beat), [1], 'only true counts');
  assert.strictEqual(fitMod.mismatchesOf([]), null);
  const seenFit = [];
  const flagging = { readImage: async file => ({ mimeType: 'image/jpeg', data: String(file).slice(-4) }), judge: async ({ prompt, images }) => { seenFit.push({ prompt, images }); return JSON.stringify({ mismatch: [{ beat: 2, reason: 'the picture shows a waterspout' }] }); } };
  const fitDraft = draft(faithful);
  const flagged = await fitMod.checkImageFit({ script: fitDraft, story, ...flagging });
  assert.strictEqual(flagged.passed, false);
  assert.match(flagged.issues[0], /beat 2: the picture does not show what the narration says \(the picture shows a waterspout\)/);
  assert.strictEqual(seenFit[0].images.length, faithful.length, 'one picture per narrated beat, in one request');
  assert.ok(faithful.every((b, i) => seenFit[0].prompt.includes(`NARRATION ${i + 1}: ${b.narration}`)));
  assert.strictEqual((await fitMod.checkImageFit({ script: { beats: skipAt(1).map(b => ({ ...b })) }, story, ...flagging })).checkedBeats, faithful.length - 1, 'a skipped beat has no picture to check');
  // unchecked pictures never pass: no judge, a judge that throws, an unusable answer, an unreadable picture
  const unavailable = async options => { try { await fitMod.checkImageFit({ script: fitDraft, story, ...options }); return null; } catch (error) { return error.code; } };
  assert.strictEqual(await unavailable({}), 'VISION_UNAVAILABLE');
  assert.strictEqual(await unavailable({ judge: async () => { throw new Error('503'); }, readImage: fitOk.readImage }), 'VISION_UNAVAILABLE');
  assert.strictEqual(await unavailable({ judge: async () => 'I see ships.', readImage: fitOk.readImage }), 'VISION_UNAVAILABLE');
  assert.strictEqual(await unavailable({ judge: fitOk.judge, readImage: async () => { throw new Error('no file'); } }), 'VISION_UNAVAILABLE');
  // the mismatch reaches the writer (only that beat is rewritten) and a script whose picture still does not fit is rejected
  const fitPrompts = [];
  let mismatchOnce = true;
  const fitLlm = { generateText: async prompt => { if (/strict fact-checker/.test(prompt)) return JSON.stringify(clean); fitPrompts.push(prompt); return JSON.stringify(fitPrompts.length === 1 ? draft(faithful) : { title: 'The Ship Found Empty', beats: faithful.map((b, i) => (i === 2 ? { skip: true } : b)) }); } };
  const fitFlow = await writeGroundedScript({ story, llm: fitLlm, maxRevisions: 2, imageFit: { readImage: fitOk.readImage, judge: async ({ prompt }) => { if (/say in one short sentence/.test(prompt)) return JSON.stringify({ pictures: [] }); const answer = mismatchOnce ? { mismatch: [{ beat: 3, reason: 'a lap desk is not the cargo' }] } : { mismatch: [] }; mismatchOnce = false; return JSON.stringify(answer); } } });
  assert.ok(/beat 3: the picture does not show what the narration says/.test(fitPrompts[1]), 'the picture mismatch is in the rewrite notes');
  assert.deepStrictEqual(fitFlow.metadata.creativeReview.imageFit, { passed: true, checkedBeats: faithful.length - 1 });
  assert.ok(!fitFlow.sourceBeatIndexes.includes(2), 'the beat whose picture did not fit was dropped, not filled');
  await assert.rejects(() => writeGroundedScript({ story, llm: fitLlm, maxRevisions: 1, imageFit: { readImage: fitOk.readImage, judge: async () => JSON.stringify({ mismatch: [{ beat: 3 }] }) } }), error => error.code === 'CREATIVE_REVIEW_REJECTED' && /picture does not fit/.test(error.message));
  await assert.rejects(() => writeGroundedScript({ story, llm: { generateText: fitLlm.generateText } }), error => error.code === 'VISION_UNAVAILABLE');
  // The writer is told what each picture shows (one vision request), and a missing vision model stops the job before any writing
  const reading = await fitMod.describePictures({ story, readImage: fitOk.readImage, judge: async () => JSON.stringify({ pictures: [{ image: 1, shows: 'A brigantine under sail' }, { image: 3, shows: 'A desk with letters' }] }) });
  assert.strictEqual(reading.length, story.plan.beats.length);
  assert.deepStrictEqual([reading[0], reading[1], reading[2]], ['A brigantine under sail', null, 'A desk with letters']);
  assert.deepStrictEqual(await fitMod.describePictures({ story, readImage: fitOk.readImage, judge: async () => 'not json' }), story.plan.beats.map(() => null), 'best effort: no description, no failure');
  await assert.rejects(() => fitMod.describePictures({ story, readImage: fitOk.readImage, judge: async () => { throw new Error('429 quota'); } }), error => error.code === 'VISION_UNAVAILABLE');
  // pictures are only looked at when the facts hold (free-tier vision quota)
  let looks = 0;
  const lookCounter = { readImage: fitOk.readImage, judge: async ({ prompt }) => { if (!/say in one short sentence/.test(prompt)) looks += 1; return JSON.stringify({ pictures: [], mismatch: [] }); } };
  const factsFail = await require('../utils/dark-history/grounded-writer').reviewGrounded(draft(mutate(1, { narration: `${faithful[1].narration} Forty-two sailors vanished.` })), story, async () => JSON.stringify(clean), lookCounter, { repair: false });
  assert.strictEqual(looks, 0, 'a draft with a fact problem costs no vision request');
  assert.ok(!factsFail.failures.includes('a picture does not fit its narration'));
  await require('../utils/dark-history/grounded-writer').reviewGrounded(draft(faithful), story, async () => JSON.stringify(clean), lookCounter, { repair: false });
  assert.strictEqual(looks, 1);
  assert.match(buildPrompt(story, null, null, ['A brigantine under sail']), /BEAT 1 [^\n]*the picture shows: A brigantine under sail/);
  assert.ok(/narration must be about what its picture shows/.test(buildPrompt(story, null)));
  assert.ok(/Build an arc, not a list/.test(buildPrompt(story, null)) && /the climax: the real fact that is still open/.test(buildPrompt(story, null)));
  let writes = 0;
  await assert.rejects(() => writeGroundedScript({ story, llm: { generateText: async () => { writes += 1; return '{}'; } } }), error => error.code === 'VISION_UNAVAILABLE');
  assert.strictEqual(writes, 0, 'no vision model: nothing is written (fail before spending)');
  // the Gemini vision judge: pictures as inline data in order, then the prompt; falls through the free models; no client, no judge
  assert.strictEqual(fitMod.makeVisionJudge({}, { env: {} }), null);
  const sent = [];
  const gemini = { models: { generateContent: async request => { sent.push(request); if (request.model === 'm1') throw new Error('503 overloaded'); return { text: '{"mismatch":[]}' }; } } };
  const judge = fitMod.makeVisionJudge({ gemini, model: 'm1' }, { models: ['m1', 'm2'], env: {} });
  assert.strictEqual(await judge({ prompt: 'P', images: [{ mimeType: 'image/jpeg', data: 'AAAA' }, { mimeType: 'image/jpeg', data: 'BBBB' }] }), '{"mismatch":[]}');
  assert.deepStrictEqual(sent.map(r => r.model), ['m1', 'm2']);
  assert.deepStrictEqual(sent[1].contents[0].parts.map(p => (p.inlineData ? p.inlineData.data : p.text)), ['AAAA', 'BBBB', 'P']);

  // Vision failover (the free Gemini daily quota ran out on 2026-10-07 and every picture check failed): the calibrated free vision models first
  // (Mistral), Gemini last (its quota is the old system's); a spent quota rests a provider; an unusable answer moves on; text-only models never.
  const posts = [];
  const validJson = text => { try { return Array.isArray(JSON.parse(text).beats); } catch (_e) { return false; } };
  let clock = 1000;
  const mistral = { 'ministral-14b-latest': () => ({ data: { choices: [{ message: { content: 'not json at all' } }] } }), 'mistral-medium-latest': () => { throw Object.assign(new Error('429 rate limit'), { response: { status: 429 } }); } };
  let geminiCalls = 0;
  const geminiOk = { models: { generateContent: async () => { geminiCalls += 1; return { text: '{"beats":[{"beat":1,"shows":"a ship","subject":"a ship","fits":true}]}' }; } } };
  const failover = fitMod.makeVisionJudge({ gemini: geminiOk, model: 'g1' }, { models: ['g1'], env: { MISTRAL_API_KEY: 'k2' }, now: () => clock,
    post: async (url, body, options) => { posts.push({ url, body, options }); return mistral[body.model](); } });
  assert.deepStrictEqual(failover.providers, ['Mistral ministral-14b', 'Mistral medium', 'Gemini g1'], 'Gemini is the last resort');
  const reply = await failover({ prompt: 'P', images: [{ mimeType: 'image/jpeg', data: 'AAAA' }], validate: validJson });
  assert.strictEqual(failover.lastProvider, 'Gemini g1', 'ministral gave an unusable answer, medium hit its rate limit, Gemini answered');
  assert.ok(validJson(reply));
  assert.deepStrictEqual(posts.map(p => p.body.model), ['ministral-14b-latest', 'mistral-medium-latest']);
  assert.match(posts[0].url, /api\.mistral\.ai\/v1\/chat\/completions$/);
  assert.deepStrictEqual(posts[0].body.messages[0].content.map(part => part.type), ['image_url', 'text']);
  assert.strictEqual(posts[0].body.messages[0].content[0].image_url.url, 'data:image/jpeg;base64,AAAA');
  assert.strictEqual(posts[0].options.headers.Authorization, 'Bearer k2');
  // the rate-limited provider rests (no new request to it), the unusable answer does not rest ministral
  posts.length = 0;
  await failover({ prompt: 'P', images: [], validate: validJson });
  assert.deepStrictEqual(posts.map(p => p.body.model), ['ministral-14b-latest'], 'medium is resting');
  clock += 31 * 60000;
  posts.length = 0;
  await failover({ prompt: 'P', images: [], validate: validJson });
  assert.deepStrictEqual(posts.map(p => p.body.model), ['ministral-14b-latest', 'mistral-medium-latest'], 'after the rest medium is asked again');
  assert.strictEqual(geminiCalls, 3);
  // a good Mistral answer never touches Gemini (its quota is not spent)
  mistral['ministral-14b-latest'] = () => ({ data: { choices: [{ message: { content: '{"beats":[{"beat":1,"fits":true}]}' } }] } });
  geminiCalls = 0;
  await failover({ prompt: 'P', images: [], validate: validJson });
  assert.strictEqual(geminiCalls, 0);
  // every provider failing is an error (the caller turns it into VISION_UNAVAILABLE); no keys, no judge; one provider can be chosen
  await assert.rejects(() => fitMod.makeVisionJudge({}, { env: { MISTRAL_API_KEY: 'k' }, post: async () => { throw new Error('503'); } })({ prompt: 'P', images: [] }), /503/);
  assert.strictEqual(fitMod.makeVisionJudge({}, { env: {} }), null);
  assert.deepStrictEqual(fitMod.makeVisionJudge({ gemini: geminiOk, model: 'g' }, { env: { MISTRAL_API_KEY: 'k' }, only: 'medium' }).providers, ['Mistral medium']);

  // Repair by deletion (writer yield): what the checks refuse is deleted, not rewritten (a rewrite can add new inventions, deleting cannot), and the
  // repaired script is verified again from scratch. Nothing is added, no check is relaxed.
  const { repairByDeletion } = require('../utils/dark-history/grounded-writer');
  const twoSentences = beatIndex => ({ ...faithful[beatIndex], narration: `${faithful[beatIndex].narration} The crew had been terrified of the sea for months.`, evidence: faithful[beatIndex].evidence });
  const withExtra = faithful.map((b, i) => (i === 1 ? twoSentences(1) : b));
  // the verifier flags the invented sentence (beat 2, sentence 2): it is deleted, no rewrite is asked for, the verifier saw the repaired script
  const verifierCalls = [];
  const flagging2 = async prompt => { verifierCalls.push(prompt); return JSON.stringify(/terrified/.test(prompt) ? { unsupported: [{ id: '2.2', reason: 'adds a feeling' }] } : { unsupported: [] }); };
  const writerCalls = [];
  const repairLlm = { generateText: async prompt => { if (/strict fact-checker/.test(prompt)) return flagging2(prompt); writerCalls.push(prompt); return JSON.stringify(draft(withExtra)); } };
  const repairedScript = await writeGroundedScript({ story, imageFit: fitOk, llm: repairLlm, maxRevisions: 2 });
  assert.strictEqual(writerCalls.length, 1, 'the draft was repaired, not rewritten');
  assert.strictEqual(verifierCalls.length, 2, 'the repaired script was verified again');
  assert.ok(!/terrified/.test(verifierCalls[1]), 'the second verification saw the script without the invented sentence');
  assert.ok(!repairedScript.fullScript.includes('terrified') && repairedScript.beats[1].narration === faithful[1].narration);
  assert.deepStrictEqual(repairedScript.metadata.creativeReview.repairedByDeletion, { removedSentences: 1, skippedBeats: 0 });
  // a number that is not in the evidence deletes that sentence; evidence that is not in the source skips the beat (its picture falls)
  const badNumber = faithful.map((b, i) => (i === 2 ? { ...b, narration: `${b.narration} It happened in 1999.` } : b));
  const fixedNumber = repairByDeletion({ beats: badNumber, fullScript: '', hook: '' }, story, { unsupported: [] });
  assert.strictEqual(fixedNumber.beats[2].narration, faithful[2].narration);
  const noEvidence = faithful.map((b, i) => (i === 3 ? { ...b, evidence: ['Not a sentence of the source at all today.'] } : b));
  const skippedBeat = repairByDeletion({ beats: noEvidence, fullScript: '', hook: '' }, story, { unsupported: [] });
  assert.strictEqual(skippedBeat.beats[3].skip, true);
  assert.strictEqual(skippedBeat.sourceBeatIndexes, undefined);
  // too thin after the deletion: the beat is skipped; fewer than 4 narrated beats left: no repair (null), the loop rewrites
  const thin = faithful.map((b, i) => (i === 1 ? { ...b, narration: 'Too short here.', evidence: b.evidence } : b));
  assert.strictEqual(repairByDeletion({ beats: thin, fullScript: '', hook: '' }, story, { unsupported: [] }).beats[1].skip, true);
  const mostlyBad = faithful.map((b, i) => (i < faithful.length - 3 ? { ...b, evidence: ['Not a sentence of the source at all today.'] } : b));
  assert.strictEqual(repairByDeletion({ beats: mostlyBad, fullScript: '', hook: '' }, story, { unsupported: [] }), null);
  // the repair never rescues what is still wrong: the verifier flags the same beat again after the deletion -> not passed (and it can be turned off)
  const stubborn = async () => JSON.stringify({ unsupported: [{ id: '1.1', reason: 'still unsupported' }] });
  const stillBad = await require('../utils/dark-history/grounded-writer').reviewGrounded(draft(withExtra), story, stubborn, fitOk);
  assert.strictEqual(stillBad.passed, false);
  assert.ok(!stillBad.repairedByDeletion);
  const noRepair = await require('../utils/dark-history/grounded-writer').reviewGrounded(draft(withExtra), story, flagging2, fitOk, { repair: false });
  assert.strictEqual(noRepair.passed, false);

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
  const converged = await writeGroundedScript({ story, imageFit: fitOk, llm: converge, maxRevisions: 1, repair: false });
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
  await assert.rejects(() => writeGroundedScript({ story, imageFit: fitOk, llm: liar, maxRevisions: 1, repair: false }), error => error.code === 'CREATIVE_REVIEW_REJECTED' && /fact-check/.test(error.message));

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
