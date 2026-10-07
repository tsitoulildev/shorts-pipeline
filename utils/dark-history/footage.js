// Footage first: a story is eligible only when EVERY beat of its source text has real, license-checked
// images that relate to that beat. No generic filler, no image reused across beats, no AI stand-ins.
const { defaultHttp } = require('./http');
const { fetchArticle, fetchSectionImages } = require('./wikipedia');
const { searchImages, imagesByTitle, licenseRank } = require('./commons');

const STOP = new Set('the a an and or of in on at to for from by with was were is are be been as it its this that these those he she they his her their had has have not but which who whom after before during into over under about than then also one two first last new'.split(' '));
const MIN_SECTION_CHARS = 300;
const MAX_BEAT_CHARS = 1800;
const CANDIDATE_BEATS = 12;

const tokens = text => [...new Set(String(text || '').toLowerCase().match(/[a-z]{4,}/g) || [])].filter(w => !STOP.has(w));

const evenly = (list, max) => (list.length <= max ? list : Array.from({ length: max }, (_, i) => list[Math.round(i * (list.length - 1) / (max - 1))]));

/** Beats = the article's own substantial sections, in order (the outline comes from the source, not from a script). A long section is split into paragraph chunks so short articles still give enough beats. */
function beatsFromArticle(article, { maxBeats = 7 } = {}) {
  const passages = [];
  for (const s of article.sections) {
    if (s.text.length < MIN_SECTION_CHARS) continue;
    if (s.text.length <= MAX_BEAT_CHARS) { passages.push({ heading: s.heading, section: s.heading, text: s.text }); continue; }
    let chunk = '';
    let part = 1;
    for (const paragraph of s.text.split(/\n+/)) {
      chunk += `${chunk ? ' ' : ''}${paragraph}`;
      if (chunk.length >= MIN_SECTION_CHARS * 3) { passages.push({ heading: `${s.heading} (${part++})`, section: s.heading, text: chunk }); chunk = ''; }
    }
    if (chunk.length >= MIN_SECTION_CHARS) passages.push({ heading: `${s.heading} (${part})`, section: s.heading, text: chunk });
  }
  // more passages than beats: sample evenly so the story keeps its beginning, middle and end
  return evenly(passages, maxBeats).map((p, index) => ({ index, ...p, terms: tokens(`${p.heading} ${p.text}`) }));
}

/** Rarer beat terms (present in fewer beats) identify a beat; generic ones ("ship", "crew") barely count. */
function termWeights(beats) {
  const df = new Map();
  beats.forEach(b => b.terms.forEach(t => df.set(t, (df.get(t) || 0) + 1)));
  return t => 1 / (df.get(t) || 1);
}

const PREFILTER = 0.5; // cheap word-overlap screen before the LLM judges a search result

/** Relevance of a file to one beat: weighted term overlap, a hit in the file TITLE counts triple. 0 = not usable for this beat. */
function relevance(candidate, beat, subjectTerms, inArticle, weight) {
  const title = new Set(tokens(candidate.title));
  const rest = new Set(tokens(`${candidate.description} ${candidate.categories.join(' ')}`));
  const subject = subjectTerms.some(t => title.has(t) || rest.has(t));
  if (!(subject || inArticle)) return 0; // must belong to the story...
  let score = 0;
  for (const t of beat.terms) {
    if (subjectTerms.includes(t)) continue;
    if (title.has(t)) score += 3 * weight(t); else if (rest.has(t)) score += weight(t);
  }
  return score >= PREFILTER ? score : 0; // ...and to this beat
}

