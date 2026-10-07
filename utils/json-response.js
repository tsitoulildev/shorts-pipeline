/**
 * Tolerant JSON extraction for model replies. One implementation for every agent.
 *
 * Handles code fences, prose around the JSON, and replies cut off by the token limit:
 * from a truncated array (or {"key":[...]}) the complete leading elements are kept
 * instead of throwing the whole batch away.
 */

function stripFences(text) {
  return String(text ?? '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

// End index (inclusive) of the JSON value starting at `start`, or -1 if it is cut off.
function endOfValue(text, start) {
  const open = text[start];
  if (open !== '{' && open !== '[') return -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Complete top-level elements of the array opening at `arrayStart`.
function completeElements(text, arrayStart) {
  const items = [];
  let i = arrayStart + 1;
  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i])) i += 1;
    if (i >= text.length || text[i] === ']') break;
    if (text[i] === '{' || text[i] === '[') {
      const end = endOfValue(text, i);
      if (end < 0) break; // cut off mid-element: drop only this one
      try { items.push(JSON.parse(text.slice(i, end + 1))); } catch (_error) { /* skip malformed element */ }
      i = end + 1;
    } else {
      // Scalar element: read to the next comma or closing bracket.
      let j = i;
      while (j < text.length && text[j] !== ',' && text[j] !== ']') j += 1;
      const raw = text.slice(i, j).trim();
      try { items.push(JSON.parse(raw)); } catch (_error) { break; }
      i = j;
    }
  }
  return items;
}

/**
 * @param {string} response raw model text
 * @param {{salvage?: boolean}} [options] salvage (default true) keeps complete elements of a truncated array
 * @returns {*} parsed value; throws when nothing usable is found
 */
function parseJsonResponse(response, options = {}) {
  const text = stripFences(response);
  try {
    return JSON.parse(text);
  } catch (error) {
    const firstError = error;
    const brace = text.indexOf('{');
    const bracket = text.indexOf('[');
    const start = [brace, bracket].filter(index => index >= 0).sort((a, b) => a - b)[0];
    if (start === undefined) throw firstError;

    const end = endOfValue(text, start);
    if (end > 0) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch (_error) { /* try salvage below */ }
    }
    if (options.salvage === false) throw firstError;

    // Truncated reply: keep what is complete.
    if (text[start] === '[') {
      const items = completeElements(text, start);
      if (items.length) return items;
    } else {
      const arrayMatch = /"([A-Za-z_][\w-]*)"\s*:\s*\[/.exec(text.slice(start));
      if (arrayMatch) {
        const arrayStart = start + arrayMatch.index + arrayMatch[0].length - 1;
        const items = completeElements(text, arrayStart);
        if (items.length) return { [arrayMatch[1]]: items, truncated: true };
      }
    }
    throw firstError;
  }
}

module.exports = { parseJsonResponse, stripFences };
