// Background job (hourly): research candidate events while fewer than FRESH_TARGET untouched stories are ready. Free APIs only.
// A story enters the pool only after: vetting (no living persons, >= 50 years old), licensed footage for every
// beat (footage.js), and all images downloaded with their license record. Rejections are stored with the reason.
const path = require('path');
const config = require('../../config/dark-history-events.json');
const { defaultHttp } = require('./http');
const { fetchArticle } = require('./wikipedia');
const { planFootage } = require('./footage');
const { downloadImage } = require('./commons');
const { vetArticle } = require('./event-vetting');
const { pruneNearDuplicates } = require('./dhash');
const { ensureFootageFit } = require('./footage-fit');
const { storyReadiness } = require('./readiness');

// Most stories need no judge call at all (editor-placed images suffice); a story that does needs about 8-12.
const DAILY_LLM_CALLS = 300;
// Untouched stories (never tried) the pool should hold: research goes on while fewer are left, even when the pool as a whole covers the target days
// (stories that already failed once are most of what a "ready" count shows).
const FRESH_TARGET = Number(process.env.DARK_HISTORY_FRESH_TARGET) || 30;
const REFILL_BATCH = Number(process.env.DARK_HISTORY_REFILL_BATCH) || 12; // candidates researched per hourly run (was 8 every 3 hours)
const SKIP_TITLE = /^(list of|category:|template:|timeline of|outline of)/i;

// How much of Wikipedia one run may ask for (Wikimedia asks for polite, serial access): a run stops reading categories after this many requests.
const MAX_REQUESTS_PER_RUN = Number(process.env.DARK_HISTORY_REFILL_MAX_REQUESTS) || 40;
const CATEGORY_PAGE = 500; // members per request (the API maximum for a normal client)
const MAX_SUBCATEGORY_DEPTH = Number(process.env.DARK_HISTORY_REFILL_SUBCATEGORY_DEPTH) || 2;
const MAX_QUEUED_SUBCATEGORIES = 300;
const SWEEP_RESTART_DAYS = 14; // when every category and subcategory has been read to the end, the sweep starts again after this long (new articles appear)
const STATE_KEY = 'dh_refill_categories';

/**
 * Where each category was read up to: { nodes: { name: { token, done, depth } }, queue: [subcategory names found], doneAt }. It lives in the settings table, so
 * every run continues where the last one stopped instead of reading the same first page again.
 */
async function loadState(store) {
  try { return { nodes: {}, queue: [], doneAt: null, ...(JSON.parse(await store.get(STATE_KEY)) || {}) }; } catch (_error) { return { nodes: {}, queue: [], doneAt: null }; }
}

/**
 * Titles from the vetted event list first, then ALL members of the configured Wikipedia categories (a page of 500 at a time, continued with cmcontinue), then the
 * subcategories the categories contain (depth limited). A page is marked as read only when every unknown title on it was handed out; the progress is saved.
 * options: { store: { get(key), set(key, value) }, maxRequests, maxDepth, logger, now }. Without a store nothing is remembered (tests, one-off use).
 */
