'use strict';

// A Short that passed every quality gate while human approval is required must wait for review (and say so); a Short that failed a gate is never scheduled and fails its job
// with the gate names, so the story goes back to the pool. Read from the source of the documentary job.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const index = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const job = index.slice(index.indexOf('async generateDocumentaryContent('), index.indexOf('async alertDocumentaryFailure('));
assert.ok(job.length > 500, 'the documentary job was not found');

assert.ok(/const reviewStatus = quality\.passed \? \(control\.approvalRequired \? 'needs_review' : 'approved'\) : 'needs_attention'/.test(job), 'the review status follows the gates and the approval setting');
const schedule = job.indexOf("if (reviewStatus === 'approved') {");
assert.ok(schedule > 0 && /scheduleContent\(productionData\)/.test(job.slice(schedule)), 'only an approved Short is scheduled');
const failure = job.indexOf("code: 'AUTONOMOUS_QUALITY_REJECTED'");
assert.ok(failure > schedule && /if \(!quality\.passed\) \{/.test(job.slice(job.lastIndexOf('if (', failure) - 2, failure)), 'a failed gate throws before anything is announced');
assert.ok(job.indexOf("type: 'review_required'") > failure, 'a passed Short waiting for approval sends the review_required notice');

// Pacing counts needs_review jobs as produced, so a waiting Short stops further generation.
const scheduler = fs.readFileSync(path.join(__dirname, '..', 'schedules', 'daily-automation.js'), 'utf8');
assert.ok(/\['needs_review', 'approved'\]\.includes\(details\.reviewStatus\)/.test(scheduler));

console.log('Review flow: PASS');
