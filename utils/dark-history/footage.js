// Footage first: a story is eligible only when EVERY beat of its source text has real, license-checked
// images that relate to that beat. No generic filler, no image reused across beats, no AI stand-ins.
const { defaultHttp } = require('./http');
const { fetchArticle, fetchSectionImages } = require('./wikipedia');
const { searchImages, imagesByTitle, licenseRank } = require('./commons');

const STOP = new Set('the a an and or of in on at to for from by with was were is are be been as it its this that these those he she they his her their had has have not but which who whom after before during into over under about than then also one two first last new'.split(' '));
const MIN_SECTION_CHARS = 300;
const MAX_BEAT_CHARS = 1800;
const CANDIDATE_BEATS = 12;
const SPLIT_BELOW = 6; // fewer sections than this: split long sections into chunks
// words of an article title that say what KIND of story it is, not what it is about ("Tunguska event" -> tunguska)
const GENERIC_SUBJECT = new Set('incident event events disaster murders murder massacre expedition great sinking wreck case colony fire flood'.split(' '));

const tokens = text => [...new Set(String(text || '').toLowerCase().match(/[a-z]{4,}/g) || [])].filter(w => !STOP.has(w));

const evenly = (list, max) => (list.length <= max ? list : Array.from({ length: max }, (_, i) => list[Math.round(i * (list.length - 1) / (max - 1))]));

/**
 * Beats = the article's own substantial sections, in order (the outline comes from the source, not from a script).
 * A section stays ONE beat so its editor-placed images belong to it alone; only an article with few sections has its
 * longest sections split into paragraph chunks (otherwise two chunks of one section would fight over the same image).
 */
function beatsFromArticle(article, { maxBeats = CANDIDATE_BEATS } = {}) {
  let passages = article.sections.filter(s => s.text.length >= MIN_SECTION_CHARS).map(s => ({ heading: s.heading, section: s.heading, text: s.text }));
  if (passages.length < SPLIT_BELOW) {
    passages = passages.flatMap(p => {
      if (p.text.length <= MAX_BEAT_CHARS) return [p];
      const chunks = [];
      let chunk = '';
      for (const paragraph of p.text.split(/\n+/)) {
        chunk += `${chunk ? ' ' : ''}${paragraph}`;
        if (chunk.length >= MIN_SECTION_CHARS * 3) { chunks.push(chunk); chunk = ''; }
      }
      if (chunk.length >= MIN_SECTION_CHARS) chunks.push(chunk);
      return chunks.map((text, i) => ({ heading: `${p.heading} (${i + 1})`, section: p.section, text }));
    });
  }
  // more passages than beats: sample evenly so the story keeps its beginning, middle and end
  return evenly(passages, maxBeats).map((p, index) => ({ index, ...p, terms: tokens(`${p.heading} ${p.text.slice(0, 1200)}`) }));
}

/** Rarer beat terms (present in fewer beats) identify a beat; generic ones ("ship", "crew") barely count. */
function termWeights(beats) {
  const df = new Map();
  beats.forEach(b => b.terms.forEach(t => df.set(t, (df.get(t) || 0) + 1)));
  return t => 1 / (df.get(t) || 1);
}

// An image is marked LOW CONFIDENCE (the contact sheet shows it) when it was kept mostly because of where it sits or what was left:
const LOW_LEXICAL = 1.0; // almost no word overlap with the beat; kept only because the editors placed it in the section
const AMBIGUOUS_RATIO = 0.5; // a runner-up scoring at least half as well: the choice between them is a coin flip
const PREFILTER = 0.5; // cheap word-overlap screen before the LLM judges a search result

/**
 * Relevance of a file to one beat: weighted term overlap, a hit in the file TITLE counts triple. 0 = not usable for this beat.
 * An image the editors did not place must name the story's subject in its TITLE or Commons CATEGORIES (a description that
 * merely mentions it is not enough: "Asteroids in Hubble Frontier Field Abell 370" mentions a meteor, not Tunguska).
 */
function relevance(candidate, beat, subjectTerms, inArticle, weight) {
  const title = new Set(tokens(candidate.title));
  const categories = new Set(tokens(candidate.categories.join(' ')));
  const rest = new Set(tokens(candidate.description));
  if (!inArticle && !subjectTerms.some(t => title.has(t) || categories.has(t))) return 0; // must belong to the story...
  let score = 0;
  for (const t of beat.terms) {
    if (subjectTerms.includes(t)) continue;
    if (title.has(t)) score += 3 * weight(t); else if (categories.has(t) || rest.has(t)) score += weight(t);
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
    const free = list.filter(o => !used.has(o.c.title));
    const picked = free.slice(0, minPerBeat).map(o => ({ ...o.c, owned: o.owned, lexical: o.lexical ?? o.score, alternatives: free.slice(minPerBeat).map(x => ({ title: x.c.title, lexical: x.lexical ?? x.score })) }));
    picked.forEach(c => used.add(c.title));
    result.set(beat.index, picked);
  }
  return result;
}

