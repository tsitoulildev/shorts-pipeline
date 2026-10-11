// Evidence by code: the model cites source sentence ids and the program copies the sentences (verbatim by construction); each beat lists the numbers and names
// it may use; a failed beat is rewritten on its own, with its exact notes, and the rest of the script is shown read-only.
const assert = require('node:assert/strict');
const { PROMPT_PASSAGE_CHARS, sourceSentences, allowedIn, evidenceFromIds, buildPrompt, buildBeatPrompt, parseBeatReply, writeGroundedScript } = require('../utils/dark-history/grounded-writer');
const { provenEvidenceText } = require('../utils/dark-history/fact-check');

const beat = (heading, text) => ({ heading, text, images: [{ title: `${heading}.jpg` }] });
const story = {
  article_url: 'https://en.wikipedia.org/wiki/Example', attribution: 'Source: Wikipedia',
  plan: {
    title: 'The Example Ship',
    extract: 'The Example was a brigantine found adrift in 1872. Her crew of ten was never seen again. Short one.',
    beats: [
      beat('Found', 'On 4 December 1872 the Dei Gratia sighted the brigantine under reduced sail. Captain Morehouse sent a boarding party of three men. They found the cargo of 1,701 barrels intact.'),
      beat('Crew', 'Captain Briggs had sailed with his wife and daughter. The lifeboat was missing and the logbook ended on 25 November.')
    ]
  }
};

// sentences: whole sentences of at least 5 words; a sentence cut by the limit is not offered
assert.deepEqual(sourceSentences(story.plan.extract, 600), ['The Example was a brigantine found adrift in 1872.', 'Her crew of ten was never seen again.']);
const cut = sourceSentences(story.plan.beats[0].text, 100);
assert.equal(cut.length, 1, 'the second sentence is cut by the limit and not shown');
// allowed numbers and names of a beat
const allowed = allowedIn(sourceSentences(story.plan.beats[0].text, 1800));
assert.ok(allowed.numbers.includes('1872') && allowed.numbers.includes('1,701') && allowed.numbers.includes('4'));
assert.ok(allowed.names.includes('Dei') || allowed.names.includes('Gratia'));
// ids -> sentences, only the beat's own and the lead's
assert.deepEqual(evidenceFromIds(['1.2', 'L.2', '2.1', 'x', '1.9'], story, 0), ['Captain Morehouse sent a boarding party of three men.', 'Her crew of ten was never seen again.']);
const copied = evidenceFromIds(['1.1', '1.3'], story, 0);
assert.ok(provenEvidenceText(copied, story.plan.beats[0].text, story.plan.extract).length > 0, 'a copied sentence is verbatim in the passage');
// the prompt shows ids and the allowed lists; nothing asks the model to copy text
const prompt = buildPrompt(story, null);
assert.match(prompt, /\[1\.1\] On 4 December 1872/);
assert.match(prompt, /\[L\.1\] The Example was a brigantine/);
assert.match(prompt, /ALLOWED in this beat[^\n]*numbers: 4, 1872, 1,701/);
assert.match(prompt, /"evidence_ids":\["1\.1"\]/);
assert.ok(!/copied VERBATIM/.test(prompt));

// joins: beats are separated by a space (a join without one glued the last word of a beat to the first of the next: wrong word counts, "aboard.Her" in the spoken script)
{
  const { proseIssues } = require('../utils/dark-history/grounded-writer');
  const two = { beats: [{ skip: false, narration: 'One two three four five.' }, { skip: false, narration: 'Six seven eight nine ten.' }] };
  assert.match(proseIssues(two).join(), /the narration is 10 words/, 'ten words, not nine');
  assert.deepEqual(allowedIn(['Captain Morehouse sent 3 men.', 'Dei Gratia sighted 1,701 barrels.']).numbers, ['3', '1,701']);
  assert.ok(allowedIn(['Captain Morehouse sent 3 men.', 'Dei Gratia sighted 1,701 barrels.']).names.includes('Morehouse'));
}