async function nextCandidates(known, limit, http, categories = config.categories, options = {}) {
  const out = config.events.filter(t => !known.has(t.toLowerCase())).slice(0, limit);
  const store = options.store || null;
  const maxRequests = options.maxRequests || MAX_REQUESTS_PER_RUN;
  const maxDepth = options.maxDepth ?? MAX_SUBCATEGORY_DEPTH;
  const now = options.now || new Date();
  const state = store ? await loadState(store) : { nodes: {}, queue: [], doneAt: null };
  let requests = 0;
  const nodeOf = name => (state.nodes[name] = state.nodes[name] || { token: null, done: false, depth: 0 });
  const roots = categories.map(name => { nodeOf(name); return name; });
  // every category read to the end: the sweep waits SWEEP_RESTART_DAYS and starts again from the first page
  const all = () => [...roots, ...state.queue];
  if (all().every(name => nodeOf(name).done)) {
    if (!state.doneAt) state.doneAt = now.toISOString();
    if (now - new Date(state.doneAt) >= SWEEP_RESTART_DAYS * 86400000) { for (const name of all()) Object.assign(nodeOf(name), { token: null, done: false }); state.doneAt = null; }
  }
  const save = async () => { if (store) await store.set(STATE_KEY, JSON.stringify(state)); };

  for (let index = 0; index < all().length; index += 1) { // the queue grows while subcategories are found
    const name = all()[index];
    if (out.length >= limit || requests >= maxRequests) break;
    const node = nodeOf(name);
    while (!node.done && out.length < limit && requests < maxRequests) {
      let data;
      try {
        requests += 1;
        data = await http.getJson('https://en.wikipedia.org/w/api.php', {
          action: 'query', format: 'json', formatversion: 2, list: 'categorymembers', cmtitle: `Category:${name}`, cmnamespace: '0|14', cmtype: 'page|subcat', cmlimit: CATEGORY_PAGE,
          ...(node.token ? { cmcontinue: node.token } : {})
        });
      } catch (error) {
        // a rate limit or a network error: keep what this run has and the progress so far; the next run goes on from here
        options.logger?.warn?.(`story pool: category "${name}" not read this run: ${error.message}`);
        await save();
        return out;
      }
      const members = data?.query?.categorymembers || [];
      let taken = 0;
      let leftOnPage = false;
      for (const member of members) {
        if (member.ns === 14 || /^Category:/i.test(member.title)) {
          const sub = String(member.title).replace(/^Category:/i, '');
          if (node.depth < maxDepth && !roots.includes(sub) && !state.queue.includes(sub) && state.queue.length < MAX_QUEUED_SUBCATEGORIES) { state.queue.push(sub); nodeOf(sub).depth = node.depth + 1; }
          continue;
        }
        if (known.has(member.title.toLowerCase()) || SKIP_TITLE.test(member.title) || out.includes(member.title)) continue;
        if (out.length < limit) { out.push(member.title); taken += 1; } else leftOnPage = true;
      }
      if (leftOnPage) break; // unread titles remain on this page: stay on it (the known titles are skipped next time)
      const next = data?.continue?.cmcontinue || null;
      if (next) node.token = next; else { node.done = true; node.token = null; }
      void taken;
    }
  }
  await save();
  return out;
}

async function researchOne(title, { pool, http, judge, imageDir, now, visionJudge = null, readImage }) {
  const article = await fetchArticle(title, http);
  const vet = vetArticle(article, now);
  if (!vet.ok) return pool.add({ title, status: 'rejected', articleUrl: article.url, reason: `vetting: ${vet.reason}` });
  const plan = await planFootage(title, { http, judge, article });
  if (!plan.eligible) return pool.add({ title, status: 'rejected', articleUrl: article.url, revisionId: article.revisionId, reason: `footage: ${plan.reason}` });
  const folder = path.join(imageDir, article.title.replace(/[^a-z0-9]+/gi, '_'));
  for (const beat of plan.beats) beat.images = await Promise.all(beat.images.map(image => downloadImage(image, folder, http)));
  // near-duplicate pictures (two photographs of one object) are not allowed in a story: the repeating beat falls, too few left = not eligible
  const distinct = await pruneNearDuplicates(plan.beats, folder);
  if (distinct.beats.length < 4) return pool.add({ title, status: 'rejected', articleUrl: article.url, revisionId: article.revisionId, reason: `footage: only ${distinct.beats.length} distinct pictures after dropping near-duplicates` });
  plan.beats = distinct.beats;
  // Footage fit: every kept beat has a picture that shows something its own passage describes (a vision model looks). A story with fewer than 4
  // such beats is rejected with the reasons; an unavailable vision model throws VISION_UNAVAILABLE (a transient skip: not stored, not rejected).
  let fitted;
  try {
    fitted = await ensureFootageFit({ article_url: article.url, plan: { title: article.title, extract: article.extract, license: article.license, folder, beats: plan.beats } }, { judge: visionJudge, readImage });
  } catch (error) {
    if (error.code === 'STORY_NOT_ELIGIBLE') return pool.add({ title, status: 'rejected', articleUrl: article.url, revisionId: article.revisionId, reason: `footage fit: ${error.message}`.slice(0, 500) });
    throw error;
  }
  const readiness = storyReadiness({ plan: { beats: fitted.plan.beats } });
  if (!readiness.ok) return pool.add({ title, status: 'rejected', articleUrl: article.url, revisionId: article.revisionId, reason: `material: ${readiness.reason}` });
  return pool.add({
    title, status: 'ready', articleUrl: article.url, revisionId: article.revisionId, shareAlike: plan.shareAlike,
    plan: { title: article.title, extract: article.extract, license: article.license, folder, beats: fitted.plan.beats, fit: fitted.plan.fit, richness: readiness.score },
    attribution: fitted.attribution, reason: vet.reason
  });
}

