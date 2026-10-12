// A claim that the source itself calls a theory, a legend or "said to" may not be narrated as plain fact: the beat must carry its own attribution, or it is rewritten (that beat only).
// Real beats: scripts/fixtures/real-beats.json = the 43 narrated beats of the Shorts made so far (narration + evidence sentences, from Wikipedia, CC BY-SA 4.0).
const assert = require('node:assert/strict');
const { disputedClaimIssues, proseIssues } = require('../utils/dark-history/grounded-writer');

const real = require('./fixtures/real-beats.json');
const one = (narration, evidence) => disputedClaimIssues({ beats: [{ narration, evidence }] });

// 1. On the 43 real beats exactly the two known problems are flagged: no false positive.
const flagged = real.filter(b => one(b.narration, b.evidence).length).map(b => `${b.story.split(':')[0].split(' ')[0]} beat ${b.beat}`);
assert.equal(real.length, 43);
assert.deepEqual(flagged, ['Hindenburg beat 4', 'The beat 2'], 'Hindenburg beat 4 and Great Chicago Fire beat 2');

// 2. The two known cases, by name: the note names the beat, so only that beat is rewritten.
const chicago = real.find(b => b.story.startsWith('The Great Chicago Fire') && b.beat === 2);
assert.match(disputedClaimIssues({ beats: [{ narration: 'x', evidence: [] }, chicago] })[0], /^beat 2: the source calls this uncertain \("is said to"\)/);
const hindenburg = real.find(b => b.story.startsWith('Hindenburg') && b.beat === 4);
assert.match(one(hindenburg.narration, hindenburg.evidence)[0], /\("hypothes[ie]s"\)/);

// 3. What must pass: the same facts with an attribution, a legend already told as a legend, a debate already named as a debate.
assert.deepEqual(one('The fire is said to have started when Daniel "Peg-Leg" Sullivan knocked over a lantern.', chicago.evidence), []);
assert.deepEqual(one('According to one account, a man named Sullivan knocked over a lantern.', chicago.evidence), []);
const legend = real.find(b => b.story.startsWith('The Great Chicago Fire') && b.beat === 4);
assert.match(legend.narration, /^Legend says/);
assert.deepEqual(one(legend.narration, legend.evidence), []);
assert.deepEqual(one('Some historians think the fabric alone would have burned for 40 hours.', hindenburg.evidence), []);

// 4. No false positive without a doubt in the source: "according to" in the evidence alone is not a marker; a skipped beat is not read.
assert.deepEqual(one('The ship sank in 1912.', ['According to the inquiry, the ship sank in 1912.']), []);
assert.deepEqual(disputedClaimIssues({ beats: [{ skip: true, narration: '', evidence: ['The theory is disputed.'] }] }), []);
assert.equal(one('The ship sank in 1912.', ['A theory holds that the ship sank in 1912.']).length, 1);

// 5. It is part of the prose check the writer's review loop already runs (and the note names the beat).
const beats = Array.from({ length: 4 }, (_, i) => ({ narration: 'The harbour was full of ships and people waiting for news on that grey morning, number ' + i + '.', evidence: i === 1 ? ['The legend says the cow did it.'] : ['It happened.'] }));
assert.ok(proseIssues({ beats }).some(note => /^beat 2: the source calls this uncertain/.test(note)));
console.log('disputed claims: ok');
