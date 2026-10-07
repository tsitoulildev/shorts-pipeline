// Creative review: heuristics, AI critic merge, rewrite loop and stored-evidence recheck.
const assert = require('node:assert/strict');
const review = require('../utils/creative-review');

const script = (hook, beats) => ({
  hook,
  mainContent: { sections: beats.map(text => ({ content: [text] })) },
  metadata: {}
});
script.fullText = s => [s.hook, ...s.mainContent.sections.map(x => x.content[0])].join(' ');
const withFull = s => ({ ...s, fullScript: script.fullText(s) });

const GOOD = withFull(script('The knocking inside my wall used my name.', [
  'It started at 3:07 every night. Three soft taps, then a pause, like someone checking I was awake.',
  'I taped a recorder to the plaster. Playback gave me my own voice, whispering the taps back.',
  'I stopped answering. The knocks moved to the wardrobe, then to the bed frame beneath me.',
  'This morning the plaster had a handprint on my side. The fingers were still warm.'
]));

const BAD = withFull(script('Hey guys, today I want to tell you a really strange story', [
  'Something weird happened to me and it was creepy, because something was in the house.',
  'Suddenly something strange appeared; it was terrifying and scary and weird.',
  'Little did I know, the call was coming from inside the house, because it was all a dream.',
  'I never saw him again, and that is why, to this day, I still wonder about the whole strange thing happening.'
]));

