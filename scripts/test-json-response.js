const assert = require('assert');
const { parseJsonResponse } = require('../utils/json-response');

assert.deepStrictEqual(parseJsonResponse('{"a":1}'), { a: 1 });
assert.deepStrictEqual(parseJsonResponse('```json\n{"a":[1,2]}\n```'), { a: [1, 2] });
assert.deepStrictEqual(parseJsonResponse('Here you go:\n{"a":"x}"} thanks'), { a: 'x}' });
assert.deepStrictEqual(parseJsonResponse('noise [1,2,3] noise'), [1, 2, 3]);

// Truncated {"candidates":[...]} keeps the complete candidates (the real failure: cut at the token limit).
const cut = '{"candidates":[{"topic":"a","tags":["x","y"]},{"topic":"b \\"q\\" {","n":2},{"topic":"c","tags":["x",';
const salvaged = parseJsonResponse(cut);
assert.strictEqual(salvaged.candidates.length, 2);
assert.strictEqual(salvaged.candidates[1].topic, 'b "q" {');
assert.strictEqual(salvaged.truncated, true);

// Truncated bare array.
assert.deepStrictEqual(parseJsonResponse('[{"a":1},{"a":2},{"a":'), [{ a: 1 }, { a: 2 }]);

// Nothing complete or no JSON: still an error (never a silent empty success).
assert.throws(() => parseJsonResponse('{"candidates":[{"topic":"cut'));
assert.throws(() => parseJsonResponse('no json here'));
assert.throws(() => parseJsonResponse(cut, { salvage: false }));
assert.throws(() => parseJsonResponse(''));
console.log('JSON response tests passed');
