// Free-LLM yes/no check: does this image show something the passage actually describes? Fails CLOSED:
// any error, bad JSON or "unsure" means the image is not used (a beat without footage is dropped, never filled).
const { parseJsonResponse } = require('../json-response');

function buildPrompt(beat, candidates) {
  const list = candidates.map((c, i) => `${i + 1}. "${c.title}" - ${c.description.slice(0, 250) || 'no description'}`).join('\n');
  return `You choose illustrations for one passage of a true-story video.

PASSAGE (${beat.heading}):
${beat.text.slice(0, 900)}

CANDIDATE IMAGES (Wikimedia Commons titles and descriptions):
${list}

Return JSON {"relevant":[numbers]} listing ONLY images that plausibly show something this passage describes: the specific people, place, ship, document, object or event it names. A merely related topic, a map of another place, a portrait of someone the passage does not mention, a generic scene or a symbol is NOT relevant. When unsure leave the image out. An empty list is a good answer.`;
}

/** judge = makeLlmJudge(aiTextService); await judge(beat, candidates) -> candidates the model approved. */
function makeLlmJudge(llm) {
  return async function judge(beat, candidates) {
    if (!candidates.length) return [];
    try {
      const reply = await llm.generateText(buildPrompt(beat, candidates), { task: 'packaging', maxTokens: 200, temperature: 0, responseMimeType: 'application/json' });
      const numbers = parseJsonResponse(reply)?.relevant;
      return Array.isArray(numbers) ? numbers.map(n => candidates[Number(n) - 1]).filter(Boolean) : [];
    } catch (_error) {
      return [];
    }
  };
}

module.exports = { makeLlmJudge, buildPrompt };
