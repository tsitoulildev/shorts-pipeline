// Background job: research candidate events until the pool holds TARGET_DAYS of content. Free APIs only.
// A story enters the pool only after: vetting (no living persons, >= 50 years old), licensed footage for every
// beat (footage.js), and all images downloaded with their license record. Rejections are stored with the reason.
const path = require('path');
const config = require('../../config/dark-history-events.json');
const { defaultHttp } = require('./http');
const { fetchArticle } = require('./wikipedia');
const { planFootage } = require('./footage');
const { downloadImage } = require('./commons');
const { vetArticle } = require('./event-vetting');
const { attributionText } = require('./attribution');
const { TARGET_DAYS } = require('./story-pool');

const SKIP_TITLE = /^(list of|category:|template:|timeline of|outline of)/i;

/** Titles from the vetted event list first, then members of the configured Wikipedia categories. */
async function nextCandidates(known, limit, http, categories = config.categories) {
  const out = config.events.filter(t => !known.has(t.toLowerCase())).slice(0, limit);
  for (const category of categories) {
    if (out.length >= limit) break;
    const data = await http.getJson('https://en.wikipedia.org/w/api.php', { action: 'query', format: 'json', formatversion: 2, list: 'categorymembers', cmtitle: `Category:${category}`, cmnamespace: 0, cmlimit: 50 });
    for (const member of data?.query?.categorymembers || []) {
      if (out.length < limit && !known.has(member.title.toLowerCase()) && !SKIP_TITLE.test(member.title) && !out.includes(member.title)) out.push(member.title);
    }
  }
  return out;
}

async function researchOne(title, { pool, http, judge, imageDir, now }) {
  const article = await fetchArticle(title, http);
  const vet = vetArticle(article, now);
  if (!vet.ok) return pool.add({ title, status: 'rejected', articleUrl: article.url, reason: `vetting: ${vet.reason}` });
  const plan = await planFootage(title, { http, judge, article });
  if (!plan.eligible) return pool.add({ title, status: 'rejected', articleUrl: article.url, revisionId: article.revisionId, reason: `footage: ${plan.reason}` });
  const folder = path.join(imageDir, article.title.replace(/[^a-z0-9]+/gi, '_'));
  for (const beat of plan.beats) beat.images = await Promise.all(beat.images.map(image => downloadImage(image, folder, http)));
  return pool.add({
    title, status: 'ready', articleUrl: article.url, revisionId: article.revisionId, shareAlike: plan.shareAlike,
    plan: { title: article.title, extract: article.extract, license: article.license, folder, beats: plan.beats },
    attribution: attributionText(article, plan.beats), reason: vet.reason
  });
}

/**
 * refillPool({ pool, judge, notify, perWeek, imageDir }) -> { researched, ready, days, allowedPerWeek, low }.
 * Researches up to maxAttempts candidates per run (free-quota friendly) and alerts when the pool is low.
 */
async function refillPool({ pool, http = defaultHttp, judge, notify, perWeek, imageDir, maxAttempts = 3, candidates = null, now = new Date(), logger = console }) {
  let researched = 0;
  if ((await pool.status(perWeek)).low) {
    for (const title of candidates || await nextCandidates(await pool.knownTitles(), maxAttempts, http)) {
      researched += 1;
      try {
        await researchOne(title, { pool, http, judge, imageDir, now });
      } catch (error) {
        // a transient failure (network, rate limit) must not mark the event as rejected for good
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
      message: `The Dark History pool holds ${status.ready} stories, ${status.days.toFixed(1)} days at ${perWeek}/week (target ${TARGET_DAYS} days). Cadence is limited to ${status.allowedPerWeek}/week until it refills. The refill job keeps researching; if this persists check the candidate list and the free-LLM quota.`,
      data: { ready: status.ready, days: status.days, allowedPerWeek: status.allowedPerWeek },
      dedupeKey: 'story_pool_low',
      dedupeMinutes: 720
    });
  }
  return { researched, ...status };
}

module.exports = { refillPool, nextCandidates, researchOne };
