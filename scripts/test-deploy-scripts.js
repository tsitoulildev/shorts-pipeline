// Static checks for the deployment tooling: syntax, fail-safe policy and secret hygiene.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const shellScripts = fs.readdirSync(path.join(root, 'deploy/oracle-vm')).filter(f => f.endsWith('.sh'));
assert.ok(shellScripts.includes('rollout.sh'));
assert.ok(shellScripts.includes('verify-test-runtime.sh'));
assert.ok(shellScripts.includes('verify-current-mode.sh'));
assert.ok(read('deploy/oracle-vm/verify-test-runtime.sh').includes('system?.control'), 'Mode 1 verifier must read the effective controls');
assert.ok(read('index.js').includes('control: await resolveControlState'), 'dashboard must expose the effective controls');
assert.ok(read('deploy/oracle-vm/rollout.sh').includes('verify-current-mode.sh'), 'rollout must verify the real mode');
assert.ok(read('deploy/oracle-vm/verify-current-mode.sh').includes('verify-test-runtime.sh'), 'Mode 1 must have a verifier');
for (const script of shellScripts) {
  const source = read(`deploy/oracle-vm/${script}`);
  assert.ok(!source.includes('\r'), `${script} must use LF line endings`);
  assert.ok(source.startsWith('#!/usr/bin/env bash'), `${script} needs a bash shebang`);
  const syntax = spawnSync('bash', ['-n', path.join(root, 'deploy/oracle-vm', script)], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, `${script}: ${syntax.stderr}`);
}