async function main() {
  // 1. Heuristics separate a specific script from a clichéd, vague one.
  const good = review.heuristicReview(GOOD);
  const bad = review.heuristicReview(BAD);
  assert.ok(good.overall >= review.MIN_OVERALL, `good script scored ${good.overall}: ${good.notes.join(' | ')}`);
  assert.ok(bad.overall < review.MIN_OVERALL, `bad script scored ${bad.overall}`);
  assert.equal((await review.reviewScript({ script: BAD })).passed, false, 'a cliched, vague script must be rejected even without AI');
  assert.equal((await review.reviewScript({ script: GOOD })).passed, true, 'a specific script must pass without AI');
  assert.ok(bad.scores.hook < review.FLOORS.hook && bad.scores.twist < review.FLOORS.twist);
  assert.ok(bad.notes.some(note => /cliche/i.test(note)) && bad.notes.some(note => /vague/i.test(note)) && bad.notes.some(note => /filler/i.test(note)));

  // 2. Cross-video template reuse is caught (the deterministic-fallback weakness).
  const templated = withFull(script('Something was wrong with the hallway light.', [
    'The hallway light hummed at night. Then it blinked when they moved.',
    'The pattern did not stop when they froze. The last frame held on the impossible detail.',
    'Now the safe distance between them and it was gone. Nothing else changed, which made the pattern impossible to dismiss.',
    'The detail from the opening looked deliberate. The silence after it changed felt more threatening than the sound.'
  ]));
  const previous = [
    'The pattern did not stop when they froze. The last frame held on the impossible detail. Now the safe distance between them and it was gone.',
    'Nothing else changed, which made the pattern impossible to dismiss. The silence after it changed felt more threatening than the sound.'
  ];
  const fresh = review.heuristicReview(templated, []);
  const reused = review.heuristicReview(templated, previous);
  assert.ok(reused.sharedSentences >= 3 && reused.scores.repetition < fresh.scores.repetition);
  const reusedVerdict = await review.reviewScript({ script: templated, history: previous });
  assert.equal(reusedVerdict.passed, false, 'template reuse must fail the originality floor');
  assert.ok(reusedVerdict.failures.some(item => /originality/.test(item)));

  // 3. AI critic: the harsher judge counts; broken or failing critics degrade to heuristics.
  const critic = payload => ({ isAvailable: () => true, generateText: async () => payload });
  const harsh = await review.reviewScript({ script: GOOD, aiText: critic(JSON.stringify({
    scores: { hook: 4, tension: 8, twist: 8, originality: 8, visualizability: 8, voice: 8 },
    weaknesses: ['The hook is passive'], rewriteNotes: 'Open on the name being knocked.'
  })) });
  assert.equal(harsh.passed, false);
  assert.equal(harsh.source, 'ai+heuristic');
  assert.ok(harsh.notes.some(note => /name being knocked/.test(note)));
  const kind = await review.reviewScript({ script: GOOD, aiText: critic('```json\n' + JSON.stringify({
    scores: { hook: 8, tension: 8, twist: 8, originality: 8, visualizability: 8, voice: 8 }, weaknesses: [], rewriteNotes: ''
  }) + '\n```') });
  assert.equal(kind.passed, true, kind.failures.join('; '));
  const garbage = await review.reviewScript({ script: GOOD, aiText: critic('not json') });
  assert.equal(garbage.source, 'heuristic-only');
  assert.ok(garbage.aiError);
  const broken = await review.reviewScript({ script: GOOD, aiText: { isAvailable: () => true, generateText: async () => { throw new Error('quota'); } } });
  assert.equal(broken.source, 'heuristic-only');
  assert.match(broken.aiError, /quota/);
  const outOfRange = await review.reviewScript({ script: GOOD, aiText: critic(JSON.stringify({ scores: { hook: 99, tension: 8, twist: 8, originality: 8, visualizability: 8, voice: 8 } })) });
  assert.equal(outOfRange.source, 'heuristic-only', 'out-of-range scores must be ignored');

  // 4. Rewrite loop: notes reach the writer, the improved draft wins, evidence is attached.
  const briefs = [];
  const drafts = [BAD, GOOD];
  const accepted = await review.reviewedScriptLoop({
    write: async brief => { briefs.push(brief); return { ...drafts[Math.min(briefs.length - 1, 1)] }; },
    review: s => review.reviewScript({ script: s })
  });
  assert.equal(briefs[0], null);
  assert.match(briefs[1], /scored .*\/10/);
  assert.match(briefs[1], /cliche/i);
  assert.equal(accepted.metadata.creativeReview.revisions, 1);
  assert.equal(accepted.metadata.creativeReview.attempts.length, 2);
  assert.equal(accepted.metadata.creativeReview.passed, true);

  // 5. Fail closed: never passes -> rejected after the bounded attempts; identical rewrite -> early stop.
  let calls = 0;
  await assert.rejects(review.reviewedScriptLoop({
    write: async () => { calls += 1; return withFull(script(`Hey today I tell you story number ${calls}`, [`Something strange ${calls}.`, 'Something weird happened.', 'Suddenly something creepy.', 'It was all a dream.'])); },
    review: s => review.reviewScript({ script: s }),
    maxRevisions: 2
  }), { code: 'CREATIVE_REVIEW_REJECTED' });
  assert.equal(calls, 3, 'bounded to the first draft plus two revisions');
  let same = 0;
  await assert.rejects(review.reviewedScriptLoop({
    write: async () => { same += 1; return { ...BAD }; },
    review: s => review.reviewScript({ script: s }),
    maxRevisions: 2
  }), error => {
    assert.equal(error.code, 'CREATIVE_REVIEW_REJECTED');
    // The alert must say why only two attempts happened, not just the best draft's score.
    assert.match(error.message, /after 2 attempt\(s\)/);
    assert.match(error.message, /#1 [\d.]+\/10/);
    assert.match(error.message, /#2 [\d.]+\/10 rewrite produced the identical script/);
    return true;
  });
  assert.equal(same, 2, 'an identical rewrite stops the loop');

  // 6. Stored evidence: missing, failed and forged evidence are all rejected.
  assert.equal(review.evaluateStoredReview(GOOD).passed, false);
  assert.equal(review.evaluateStoredReview(accepted).passed, true);
  const forged = { ...BAD, metadata: { creativeReview: { passed: true, overall: 9, source: 'ai+heuristic', revisions: 0 } } };
  assert.equal(review.evaluateStoredReview(forged).passed, false, 'metadata alone must not pass a weak script');
  assert.equal(review.evaluateStoredReview({ ...accepted, metadata: { creativeReview: { ...accepted.metadata.creativeReview, passed: false } } }).passed, false);

  console.log('Creative review: PASS');
}

main().catch(error => { console.error(error); process.exit(1); });