/**
 * refillPool({ pool, judge, notify, perWeek, imageDir }) -> { researched, ready, days, low }.
 * Researches up to maxAttempts candidates per run (free-quota friendly) and alerts when the pool is low.
 */
async function refillPool({ pool, http = defaultHttp, judge, visionJudge = null, readImage, notify, perWeek, imageDir, maxAttempts = REFILL_BATCH, candidates = null, dailyLlmCalls = Number(process.env.DARK_HISTORY_DAILY_LLM_CALLS) || DAILY_LLM_CALLS, now = new Date(), logger = console }) {
  let researched = 0;
  let budgetExhausted = false;
  // free-tier budget: research stops for the day once this many judge calls were spent (the count survives restarts)
  const budgetKey = `dh_llm_calls:${now.toISOString().slice(0, 10)}`;
  let spent = Number(await pool.db.getSetting(budgetKey)) || 0;
  // Both the relevance judge and the vision judge (picture fit) are free-tier calls of the same day: both are counted, and the budget stops the research for the day.
  const counted = fn => fn && (async (...args) => { spent += 1; await pool.db.setSetting(budgetKey, String(spent)); return fn(...args); });
  const countingJudge = counted(judge);
  const countingVision = counted(visionJudge);
  if ((await pool.untouchedCount()) < FRESH_TARGET) {
    for (const title of candidates || await nextCandidates(await pool.knownTitles(), maxAttempts, http, config.categories, { store: { get: key => pool.db.getSetting(key), set: (key, value) => pool.db.setSetting(key, value, 'Dark History refill progress per Wikipedia category') }, logger })) {
      if (spent >= dailyLlmCalls) { budgetExhausted = true; logger.warn?.(`story pool: daily LLM budget (${dailyLlmCalls} calls) spent, research resumes tomorrow`); break; }
      researched += 1;
      try {
        await researchOne(title, { pool, http, judge: countingJudge, imageDir, now, visionJudge: countingVision, readImage });
      } catch (error) {
        // a transient failure (network, rate limit) must not mark the event as rejected for good
        // a title without an article is stored as refused: it is not asked for again at every run
        if (/^Wikipedia: no article text/.test(error.message)) await pool.add({ title, status: 'rejected', reason: 'article not found' });
        logger.warn?.(`story pool: "${title}" skipped this run: ${error.message}`);
      }
    }
  }
  const status = await pool.status(perWeek);
  if (status.low && notify) {
    await notify({
      type: 'story_pool_low',
      level: status.ready === 0 ? 'error' : 'warning',
      title: `Story pool low: ${status.ready} ready (${status.days.toFixed(1)} days)`,
      message: `The Dark History pool holds ${status.ready} ready stories (${status.days.toFixed(1)} days at ${perWeek}/week). The cadence is NOT lowered; only an empty pool makes production wait for the refill. The refill job keeps researching; if this persists check the candidate list and the free-LLM quota.`,
      data: { ready: status.ready, days: status.days },
      dedupeKey: 'story_pool_low',
      dedupeMinutes: 720
    });
  }
  return { researched, budgetExhausted, llmCallsToday: spent, ...status };
}

module.exports = { refillPool, nextCandidates, researchOne };
