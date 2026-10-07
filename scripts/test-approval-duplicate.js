'use strict';

// Regression: approving a Short from the dashboard re-runs the quality checks on a production that
// already has its own completed generation job. The duplicate_premise gate compared the premise with
// that job and failed every Short with "100% similar" to itself, so nothing could be approved.
// The gate must ignore the production's own job and still block a genuinely similar earlier Short.
const assert = require('assert');
const { OperatorService } = require('../utils/operator-service');

const PREMISE = 'A man vacuuming his empty living room notices the vacuum is pulling in hair that is not on the carpet, but leading up from the floorboards.';

// Minimal stand-in for the generation_jobs query: applies the same "exclude this production" rule
// as the SQL (production id null or different), so the gate sees what the real database would return.
function fakeDb(rows) {
  return {
    getAllRows: async (sql, params = []) => {
      const [excluded] = params;
      return rows.filter(row => excluded == null || row.production_id == null || row.production_id !== excluded);
    }
  };
}

async function duplicateCheck(db, production, options) {
  const operator = new OperatorService(db);
  const result = await operator.runQualityChecks(production, {}, options);
  return result.checks.find(item => item.id === 'duplicate_premise');
}

async function main() {
  const production = { id: 'prod_self', strategy: { topic: PREMISE }, script: { title: 'The Floorboards Are Breathing' } };
  const own = { topic: PREMISE, production_id: 'prod_self' };
  const unrelated = { topic: 'A night guard hears the elevator stop on a floor that does not exist in the building.', production_id: 'prod_other' };

  // 1. Approval path: no options. The Short's own completed job must not count as a duplicate.
  const approval = await duplicateCheck(fakeDb([own, unrelated]), production);
  assert.ok(approval, 'duplicate_premise check missing');
  assert.strictEqual(approval.passed, true, `a Short must not be a duplicate of itself: ${approval.message}`);

  // 2. A genuinely similar earlier Short by a different production still blocks.
  const earlier = { topic: PREMISE, production_id: 'prod_earlier' };
  const blocked = await duplicateCheck(fakeDb([own, earlier]), production);
  assert.strictEqual(blocked.passed, false, 'a similar earlier Short must still be rejected');
  assert.match(blocked.message, /too similar/);

  // 3. The pre-upload path (explicit option) behaves the same as the default.
  const preUpload = await duplicateCheck(fakeDb([own, unrelated]), production, { excludeProductionId: 'prod_self' });
  assert.strictEqual(preUpload.passed, true, preUpload.message);

  // 4. A production without an id (not yet stored) excludes nothing and is still checked.
  const unsaved = await duplicateCheck(fakeDb([earlier]), { strategy: { topic: PREMISE } });
  assert.strictEqual(unsaved.passed, false, 'an unsaved production must still be compared with completed Shorts');

  console.log('Approval duplicate check: PASS');
}

main().catch(error => { console.error(error); process.exit(1); });
