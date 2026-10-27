// The refill reads ALL members of a category (pages of 500 with cmcontinue), remembers where it stopped, goes into subcategories (depth limited), keeps what it found when
// Wikipedia answers 429, and never asks for more than its request budget. On 2026-10-27 the pool had 0 untouched stories and the refill "researched 0" for days because it read
// only the first 50 members of each category and those were all known.
const assert = require('node:assert/strict');
const { nextCandidates } = require('../utils/dark-history/pool-refill');
const { withBackoff } = require('../utils/dark-history/http');
const config = require('../config/dark-history-events.json');

const titles = (prefix, from, to) => Array.from({ length: to - from + 1 }, (_, i) => `${prefix} ${from + i}`);
const knownSet = list => new Set([...list, ...config.events].map(t => t.toLowerCase()));

/** A fake Wikipedia: categories = { name: { pages: [...], subcats: [...] } }; it honours cmlimit and cmcontinue like the real API. */
function fakeWikipedia(categories, { failAfter = Infinity } = {}) {
  const log = [];
  return {
    log,
    async getJson(url, params) {
      log.push({ category: params.cmtitle, token: params.cmcontinue || null, limit: params.cmlimit });
      if (log.length > failAfter) { const error = new Error('Request failed with status code 429'); error.response = { status: 429 }; throw error; }
      const name = params.cmtitle.replace(/^Category:/, '');
      const category = categories[name] || { pages: [], subcats: [] };
      const members = [...category.subcats.map(s => ({ ns: 14, title: `Category:${s}` })), ...category.pages.map(t => ({ ns: 0, title: t }))];
      const start = Number(params.cmcontinue || 0);
      const end = Math.min(members.length, start + Number(params.cmlimit));
      return { query: { categorymembers: members.slice(start, end) }, ...(end < members.length ? { continue: { cmcontinue: String(end), continue: '-||' } } : {}) };
    }
  };
}
const memoryStore = () => { const data = {}; return { data, get: async key => data[key] ?? null, set: async (key, value) => { data[key] = value; } }; };

