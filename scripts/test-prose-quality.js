// Offline: the editor's heuristics catch run-on, padded narration (the 2026-10-05 22:00 "Midnight Gauge" draft passed with 7.86).
const assert = require('assert');
const review = require('../utils/creative-review');

const script = beats => ({ hook: { text: 'At midnight my tire gauge read negative four pounds.' }, mainContent: { sections: beats.map(content => ({ content: [content] })) } });

const bad = script([
  'I press the blue digital gauge against the flat tire, the lamp sputters, cold night air brushes my shoulders quietly and the numbers flicker on the display.',
  'The LCD flickers, numbers tumble down, thirty‑two fades, passes zero, then plunges to negative four, the display humming low softly.',
  'The tire bulges, swelling outward without a hiss, rubber stretching thin, a ghostly glow tracing its expanding surface in silent.'
]);
const good = script([
  'I press the gauge against the flat tire. The numbers drop to zero.',
  'Then they keep going. Minus one. Minus two. The tire does not hiss.',
  'It breathes in. My headlights bend toward the valve.'
]);

const b = review.heuristicReview(bad);
const g = review.heuristicReview(good);
assert.ok(b.scores.voice <= 6, `padded run-on narration is penalised (voice ${b.scores.voice})`);
assert.ok(b.notes.some(n => /run past 24 words/.test(n)), 'run-on note is given to the writer');
assert.ok(b.notes.some(n => /Filler adverbs/.test(n)), 'filler adverb note is given to the writer');
assert.ok(b.notes.some(n => /Unusual characters/.test(n)), 'non-breaking hyphen note is given to the writer');
assert.ok(g.scores.voice >= 9, `clean short sentences keep a high voice score (voice ${g.scores.voice})`);
console.log('Prose quality: PASS');

// Narration must not name the art style (seen 2026-10-06: "Another stickman stood directly behind me").
(() => {
  const assert = require('assert');
  const { heuristicReview } = require('../utils/creative-review');
  const make = last => ({
    hook: 'The smoke detector chirped once for every person in the room.',
    mainContent: { sections: [{ content: 'I stood alone in my hallway at two in the morning.' }, { content: 'The detector chirped again.' }, { content: last }] }
  });
  const leaky = heuristicReview(make('Another stickman stood directly behind me.'));
  const clean = heuristicReview(make('Another man stood directly behind me.'));
  assert.ok(leaky.scores.voice < clean.scores.voice, 'stickman leak must lower the voice score');
  assert.ok(leaky.notes.some(n => /art style/.test(n)));
  console.log('narration-leak test passed');
})();
