'use strict';

// Regression: a Short that passed every quality gate while human approval is required must wait
// for review. It must never be reported as "rejected by automated quality gates" nor fail its job,
// because the pacing gate only counts completed jobs and would keep generating new Shorts.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const index = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const stage = index.slice(index.indexOf("runGenerationStage(jobId, 'quality_review'"));
assert.ok(stage.length > 0, 'quality_review stage not found');

const rejection = stage.indexOf("type: 'content_rejected'");
assert.ok(rejection > 0, 'content_rejected notification not found');
const guard = stage.lastIndexOf('if (', rejection);
assert.ok(
  /if \(autonomousMode && !quality\.passed\)/.test(stage.slice(guard, rejection)),
  'content_rejected must only fire when quality gates actually failed'
);
assert.ok(
  /type: 'review_required'/.test(stage.slice(rejection)),
  'a passed Short waiting for approval must send the review_required notice'
);

// Pacing counts needs_review jobs as produced, so a waiting Short stops further generation.
const scheduler = fs.readFileSync(path.join(__dirname, '..', 'schedules', 'daily-automation.js'), 'utf8');
assert.ok(/\['needs_review', 'approved'\]\.includes\(details\.reviewStatus\)/.test(scheduler));

console.log('Review flow: PASS');