(async () => {
  // 1. a category of 1,200 members whose first 700 are already known: the old code (first 50 only) finds nothing, the new one reaches member 701
  const big = { Big: { pages: titles('Event', 1, 1200), subcats: [] } };
  const known = knownSet(titles('Event', 1, 700));
  const store = memoryStore();
  const wiki = fakeWikipedia(big);
  const first = await nextCandidates(known, 5, wiki, ['Big'], { store });
  assert.deepEqual(first, titles('Event', 701, 705), 'the first unknown title is found past the first 50 and the first 500');
  assert.ok(wiki.log.every(call => call.limit >= 500), 'pages of 500, not 50');

  // 2. the next run continues from where the last one stopped: it does not read the first page again, and it hands out the next titles
  const second = fakeWikipedia(big);
  for (const title of first) known.add(title.toLowerCase());
  const next = await nextCandidates(known, 5, second, ['Big'], { store });
  assert.deepEqual(next, titles('Event', 706, 710));
  assert.equal(second.log[0].token, '500', 'the progress (cmcontinue) was kept: the run starts at the second page');
  assert.equal(second.log.length, 1);

  // 3. a category read to the end is marked done; the next category is read
  const two = { Small: { pages: titles('Small', 1, 3), subcats: [] }, Other: { pages: titles('Other', 1, 3), subcats: [] } };
  const store2 = memoryStore();
  const known2 = knownSet([]);
  const w2 = fakeWikipedia(two);
  assert.deepEqual(await nextCandidates(known2, 10, w2, ['Small', 'Other'], { store: store2 }), [...titles('Small', 1, 3), ...titles('Other', 1, 3)]);
  const state = JSON.parse(store2.data.dh_refill_categories);
  assert.equal(state.nodes.Small.done && state.nodes.Other.done, true);

  // 4. subcategories: read after the category, depth limited (depth 2 by default), no loops
  const tree = {
    Root: { pages: ['Root 1'], subcats: ['Child'] },
    Child: { pages: ['Child 1', 'Child 2'], subcats: ['Grandchild', 'Root'] },
    Grandchild: { pages: ['Grand 1'], subcats: ['Deep'] },
    Deep: { pages: ['Deep 1'], subcats: [] }
  };
  const w3 = fakeWikipedia(tree);
  const found = await nextCandidates(knownSet([]), 50, w3, ['Root'], { store: memoryStore() });
  assert.deepEqual(found, ['Root 1', 'Child 1', 'Child 2', 'Grand 1'], 'the child and the grandchild are read, "Deep" (depth 3) and the loop back to Root are not');

  // 5. a 429 in the middle keeps what was found and the progress; the next run goes on
  const store3 = memoryStore();
  const w4 = fakeWikipedia({ A: { pages: titles('A', 1, 600), subcats: [] }, B: { pages: titles('B', 1, 3), subcats: [] } }, { failAfter: 1 });
  const known4 = knownSet(titles('A', 1, 600));
  const partial = await nextCandidates(known4, 5, w4, ['A', 'B'], { store: store3, logger: { warn() {} } });
  assert.deepEqual(partial, [], 'nothing found before the rate limit, and no exception');
  assert.equal(JSON.parse(store3.data.dh_refill_categories).nodes.A.token, '500', 'the page that was read stays read');
  const resumed = await nextCandidates(known4, 5, fakeWikipedia({ A: { pages: titles('A', 1, 600), subcats: [] }, B: { pages: titles('B', 1, 3), subcats: [] } }), ['A', 'B'], { store: store3 });
  assert.deepEqual(resumed, titles('B', 1, 3));

  // 6. the request budget of a run
  const wide = {};
  for (let i = 0; i < 20; i += 1) wide[`Cat${i}`] = { pages: [], subcats: [] };
  const w5 = fakeWikipedia(wide);
  await nextCandidates(knownSet([]), 5, w5, Object.keys(wide), { store: memoryStore(), maxRequests: 7 });
  assert.equal(w5.log.length, 7, 'at most maxRequests requests per run');

  // 7. everything read: nothing more until the sweep restarts (14 days), then it starts again from the first page
  const store4 = memoryStore();
  const known5 = knownSet([]);
  const w6 = fakeWikipedia({ S: { pages: ['S 1'], subcats: [] } });
  const day0 = new Date('2026-11-01T00:00:00Z');
  assert.deepEqual(await nextCandidates(known5, 5, w6, ['S'], { store: store4, now: day0 }), ['S 1']);
  known5.add('s 1');
  assert.deepEqual(await nextCandidates(known5, 5, w6, ['S'], { store: store4, now: new Date(day0.getTime() + 86400000) }), []);
  const w7 = fakeWikipedia({ S: { pages: ['S 1', 'S 2'], subcats: [] } });
  assert.deepEqual(await nextCandidates(known5, 5, w7, ['S'], { store: store4, now: new Date(day0.getTime() + 15 * 86400000) }), ['S 2'], 'after 14 days the sweep starts again and finds the new article');

  // 8. the HTTP client waits and retries on 429 / 5xx (Retry-After respected, capped), not on other errors
  const waits = [];
  let calls = 0;
  const flaky = async () => { calls += 1; if (calls < 3) { const error = new Error('429'); error.response = { status: 429, headers: calls === 1 ? { 'retry-after': '3' } : {} }; throw error; } return 'ok'; };
  assert.equal(await withBackoff(flaky, { sleep: async ms => waits.push(ms) }), 'ok');
  assert.deepEqual(waits, [3000, 4000]);
  await assert.rejects(() => withBackoff(async () => { const error = new Error('404'); error.response = { status: 404 }; throw error; }, { sleep: async () => { throw new Error('must not wait'); } }));
  console.log('refill pagination: ok');
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
