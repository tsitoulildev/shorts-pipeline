// A story may enter the pool only if it is clearly history: no living persons, nothing newer than ~50 years.
const MIN_AGE_YEARS = 50;
const ANCIENT = /\b\d{1,4}\s?(AD|BC|BCE|CE)\b|\b\d{1,2}(st|nd|rd|th) century\b/i;

/**
 * { ok, reason } for a fetched Wikipedia article (see wikipedia.js). The FIRST year in the lead is the event's
 * date; at most one later year may be newer than the limit (a restoration, an identification, a memorial).
 * Unknown age is refused, never guessed.
 */
function vetArticle(article, now = new Date()) {
  if (article.categories.some(c => /living people/i.test(c))) return { ok: false, reason: 'article is about a living person' };
  if (article.categories.some(c => /disambiguation/i.test(c))) return { ok: false, reason: 'disambiguation page' };
  const lead = article.extract.slice(0, 1500);
  const years = (lead.match(/\b(1[0-9]{3}|20[0-9]{2})\b/g) || []).map(Number);
  const limit = now.getFullYear() - MIN_AGE_YEARS;
  if (!years.length) return ANCIENT.test(lead) ? { ok: true, reason: 'ancient event (AD/BC/century in lead)' } : { ok: false, reason: 'no year in the lead, age unknown' };
  if (years[0] > limit) return { ok: false, reason: `event year ${years[0]} is newer than ${limit}` };
  const recent = years.filter(y => y > limit).length;
  if (recent > 1) return { ok: false, reason: `lead mentions ${recent} years newer than ${limit}` };
  return { ok: true, reason: `event year ${years[0]}` };
}

module.exports = { vetArticle, MIN_AGE_YEARS };
