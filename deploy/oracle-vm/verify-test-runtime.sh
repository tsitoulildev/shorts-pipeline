#!/usr/bin/env bash
# Mode 1 (test) while automation is running: production works, nothing is published.
# Upload kill switch pinned false, human approval required, free media only.
set -euo pipefail

project_dir=/home/ubuntu/youtube-agent-channel
cd "$project_dir"

fail() {
  echo "TEST_MODE_VERIFY_FAILED: $*" >&2
  exit 1
}

systemctl is-active youtube-agent.service >/dev/null || fail "youtube-agent.service is not active"

service_env="$(systemctl show youtube-agent.service --property=Environment --value)"
grep -q 'YOUTUBE_UPLOAD_ENABLED=false' <<<"$service_env" || fail "service upload kill-switch is not pinned false"
grep -q 'FREE_MEDIA_ONLY=true' <<<"$service_env" || fail "service free-media policy is not pinned true"
if grep -q 'APPROVAL_REQUIRED=false' <<<"$service_env"; then fail "APPROVAL_REQUIRED=false in test mode"; fi

health_json=""
for _attempt in {1..20}; do
  if health_json="$(curl --fail --silent --show-error --max-time 3 http://127.0.0.1:3456/health 2>/dev/null)"; then break; fi
  sleep 1
done
[[ -n "$health_json" ]] || fail "health endpoint is unreachable"
dashboard_json="$(curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3456/api/dashboard)" || fail "dashboard endpoint is unreachable"

health_file="$(mktemp)"
dashboard_file="$(mktemp)"
trap 'rm -f "$health_file" "$dashboard_file"' EXIT
printf '%s' "$health_json" > "$health_file"
printf '%s' "$dashboard_json" > "$dashboard_file"

HEALTH_FILE="$health_file" DASHBOARD_FILE="$dashboard_file" node <<'NODE'
const fs = require('node:fs');
const health = JSON.parse(fs.readFileSync(process.env.HEALTH_FILE, 'utf8') || '{}');
const dashboard = JSON.parse(fs.readFileSync(process.env.DASHBOARD_FILE, 'utf8') || '{}');
if (health.status !== 'healthy' || health.initialized !== true || health.setupRequired === true) throw new Error('health is not ready');
const expectedAgents = ['strategy', 'scriptWriter', 'thumbnailDesigner', 'seoOptimizer', 'production', 'publishing', 'analytics'];
const agents = new Set(Array.isArray(health.agents) ? health.agents : []);
const missing = expectedAgents.filter(name => !agents.has(name));
if (missing.length) throw new Error('missing agents: ' + missing.join(', '));
// Effective state only: the stored setting is overridden by the service environment.
const control = dashboard.system?.control;
if (!control) throw new Error('dashboard does not expose the effective controls');
if (control.uploadEnabled !== false) throw new Error('uploads are enabled in test mode');
if (control.approvalRequired !== true) throw new Error('human approval is off in test mode');
const readiness = dashboard.readiness || {};
if (!['passed', 'warning'].includes(readiness.status) || readiness.stale === true) throw new Error('production readiness is not usable');
if (Array.isArray(readiness.blockingFailures) && readiness.blockingFailures.length) throw new Error('readiness blocking failures: ' + readiness.blockingFailures.join(', '));
console.log(JSON.stringify({ ok: true, mode: 'test', uploadEnabled: false, approvalRequired: true, automationPaused: dashboard.system?.automationPaused === true, readiness: readiness.status }));
NODE
echo "TEST_MODE_VERIFY_OK"