/** Confidence of one chosen image, with the reasons in plain words (shown on the contact sheet). */
function withConfidence(image, sectionFileTitles, rejectedByTitle) {
  const notes = [];
  if (image.owned && image.lexical < LOW_LEXICAL) notes.push(`almost no word overlap with this passage (score ${image.lexical.toFixed(2)}); kept because the Wikipedia editors placed it in this section`);
  const rival = image.alternatives[0];
  if (rival && rival.lexical > 0 && rival.lexical >= AMBIGUOUS_RATIO * image.lexical) notes.push(`close call: "${rival.title}" scored ${rival.lexical.toFixed(2)} vs ${image.lexical.toFixed(2)}`);
  const lost = sectionFileTitles.map(f => [f, rejectedByTitle.get(f)]).filter(([, reason]) => reason && !/^mime|junk/.test(reason));
  if (image.owned && lost.length && !rival) notes.push(`the only image left in the section after the others were rejected (${lost.map(([f, r]) => `${f.replace(/^File:/, '')}: ${r}`).join('; ')})`);
  const { alternatives: _alternatives, ...rest } = image;
  return { ...rest, confidence: notes.length ? 'low' : 'high', confidenceNotes: notes };
}

/** Images that were available for this beat but are not in it, each with the reason. Icons/vector files are only counted. */
function unusedFor(beat, chosen, assignment, candidates, sectionFiles, rejectedByTitle, diagnostics) {
  const chosenTitles = new Set(chosen.map(i => i.title));
  const items = [];
  let ignoredIcons = 0;
  for (const file of sectionFiles.get(beat.section) || []) {
    const title = file.replace(/^File:/, '');
    if (chosenTitles.has(title)) continue;
    const rejected = rejectedByTitle.get(file);
    if (rejected) {
      if (/^mime|junk/.test(rejected)) ignoredIcons += 1; else items.push({ title, reason: `rejected before ranking: ${rejected}` });
      continue;
    }
    const holder = candidates.find(c => c.index !== beat.index && assignment.get(c.index).some(i => i.title === title));
    items.push({ title, reason: holder ? `already used by beat "${holder.heading}" (an image is never used twice)` : `not chosen: the beat keeps one image and "${chosen[0]?.title}" ranked higher (license, then word overlap)` });
  }
  const note = diagnostics.find(d => d.heading === beat.heading);
  for (const title of note?.screenedRejected || []) items.push({ title, reason: 'LLM judge said it does not show what this passage describes' });
  for (const title of (note?.approved || []).filter(t => !chosenTitles.has(t))) items.push({ title, reason: 'approved by the judge but ranked lower than the chosen image' });
  return { items, ignoredIcons };
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

  const subjectTerms = tokens(article.title).filter(t => !GENERIC_SUBJECT.has(t));
  const weight = termWeights(candidates);
  const sectionFiles = await fetchSectionImages(article.title, http);
  const rejectedFiles = [];
  const placed = new Map((await imagesByTitle([...new Set([...sectionFiles.values()].flat())], http, rejectedFiles)).map(c => [`File:${c.title}`, c]));
  const rejectedByTitle = new Map(rejectedFiles.map(r => [`File:${r.title}`, r.reason]));
  const found = new Map();
  const remember = list => list.forEach(c => found.set(c.title, c));
  remember(await searchImages(article.title, { limit: 40 }, http));

  const options = new Map();
  const diagnostics = [];
  for (const beat of candidates) {
    const owned = (sectionFiles.get(beat.section) || []).map(f => placed.get(f)).filter(Boolean)
      .map(c => { const lexical = relevance(c, beat, subjectTerms, true, weight); return { c, owned: true, lexical, score: lexical + 5 }; });
    let searched = [];
    const note = { heading: beat.heading, ownedTitles: owned.map(o => o.c.title), screened: [], approved: [] };
    // the LLM is asked only when editors placed too few images in this section (saves free-tier calls)
    if (judge && owned.length < minPerBeat) {
      remember(await searchImages(`${article.title} ${beat.terms.filter(t => !subjectTerms.includes(t)).slice(0, 3).join(' ')}`, { limit: 15 }, http));
      const ownedTitles = new Set(owned.map(o => o.c.title));
      const screened = [...found.values()].filter(c => !ownedTitles.has(c.title))
        .map(c => ({ c, score: relevance(c, beat, subjectTerms, false, weight) })).filter(o => o.score > 0)
        .sort((a, b) => b.score - a.score).slice(0, 5);
      const approved = new Set((await judge(beat, screened.map(o => o.c), { subject: article.title })).map(c => c.title));
      note.screened = screened.map(o => o.c.title);
      note.approved = [...approved];
      searched = screened.filter(o => approved.has(o.c.title)).map(o => ({ ...o, owned: false, lexical: o.score }));
      note.screenedRejected = screened.filter(o => !approved.has(o.c.title)).map(o => o.c.title);
    }
    diagnostics.push(note);
    options.set(beat.index, [...owned, ...searched]);
  }

  // Footage decides the outline: passages without relevant licensed images are left out of the story (never filled with stand-ins).
  const assignment = assign(options, candidates, minPerBeat);
  const covered = candidates.filter(b => assignment.get(b.index).length >= minPerBeat);
  const beats = evenly(covered, maxBeats).map(b => {
    const images = assignment.get(b.index).map(image => withConfidence(image, sectionFiles.get(b.section) || [], rejectedByTitle));
    return { heading: b.heading, section: b.section, text: b.text, images, unused: unusedFor(b, images, assignment, candidates, sectionFiles, rejectedByTitle, diagnostics) };
  });
  const eligible = beats.length >= minBeats;
  return {
    eligible,
    reason: eligible ? `footage found for ${beats.length} beats` : `licensed footage for only ${covered.length} of ${candidates.length} passages (need ${minBeats})`,
    article, beats, missing: candidates.filter(b => !covered.includes(b)).map(b => b.heading), diagnostics,
    shareAlike: beats.some(b => b.images.some(i => licenseRank(i.license) === 2))
  };
}

module.exports = { planFootage, withConfidence, beatsFromArticle, relevance, termWeights, assign, tokens };