/** Greedy assignment, scarcest beat first, no image used twice. Per beat: best license first (PD/CC0, CC BY, CC BY-SA), then editor-placed, then score. */
function assign(options, beats, minPerBeat) {
  const used = new Set();
  const result = new Map();
  const ordered = [...beats].sort((a, b) => options.get(a.index).length - options.get(b.index).length);
  for (const beat of ordered) {
    const list = [...options.get(beat.index)].sort((x, y) => licenseRank(x.c.license) - licenseRank(y.c.license) || Number(y.owned) - Number(x.owned) || y.score - x.score);
    const picked = list.filter(o => !used.has(o.c.title)).slice(0, minPerBeat).map(o => ({ ...o.c, owned: o.owned }));
    picked.forEach(c => used.add(c.title));
    result.set(beat.index, picked);
  }
  return result;
}

/**
 * planFootage("Mary Celeste", { judge }) -> { eligible, reason, article, beats:[{heading,text,images}], missing:[heading] }.
 * An image the Wikipedia editors placed inside a section belongs to that section's beats first. Every other
 * image (Commons search) is used only if `judge(beat, candidates)` (free LLM, see relevance-judge.js) approves it;
 * without a judge only editor-placed images count. minPerBeat: images each beat needs; minBeats: shortest story.
 */
async function planFootage(title, { http = defaultHttp, judge = null, article: fetched = null, minBeats = 4, maxBeats = 7, minPerBeat = 1 } = {}) {
  const article = fetched || await fetchArticle(title, http);
  const candidates = beatsFromArticle(article, { maxBeats: CANDIDATE_BEATS });
  if (candidates.length < minBeats) return { eligible: false, reason: `only ${candidates.length} substantial passages (need ${minBeats})`, article, beats: [], missing: [] };

  const subjectTerms = tokens(article.title);
  const weight = termWeights(candidates);
  const sectionFiles = await fetchSectionImages(article.title, http);
  const placed = new Map((await imagesByTitle([...new Set([...sectionFiles.values()].flat())], http)).map(c => [`File:${c.title}`, c]));
  const found = new Map();
  const remember = list => list.forEach(c => found.set(c.title, c));
  remember(await searchImages(article.title, { limit: 40 }, http));

  const options = new Map();
  for (const beat of candidates) {
    const owned = (sectionFiles.get(beat.section) || []).map(f => placed.get(f)).filter(Boolean)
      .map(c => ({ c, owned: true, score: relevance(c, beat, subjectTerms, true, weight) + 5 }));
    let searched = [];
    if (judge) {
      remember(await searchImages(`${article.title} ${beat.terms.filter(t => !subjectTerms.includes(t)).slice(0, 3).join(' ')}`, { limit: 15 }, http));
      const ownedTitles = new Set(owned.map(o => o.c.title));
      const screened = [...found.values()].filter(c => !ownedTitles.has(c.title))
        .map(c => ({ c, score: relevance(c, beat, subjectTerms, false, weight) })).filter(o => o.score > 0)
        .sort((a, b) => b.score - a.score).slice(0, 5);
      const approved = new Set((await judge(beat, screened.map(o => o.c))).map(c => c.title));
      searched = screened.filter(o => approved.has(o.c.title)).map(o => ({ ...o, owned: false }));
    }
    options.set(beat.index, [...owned, ...searched]);
  }

  // Footage decides the outline: passages without relevant licensed images are left out of the story (never filled with stand-ins).
  const assignment = assign(options, candidates, minPerBeat);
  const covered = candidates.filter(b => assignment.get(b.index).length >= minPerBeat);
  const beats = evenly(covered, maxBeats).map(b => ({ heading: b.heading, section: b.section, text: b.text, images: assignment.get(b.index) }));
  const eligible = beats.length >= minBeats;
  return {
    eligible,
    reason: eligible ? `footage found for ${beats.length} beats` : `licensed footage for only ${covered.length} of ${candidates.length} passages (need ${minBeats})`,
    article, beats, missing: candidates.filter(b => !covered.includes(b)).map(b => b.heading),
    shareAlike: beats.some(b => b.images.some(i => licenseRank(i.license) === 2))
  };
}

module.exports = { planFootage, beatsFromArticle, relevance, termWeights, assign, tokens };
