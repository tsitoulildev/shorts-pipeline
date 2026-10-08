// The CI must not turn a slow package mirror into a misleading test failure. On 2026-10-08 `apt-get install ffmpeg` timed out after 6 minutes
// (continue-on-error), the tests then ran with the bundled ffmpeg-static (no drawtext filter) and main went red with "No such filter: drawtext".
// The install retries, and the test step stops with the real cause when the system FFmpeg is missing.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const yml = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
const step = name => {
  const start = yml.indexOf(`- name: ${name}`);
  assert.ok(start >= 0, `step "${name}" exists`);
  const next = yml.indexOf('\n      - name:', start + 10);
  return yml.slice(start, next < 0 ? undefined : next);
};

const install = step('Install system FFmpeg');
assert.match(install, /Acquire::Retries=\d/, 'apt retries a slow mirror');
assert.match(install, /Acquire::http::Timeout=\d+/, 'apt has a short network timeout');
assert.match(install, /for attempt in 1 2 3/, 'the whole install is attempted up to three times');

const tests = step('Test');
assert.match(tests, /if \[ -z "\$FFMPEG_PATH" \]/, 'the test step checks that the system FFmpeg exists');
assert.match(tests, /system FFmpeg could not be installed/, 'and says the real cause instead of a drawtext error');
assert.ok(tests.indexOf('FFMPEG_PATH" ]') < tests.indexOf('npm test'), 'before running any test');

console.log('ci workflow tests passed');