// per-beat rewrite: only the named beat, its exact notes, the rest read-only
const previous = {
  title: 't',
  beats: [
    { narration: 'The brigantine was found adrift in 1872 by a passing ship.', evidenceIds: ['1.1'], evidence: ['On 4 December 1872 the Dei Gratia sighted the brigantine under reduced sail.'], images: [] },
    { narration: 'Forty sailors vanished from the ship without any trace at all.', evidenceIds: ['2.1'], evidence: ['Captain Briggs had sailed with his wife and daughter.'], images: [] }
  ]
};
const brief = '- beat 2: amount "Forty" is not in its evidence\n- beat 1: something else about beat one';
const beatPrompt = buildBeatPrompt(story, new Set([2]), brief, previous, []);
assert.match(beatPrompt, /EXACT PROBLEMS WITH IT/);
assert.match(beatPrompt, /amount "Forty" is not in its evidence/);
assert.ok(!/something else about beat one/.test(beatPrompt), 'notes of other beats are not in this request');
assert.match(beatPrompt, /Beat 1: The brigantine was found adrift/, 'the rest of the script is shown');
assert.match(beatPrompt, /\[2\.1\] Captain Briggs/);
assert.ok(!/\[1\.1\]/.test(beatPrompt), 'the source sentences of beats that are not rewritten are not sent');
const reply = JSON.stringify({ beats: { 2: { narration: 'Captain Briggs sailed with his wife and daughter on board.', evidence_ids: ['2.1'] } } });
const rewritten = parseBeatReply(reply, new Set([2]), story, previous);
assert.deepEqual(rewritten[2].evidence, ['Captain Briggs had sailed with his wife and daughter.']);
assert.throws(() => parseBeatReply('{"beats":{"1":{}}}', new Set([2]), story, previous), /beat 2 missing|no title/);

// end to end on the recorded Mary Celeste footage with a stub model: the first draft cites ids, one beat states an invented count, so the next request is the
// rewrite of that beat only, and it goes to another model than the one that wrote the draft
const { planFootage } = require('../utils/dark-history/footage');
const { fixtureHttp } = require('./dark-history-probe');
const { attributionText } = require('../utils/dark-history/attribution');
const words = text => text.split(/\s+/).length;
const fitOk = { judge: async () => JSON.stringify({ mismatch: [] }), readImage: async () => ({ mimeType: 'image/jpeg', data: 'AAAA' }) };

(async () => {
  const plan = await planFootage('Mary Celeste', { http: fixtureHttp });
  const real = { article_url: plan.article.url, plan: { title: plan.article.title, extract: plan.article.extract, beats: plan.beats }, attribution: attributionText(plan.article, plan.beats) };
  const picks = real.plan.beats.map((b, i) => {
    const list = sourceSentences(b.text, PROMPT_PASSAGE_CHARS);
    const usable = list.map((sentence, k) => ({ sentence, k })).filter(item => words(item.sentence) >= 9 && words(item.sentence) <= 21 && !/[;–—]/.test(item.sentence)).sort((a, b) => Math.abs(words(a.sentence) - 15) - Math.abs(words(b.sentence) - 15));
    const j = usable.length ? usable[0].k : -1;
    assert.ok(j >= 0, `a usable sentence in beat ${i + 1}`);
    return { narration: list[j], evidence_ids: [`${i + 1}.${j + 1}`] };
  });
  const bad = picks.map((p, i) => (i === 1 ? { ...p, narration: `${p.narration} Forty sailors vanished.` } : p));
  const calls = [];
  const llm = {
    lastCall: null,
    generateText: async (text, options) => {
      calls.push({ role: options.role, avoid: options.avoidModel || null, beatRewrite: /EXACT PROBLEMS WITH IT/.test(text) });
      if (options.role === 'verifier') { llm.lastCall = { model: 'verifier-model', finishReason: 'stop' }; return JSON.stringify({ unsupported: [] }); }
      if (/EXACT PROBLEMS WITH IT/.test(text)) { llm.lastCall = { model: 'model-b', finishReason: 'stop' }; return JSON.stringify({ beats: { 2: picks[1] } }); }
      llm.lastCall = { model: 'model-a', finishReason: 'stop' };
      return JSON.stringify({ title: 'The Ship Found Empty', beats: bad });
    }
  };
  const script = await writeGroundedScript({ story: real, llm, imageFit: fitOk, maxRevisions: 2, repair: false });
  const rewriteCall = calls.find(call => call.beatRewrite);
  assert.ok(rewriteCall, 'the failed beat was rewritten on its own');
  assert.equal(rewriteCall.avoid, 'model-a', 'by another model than the one that wrote it');
  assert.ok(!/Forty/.test(script.fullScript), 'the invented count is gone');
  assert.ok(calls.every(call => call.role === 'writer' || call.role === 'verifier'));
  console.log('evidence by code: ok');
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
