// (The text in scripts/fixtures/golden-short.json is from the English Wikipedia article "SS Edmund Fitzgerald", CC BY-SA 4.0, credits in its `attribution`.)
// Golden Short: a script that really went through every gate and was scheduled (the Edmund Fitzgerald one, exported from the live database; paths removed) must keep
// passing the whole chain of script gates: deterministic fact check, the fact verifier, the picture check, the prose rules and the description with its credits.
// It carries number words that ARE in the evidence ("Two widows", "$24 million"): a broken word-boundary regex, which once blocked this very Short at upload,
// fails here before any deploy. The same script with one broken fact must still fail (the chain is live, not a stub).
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { checkFactsDeterministic } = require('../utils/dark-history/fact-check');
const { reviewGrounded, proseIssues, buildDescription } = require('../utils/dark-history/grounded-writer');
const { parseJsonResponse } = require('../utils/json-response');

const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'golden-short.json'), 'utf8'));
const { story, script } = golden;
const clone = value => JSON.parse(JSON.stringify(value));
const verifierSaysClean = async () => JSON.stringify({ unsupported: [] });
const everyPictureFits = { judge: async () => JSON.stringify({ mismatch: [] }), readImage: async () => ({ mimeType: 'image/jpeg', data: 'AAAA' }) };

(async () => {
  // 1. the deterministic gate (evidence verbatim, numbers, number words, names, quotations)
  const facts = checkFactsDeterministic({ title: script.title, beats: script.beats }, story);
  assert.equal(facts.passed, true, JSON.stringify(facts.issues));
  // 2. the review the writer runs: facts (with the verifier), pictures, prose
  const review = await reviewGrounded({ ...clone(script), metadata: {} }, story, verifierSaysClean, everyPictureFits, { repair: false });
  assert.equal(review.passed, true, JSON.stringify(review.failures) + JSON.stringify(review.notes));
  assert.ok(review.overall >= 7, `score ${review.overall}`);
  assert.ok(proseIssues(script).length <= 1, JSON.stringify(proseIssues(script)));
  // 3. the description keeps the credits unchanged
  const description = buildDescription(script, story);
  assert.ok(description.includes(story.attribution) && /Wikipedia/.test(description) && /Wikimedia Commons/.test(description));
  // the number words of the golden script are in its evidence: that is what a broken regex got wrong
  assert.ok(/Two widows/.test(script.beats[2].narration) && /\$24 million/.test(script.beats[2].evidence.join(' ')) && /Two widows/.test(script.beats[2].evidence.join(' ')));

  // the chain still rejects: a count that is not in the evidence, an altered evidence sentence, a name that is not in the source
  const withCount = clone(script); withCount.beats[1].narration += ' Forty sailors vanished.';
  assert.match(checkFactsDeterministic({ title: 't', beats: withCount.beats }, story).issues.join(), /amount "Forty"/);
  const altered = clone(script); altered.beats[0].evidence = [altered.beats[0].evidence[0].replace('29 men', '30 men')];
  assert.match(checkFactsDeterministic({ title: 't', beats: altered.beats }, story).issues.join(), /not found verbatim/);
  const invented = clone(script); invented.beats[3].narration += ' Captain Zubrowski rang it.';
  assert.match(checkFactsDeterministic({ title: 't', beats: invented.beats }, story).issues.join(), /Zubrowski/);
  const verifierFlags = await reviewGrounded({ ...clone(script), metadata: {} }, story, async () => JSON.stringify({ unsupported: [{ id: '2.1', reason: 'x' }] }), everyPictureFits, { repair: false });
  assert.equal(verifierFlags.passed, false);
  assert.ok(parseJsonResponse('{"a":1}').a === 1);
  console.log('golden short: ok');
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
