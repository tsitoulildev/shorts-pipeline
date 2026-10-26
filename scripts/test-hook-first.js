// Retention changes (first 3-9 seconds): a hook that only defines or credits its subject is flagged, the beat-1 rewrite sees the article lead, the title is wrapped for the
// first frame, and the pool puts stories on watched themes first without losing variety. The sentences are the real first sentences of 35 published Shorts.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { weakHook, proseIssues, buildPrompt, buildBeatPrompt, HOOK_RULE } = require('../utils/dark-history/grounded-writer');
const { wrapTitle, titleCardFilter, TITLE_SECONDS } = require('../utils/dark-history/documentary-render');
const { Database } = require('../database/db');
const { StoryPool } = require('../utils/dark-history/story-pool');

const WEAK = [
  'HMS Cambrian was a Royal Navy 40-gun frigate launched in 1797.',
  'The Teatro Yaguez is a historic building operating as a performing arts theater.',
  'Pelayo was a battleship of the Spanish Navy.',
  'USS Brooklyn was the lead ship of a nine-cruiser class.',
  'Audacious was the fourth King George V-class dreadnought built in the early 1910s.',
  'The programme was directed by Group Captain Peregrine Fellowes.'
];
const STRONG = [
  "A medieval man's body, preserved in a Swedish peat bog, was found in 1936.",
  'Damendorf Man was found on 28 May 1900 in a German bog.',
  'Trinity was the first nuclear weapon detonation, by the U.S. Army at 5:29 a.m.',
  'Grauballe Man, an Iron Age bog body, was found on 26 April 1952.',
  'In 1928, this dam failed, killing at least 431 people.',
  'The fire destroyed most of Smyrna in September 1922.',
  'Piltdown Man was a fraud presenting bone fragments as a new early human.'
];
WEAK.forEach(sentence => assert.equal(weakHook(sentence), true, `weak: ${sentence}`));
STRONG.forEach(sentence => assert.equal(weakHook(sentence), false, `strong: ${sentence}`));

// the review note: it names beat 1 (so only beat 1 is rewritten) and costs one prose point, like any other prose note
const script = hook => ({ beats: [hook, 'A second beat that says something plain about the place and the day.', 'A third beat that adds one more thing the sources state clearly.', 'A fourth beat that ends on what is still not known today.']
  .map(narration => ({ narration, images: [{}] })) });
const weakNotes = proseIssues(script(WEAK[0] + ' It served for years in the fleet.')).filter(note => /^beat 1: the hook only defines/.test(note));
assert.equal(weakNotes.length, 1);
assert.equal(proseIssues(script(STRONG[0] + ' It was kept in a museum.')).filter(note => /hook only defines/.test(note)).length, 0);

// the prompts carry the rule; the beat-1 rewrite is shown the article lead (it may cite L.n), a rewrite of another beat is not
const story = { plan: { title: 'X', extract: 'Lead one is a plain sentence about the thing. Lead two states what was found there.', beats: [1, 2, 3, 4].map(n => ({ heading: 'h' + n, text: 'Passage sentence number one is here. Passage sentence number two is here.', images: [{ title: 'Pic.jpg' }] })) } };
assert.ok(buildPrompt(story, null).includes(HOOK_RULE));
const previous = { beats: [1, 2, 3, 4].map(n => ({ narration: 'Old narration of beat ' + n + ' is here today.', evidenceIds: [n + '.1'] })) };
const one = buildBeatPrompt(story, new Set([1]), { notes: ['beat 1: the hook only defines'] }, previous, []);
assert.ok(one.includes('[L.2] ') && one.includes('Open on the unusual event'), 'beat 1 sees the lead and the rule');
const two = buildBeatPrompt(story, new Set([2]), { notes: ['beat 2: too thin'] }, previous, []);
assert.ok(!two.includes('[L.2] ') && !two.includes('Open on the unusual event'));

// the title on the first frame
assert.deepEqual(wrapTitle('Bocksten Man: Medieval Bog Body Discovered'), ['Bocksten Man:', 'Medieval Bog Body', 'Discovered']);
assert.deepEqual(wrapTitle('Imperial Trans-Antarctic Expedition: From Endurance to Survival and Rescue'), ['Imperial', 'Trans-Antarctic', 'Expedition']);
assert.deepEqual(wrapTitle(''), []);
const card = titleCardFilter('/tmp/title.txt');
assert.ok(card.includes('fontsize=96') && card.includes(`enable='lt(t,${TITLE_SECONDS})'`), 'a big title that goes after TITLE_SECONDS');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-pool-'));
  const db = new Database();
  db.dbPath = path.join(dir, 'test.db');
  await db.initialize();
  const pool = new StoryPool(db);
  const add = (title, richness, extract = 'A plain article about a ship.') => pool.add({ title, status: 'ready', plan: { title, extract, beats: [], richness }, attribution: 'x' });
  await add('Ship A', 50);
  await add('Ship B', 40);
  await add('Bog Man One', 10, 'A bog body was found in a peat bog.');
  await add('Tomb Two', 5, 'An archaeological excavation of a tomb.');
  await add('Ship C', 30);
  // fewest failed attempts still comes first: a themed story with a failed attempt does not jump ahead
  await db.executeQuery("UPDATE story_pool SET attempts = 1 WHERE title = 'Tomb Two'");
  const order = [];
  for (let i = 0; i < 5; i += 1) { const row = await pool.claimNext(); order.push(row.title); await new Promise(r => setTimeout(r, 1100)); }
  assert.equal(order[0], 'Bog Man One', 'a themed story with no failed attempt goes first');
  assert.equal(order[1], 'Ship A', 'then the usual order (richness)');
  assert.deepEqual(order.slice(2), ['Ship B', 'Ship C', 'Tomb Two'], 'a story with a failed attempt waits for the fresh ones');
  // variety: after two themed Shorts in the last three, the next one is not themed even if a themed story is waiting
  const db2 = new Database();
  db2.dbPath = path.join(dir, 'test2.db');
  await db2.initialize();
  const pool2 = new StoryPool(db2);
  const add2 = (title, richness, extract) => pool2.add({ title, status: 'ready', plan: { title, extract, beats: [], richness }, attribution: 'x' });
  await add2('Mummy One', 5, 'A mummy.'); await add2('Skeleton Two', 4, 'A skeleton.'); await add2('Mystery Three', 3, 'An unsolved mystery.'); await add2('Plain', 90, 'A plain article.');
  const seq = [];
  for (let i = 0; i < 4; i += 1) { seq.push((await pool2.claimNext()).title); await new Promise(r => setTimeout(r, 1100)); }
  assert.deepEqual(seq.slice(0, 2), ['Mummy One', 'Skeleton Two']);
  assert.equal(seq[2], 'Plain', 'variety: not a third themed Short in a row');
  console.log('hook first: ok');
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
