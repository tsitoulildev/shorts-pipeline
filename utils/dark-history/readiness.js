// Is there enough material in a story for the writer to succeed? Checked before the writer (a story without it costs LLM calls and a story attempt) and at the pool
// entrance, where the score also orders the stories (richer first). Pure functions, no I/O.
const { sourceSentences, PROMPT_PASSAGE_CHARS } = require('./grounded-writer');

const MIN_SENTENCES_PER_BEAT = 3;  // a beat needs a few whole source sentences to cite
const MIN_RICH_BEATS = 4;          // the writer must narrate at least 4 beats

/** { richBeats, sentences, score, ok, reason }: a beat is rich when its shown passage has 3+ citable sentences and its picture has a caption of its own. */
function storyReadiness(story) {
  const beats = story?.plan?.beats || [];
  let richBeats = 0;
  let sentences = 0;
  for (const beat of beats) {
    const count = sourceSentences(beat.text, PROMPT_PASSAGE_CHARS).length;
    sentences += count;
    const captioned = (beat.images || []).some(image => String(image.title || '').replace(/\.(jpe?g|png|gif|webp|tiff?)$/i, '').trim().length >= 8);
    if (count >= MIN_SENTENCES_PER_BEAT && captioned) richBeats += 1;
  }
  const ok = richBeats >= MIN_RICH_BEATS;
  return {
    richBeats, sentences, ok,
    score: richBeats * 10 + Math.min(sentences, 40) / 4,
    reason: ok ? null : `only ${richBeats} of ${beats.length} beats have ${MIN_SENTENCES_PER_BEAT}+ citable source sentences and a captioned picture (need ${MIN_RICH_BEATS})`
  };
}

module.exports = { storyReadiness, MIN_SENTENCES_PER_BEAT, MIN_RICH_BEATS };
