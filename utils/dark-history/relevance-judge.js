// Free-LLM yes/no check: does this image show something the passage actually describes? Fails CLOSED:
// any error, bad JSON or "unsure" means the image is not used (a beat without footage is dropped, never filled).
const { parseJsonResponse } = require('../json-response');

// generous: a model that spends part of the budget on hidden reasoning must still be able to finish the JSON
const JUDGE_MAX_TOKENS = 1024;

function buildPrompt(beat, candidates, context = {}) {
  const list = candidates.map((c, i) => `${i + 1}. "${c.title.replace(/\.(jpe?g|png)$/i, '')}" | categories: ${c.categories.filter(Boolean).slice(0, 6).join(', ') || 'none'} | description: ${c.description.slice(0, 250) || 'none'}`).join('\n');
  return `You choose illustrations for one passage of a true-story video about: ${context.subject || 'the story'}.

PASSAGE (${beat.heading}):
${beat.text.slice(0, 900)}

CANDIDATE IMAGES (Wikimedia Commons title, categories, description):
${list}

Return JSON {"relevant":[numbers]} listing ONLY images that plausibly show something this passage describes: the specific people, place, ship, document, object or event it names. The image must show THE STORY'S OWN subject (its place, people, ship, documents, objects, memorials or period illustrations) or something the passage names. An image that only shares a keyword with the passage (an asteroid photo for a meteor-impact story, a stock photo of a boat, a map of another region) is NOT relevant. A merely related topic, a map of another place, a portrait of someone the passage does not mention, a generic scene or a symbol is NOT relevant. When unsure leave the image out. An empty list is a good answer.`;
}

/** judge = makeLlmJudge(aiTextService); await judge(beat, candidates) -> candidates the model approved. */
function makeLlmJudge(llm) {
  return async function judge(beat, candidates, context = {}) {
    if (!candidates.length) return [];
    try {
      const reply = await llm.generateText(buildPrompt(beat, candidates, context), { task: 'packaging', maxTokens: JUDGE_MAX_TOKENS, temperature: 0, responseMimeType: 'application/json' });
      const numbers = parseJsonResponse(reply)?.relevant;
      return Array.isArray(numbers) ? numbers.map(n => candidates[Number(n) - 1]).filter(Boolean) : [];
    } catch (_error) {
      return [];
    }
  };
}

module.exports = { makeLlmJudge, buildPrompt };