// The backup-voice installer must stay non-destructive: no restart, no secrets, no other .env edits.
const piper = read('deploy/oracle-vm/install-piper.sh');
assert.ok(!/systemctl\s+restart/.test(piper.replace(/^\s*(#|echo).*$/gm, '')), 'install-piper must not restart the service');
assert.ok(piper.includes('>> "$env_file"') && !/sed\s+-i/.test(piper), 'install-piper must only append to .env');
assert.ok(!/(API_KEY|TOKEN|SECRET)/.test(piper), 'install-piper must not touch secrets');

// Only the operator-run activation script may turn uploads on; rollout never edits the switch.
const rollout = read('deploy/oracle-vm/rollout.sh');
// The tests and the dry run in rollout.sh must use the SAME FFmpeg as the service (the system build): the bundled
// ffmpeg-static has no `drawtext` filter, so the documentary thumbnail test failed during the first deploy.
assert.ok(/^export FFMPEG_PATH=\/usr\/bin\/ffmpeg$/m.test(rollout) && /^export FFPROBE_PATH=\/usr\/bin\/ffprobe$/m.test(rollout), 'rollout must export the system FFmpeg before lint/tests/dry run');
assert.ok(rollout.indexOf('export FFMPEG_PATH=') < rollout.indexOf('npm test'), 'FFMPEG_PATH must be exported before npm test');
assert.ok(/FFMPEG_PATH=\/usr\/bin\/ffmpeg/.test(read('deploy/oracle-vm/youtube-agent.service')), 'the service unit uses the same system FFmpeg');
assert.ok(!/YOUTUBE_UPLOAD_ENABLED\s*=/.test(rollout.replace(/^\s*#.*$/gm, '')), 'rollout must not set YOUTUBE_UPLOAD_ENABLED');
assert.ok(rollout.includes('--ff-only'), 'rollout must fast-forward only');
assert.ok(!/push\s+(-f|--force)|reset --hard/.test(rollout), 'rollout must not rewrite history');
assert.ok(rollout.includes('ROLLOUT_ACTIVATE') && rollout.includes('activate-autonomous.sh'));
// Cadence change is operator-requested, validated twice, and only writes cadence_per_week.
assert.ok(rollout.includes('ROLLOUT_CADENCE') && rollout.includes('scripts/set-cadence.js'), 'rollout supports the cadence input');
assert.ok(/\^\[0-9\]\{1,2\}\$/.test(rollout), 'rollout validates the cadence value');
const workflow = read('.github/workflows/deploy-oracle.yml');
assert.ok(workflow.includes('cadence_per_week') && workflow.includes('CADENCE: ${{ inputs.cadence_per_week }}'), 'workflow passes the cadence through an env var');
assert.ok(!/ROLLOUT_CADENCE=\$\{\{/.test(workflow), 'the input is never interpolated directly into the remote command');
assert.ok(workflow.indexOf('Validate inputs') < workflow.indexOf('Roll out on the VM'), 'inputs are validated before the SSH step');
const setCadence = read('scripts/set-cadence.js');
assert.ok(/UPDATE channel_strategies SET cadence_per_week/.test(setCadence) && !/YOUTUBE_UPLOAD_ENABLED|approval|status\s*=/.test(setCadence.replace(/^\s*\/\/.*$/gm, '')), 'set-cadence only writes cadence_per_week');

// The workflow fast-forwards the checkout before rollout.sh runs, so restart must not depend on
// before != after alone (that left the old process in memory and failed the Mode 1 verifier).
assert.ok(rollout.includes('.youtube-agent-deployed-commit'), 'rollout must track the commit the service runs');
assert.ok(/running_commit"\s*!=\s*"\$after"/.test(rollout), 'rollout must restart when the running commit differs from HEAD');
const writeAt = rollout.indexOf('> "$deployed_marker"');
assert.ok(writeAt > rollout.indexOf('health_ready" == "true" ]] || fail') && rollout.slice(writeAt - 120, writeAt).includes('"$after"'), 'marker is written only after a healthy restart');
assert.ok(rollout.slice(0, writeAt).includes('restarted=true') && rollout.slice(writeAt - 200, writeAt).includes('"$restarted" == "true"'), 'marker is written only when a restart happened');

// Mode 2 activation (regression 2026-10-03): the restart decision must read the RUNNING process,
// because after daemon-reload the unit already shows the drop-in just written; checking the unit
// skipped the restart and left the old Mode 1 process (paused) running.
const activate = read('deploy/oracle-vm/activate-autonomous.sh');
const dropInAt = activate.indexOf('autonomous.conf');
const decision = activate.slice(dropInAt, activate.indexOf('sudo systemctl restart youtube-agent.service', dropInAt));
assert.ok(dropInAt > 0 && decision.includes('/proc/$main_pid/environ'), 'activation must decide the restart from the live process environment');
assert.ok(!/systemctl show youtube-agent\.service --property=Environment/.test(decision), 'activation must not decide the restart from the unit file it just wrote');
assert.ok(decision.includes('live_paused') && decision.includes('"false"'), 'a scheduler paused in memory must also trigger the restart');
// Rollout: code restart first (with marker), activation after it, so activation's first run cannot block the rollout.
const activateAt = rollout.indexOf('bash deploy/oracle-vm/activate-autonomous.sh');
assert.ok(activateAt > writeAt, 'activation must run after the code restart and marker write');
assert.ok(!/running_commit"\s*!=\s*"\$after"[^\n]*ROLLOUT_ACTIVATE/.test(rollout), 'the code restart must not depend on ROLLOUT_ACTIVATE');

assert.ok(/^on:\s*\n\s+workflow_dispatch:/m.test(workflow), 'deploy must be manual only');
assert.ok(!/^\s+(push|pull_request|schedule):/m.test(workflow), 'deploy must have no automatic trigger');
assert.ok(workflow.includes("github.ref == 'refs/heads/main'"), 'deploy only from main');
assert.ok(workflow.includes('StrictHostKeyChecking=yes'), 'host key must be verified');
assert.ok(!/StrictHostKeyChecking=(no|accept-new)/.test(workflow), 'never disable host key checking');
assert.ok(/default:\s*false/.test(workflow), 'autonomous activation must default to off');
assert.ok(workflow.includes('secrets.ORACLE_SSH_KEY'));
assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(workflow), 'no key material in the workflow');
assert.ok(!/YOUTUBE_UPLOAD_ENABLED/.test(workflow), 'the workflow must not touch the upload switch');
assert.ok(!/echo[^\n]*\$\{?KEY\b/.test(workflow), 'the key must never be echoed');

console.log('Deploy scripts: PASS');
