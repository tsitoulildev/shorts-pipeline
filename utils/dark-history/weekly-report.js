// Weekly Analytics report for Dark History: views, retention at 40 % of the video and subscribers per Short, and a comparison of the Shorts made with the
// hook-first changes against the baseline of the first weeks. A difference inside the noise is never reported as a success.

// Baseline: the 35 Shorts published 2026-10-10 .. 2026-10-23 that were at least 3 days old on 2026-10-26 (views then, YouTube Analytics). Median 299.
const BASELINE = {
  views: [64, 69, 86, 88, 108, 109, 115, 125, 126, 154, 154, 171, 179, 252, 271, 278, 292, 299, 301, 336, 340, 345, 373, 410, 421, 442, 579, 739, 919, 938, 979, 1002, 1068, 1098, 1261],
  retention40: 0.70, // mean share of the starting audience still watching at 40 % of the video (37 Shorts)
  subscribersPerShort: 7 / 35,
  period: '2026-10-10 to 2026-10-23'
};
const COMPARE_AFTER = 14; // Shorts made with the changes before a verdict is given
const MIN_AGE_DAYS = 3; // Analytics lags and a Short keeps gaining views for days: younger Shorts are listed, not compared
const SIGNIFICANCE = 0.05;

const median = values => {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const mean = values => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

/** Deterministic random numbers (the same report gives the same answer). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Two-sided permutation test on the difference of medians: how often a random split of the same Shorts differs at least as much. */
function permutationP(a, b, iterations = 5000, seed = 7) {
  const observed = Math.abs(median(a) - median(b));
  const all = a.concat(b);
  const random = mulberry32(seed);
  let extreme = 0;
  for (let i = 0; i < iterations; i += 1) {
    for (let j = all.length - 1; j > 0; j -= 1) {
      const k = Math.floor(random() * (j + 1));
      [all[j], all[k]] = [all[k], all[j]];
    }
    if (Math.abs(median(all.slice(0, a.length)) - median(all.slice(a.length))) >= observed) extreme += 1;
  }
  return (extreme + 1) / (iterations + 1);
}

/** verdict for the Shorts made with the changes (their views) against the baseline. */
function compareToBaseline(newViews, baseline = BASELINE.views, needed = COMPARE_AFTER) {
  const base = median(baseline);
  if (newViews.length < needed) return { verdict: 'too early', n: newViews.length, needed, baselineMedian: base, newMedian: median(newViews), p: null };
  const p = permutationP(newViews, baseline);
  const newMedian = median(newViews);
  const verdict = p < SIGNIFICANCE ? (newMedian > base ? 'higher' : 'lower') : 'within the noise';
  return { verdict, n: newViews.length, needed, baselineMedian: base, newMedian, p: Number(p.toFixed(3)) };
}

/** per video: views, engaged views, subscribers gained (one query), and the share still watching at 40 % (one query each). */
async function fetchMetrics(analytics, ids, startDate, endDate) {
  const out = {};
  if (!ids.length) return out;
  const main = await analytics.reports.query({ ids: 'channel==MINE', startDate, endDate, dimensions: 'video', metrics: 'views,engagedViews,subscribersGained', filters: `video==${ids.join(',')}`, maxResults: 200 });
  for (const row of main.data.rows || []) out[row[0]] = { views: row[1], engaged: row[2], subs: row[3], retention40: null };
  for (const id of ids) {
    if (!out[id]) out[id] = { views: 0, engaged: 0, subs: 0, retention40: null };
    try {
      const curve = await analytics.reports.query({ ids: 'channel==MINE', startDate, endDate, dimensions: 'elapsedVideoTimeRatio', metrics: 'audienceWatchRatio', filters: `video==${id}` });
      const at40 = (curve.data.rows || []).find(row => Math.abs(row[0] - 0.4) < 0.006);
      out[id].retention40 = at40 ? at40[1] : null;
    } catch (_error) { out[id].retention40 = null; }
  }
  return out;
}

/**
 * runWeeklyReport({ db, analytics, now }) -> { text, data }. Published Dark History Shorts from the database; `marked` ones were made with the hook-first changes
 * (productions.assets.script.hookFirst). Nothing is written except by the caller.
 */
async function runWeeklyReport({ db, analytics, now = new Date() }) {
  const rows = await db.getAllRows(
    `SELECT ps.youtube_id AS id, ps.published_at AS published, ps.title AS title,
            COALESCE(json_extract(pr.assets, '$.script.hookFirst'), 0) AS marked
     FROM publish_schedule ps LEFT JOIN productions pr ON pr.id = ps.production_id
     WHERE ps.status = 'published' AND ps.youtube_id IS NOT NULL AND ps.published_at >= '2026-10-10T13' ORDER BY ps.published_at`
  );
  if (!rows.length) return { text: 'No published Dark History Short yet.', data: { shorts: 0 } };
  const day = date => new Date(date).toISOString().slice(0, 10);
  const start = day(rows[0].published);
  const end = day(now);
  const metrics = await fetchMetrics(analytics, rows.map(r => r.id), start, end);
  const aged = rows.filter(r => now - new Date(r.published) >= MIN_AGE_DAYS * 86400000).map(r => ({ ...r, ...metrics[r.id] }));
  const week = aged.filter(r => now - new Date(r.published) <= (7 + MIN_AGE_DAYS) * 86400000);
  const marked = aged.filter(r => Number(r.marked) === 1);
  const stats = list => ({ n: list.length, medianViews: median(list.map(r => r.views)), retention40: mean(list.map(r => r.retention40).filter(Number.isFinite)), subsPerShort: list.length ? list.reduce((s, r) => s + (r.subs || 0), 0) / list.length : null });
  const lastWeek = stats(week);
  const changed = stats(marked);
  const verdict = compareToBaseline(marked.map(r => r.views));
  const pct = v => (v === null ? 'n/a' : `${Math.round(v * 100)} %`);
  const num = v => (v === null ? 'n/a' : Number(v.toFixed(2)));
  const text = [
    `Last week (${lastWeek.n} Shorts at least ${MIN_AGE_DAYS} days old): median views ${num(lastWeek.medianViews)}, retention at 40 % ${pct(lastWeek.retention40)}, subscribers per Short ${num(lastWeek.subsPerShort)}.`,
    `Baseline ${BASELINE.period}: median views ${median(BASELINE.views)}, retention at 40 % ${pct(BASELINE.retention40)}, subscribers per Short ${num(BASELINE.subscribersPerShort)}.`,
    verdict.verdict === 'too early'
      ? `Hook-first Shorts: ${verdict.n} of ${verdict.needed} needed so far (median views ${num(verdict.newMedian)}); no verdict yet.`
      : `Hook-first Shorts (${verdict.n}): median views ${num(verdict.newMedian)} against ${verdict.baselineMedian}, retention at 40 % ${pct(changed.retention40)}; permutation test p=${verdict.p} -> ${verdict.verdict === 'within the noise' ? 'within the noise, NOT a success or a failure' : `${verdict.verdict} than the baseline`}.`
  ].join('\n');
  return { text, data: { week: lastWeek, changed, verdict, baseline: { median: median(BASELINE.views), retention40: BASELINE.retention40, subscribersPerShort: BASELINE.subscribersPerShort } } };
}

module.exports = { BASELINE, COMPARE_AFTER, MIN_AGE_DAYS, median, permutationP, compareToBaseline, fetchMetrics, runWeeklyReport };
