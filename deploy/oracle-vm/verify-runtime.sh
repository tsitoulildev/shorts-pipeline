#!/usr/bin/env bash
set -euo pipefail

project_dir=/home/ubuntu/youtube-agent-channel
cd "$project_dir"

fail() {
  echo "RUNTIME_VERIFY_FAILED: $*" >&2
  exit 1
}

[[ "$(id -un)" == "ubuntu" ]] || fail "run as ubuntu"
[[ "$(git branch --show-current)" == "main" ]] || fail "runtime is not on main"

git fetch origin main >/dev/null 2>&1
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] || fail "runtime main differs from origin/main"

systemctl is-enabled youtube-agent.service >/dev/null || fail "youtube-agent.service is not enabled"
systemctl is-active youtube-agent.service >/dev/null || fail "youtube-agent.service is not active"

service_env="$(systemctl show youtube-agent.service --property=Environment --value)"
grep -q 'YOUTUBE_UPLOAD_ENABLED=false' <<<"$service_env" || fail "service upload kill-switch is not pinned false"
grep -q 'FREE_MEDIA_ONLY=true' <<<"$service_env" || fail "service free-media policy is not pinned true"

health_json=""
for _attempt in {1..20}; do
  if health_json="$(curl --fail --silent --show-error --max-time 3 http://127.0.0.1:3456/health 2>/dev/null)"; then
    break
  fi
  sleep 1
done
[[ -n "$health_json" ]] || fail "health endpoint is unreachable"

dashboard_json=""
for _attempt in {1..20}; do
  if dashboard_json="$(curl --fail --silent --show-error --max-time 3 http://127.0.0.1:3456/api/dashboard 2>/dev/null)"; then
    break
  fi
  sleep 1
done
[[ -n "$dashboard_json" ]] || fail "dashboard endpoint is unreachable"

health_file="$(mktemp)"
dashboard_file="$(mktemp)"
trap 'rm -f "$health_file" "$dashboard_file"' EXIT
printf '%s' "$health_json" > "$health_file"
printf '%s' "$dashboard_json" > "$dashboard_file"

HEALTH_FILE="$health_file" DASHBOARD_FILE="$dashboard_file" node <<'NODE'
const fs = require('node:fs');
const health = JSON.parse(fs.readFileSync(process.env.HEALTH_FILE, 'utf8') || '{}');
const dashboard = JSON.parse(fs.readFileSync(process.env.DASHBOARD_FILE, 'utf8') || '{}');

if (health.status !== 'healthy' || health.initialized !== true || health.setupRequired === true) {
  throw new Error(`health is not production-ready: ${JSON.stringify({
    status: health.status,
    initialized: health.initialized,
    setupRequired: health.setupRequired
  })}`);
}

const expectedAgents = ['strategy', 'scriptWriter', 'thumbnailDesigner', 'seoOptimizer', 'production', 'publishing', 'analytics'];
const agents = new Set(Array.isArray(health.agents) ? health.agents : []);
const missingAgents = expectedAgents.filter(name => !agents.has(name));
if (missingAgents.length) throw new Error(`missing initialized agents: ${missingAgents.join(', ')}`);

if (dashboard.system?.automationPaused !== true) {
  throw new Error('automation must remain paused during deployment acceptance');
}

const readiness = dashboard.readiness || {};
if (!['passed', 'warning'].includes(readiness.status) || readiness.stale === true) {
  throw new Error(`production readiness is not usable: ${JSON.stringify({
    status: readiness.status,
    stale: readiness.stale,
    blockingFailures: readiness.blockingFailures || []
  })}`);
}
if (Array.isArray(readiness.blockingFailures) && readiness.blockingFailures.length) {
  throw new Error(`production readiness has blocking failures: ${readiness.blockingFailures.join(', ')}`);
}

console.log(JSON.stringify({
  ok: true,
  health: health.status,
  agents: expectedAgents.length,
  automationPaused: true,
  uploadEnabled: false,
  readiness: readiness.status
}));
NODE

echo "Oracle runtime acceptance passed: service active, 7 agents initialized, readiness usable, scheduler paused, uploads disabled."
