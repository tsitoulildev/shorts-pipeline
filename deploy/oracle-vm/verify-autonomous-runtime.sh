#!/usr/bin/env bash
set -euo pipefail

project_dir=/home/ubuntu/youtube-agent-channel
cd "$project_dir"

fail() {
  echo "AUTONOMOUS_VERIFY_FAILED: $*" >&2
  exit 1
}

systemctl is-active youtube-agent.service >/dev/null || fail "youtube-agent.service is not active"

service_env="$(systemctl show youtube-agent.service --property=Environment --value)"
grep -q 'AUTONOMOUS_MODE=true' <<<"$service_env" || fail "autonomous mode is not enabled"
grep -q 'YOUTUBE_UPLOAD_ENABLED=true' <<<"$service_env" || fail "YouTube upload is not enabled"
grep -q 'APPROVAL_REQUIRED=false' <<<"$service_env" || fail "APPROVAL_REQUIRED=false is not set for autonomous production"
if grep -q 'AUTOMATION_PAUSED=true' <<<"$service_env"; then fail "AUTOMATION_PAUSED=true is set"; fi
grep -q 'DEFAULT_PRIVACY_STATUS=public' <<<"$service_env" || fail "autonomous uploads are not configured public"
grep -q 'FREE_MEDIA_ONLY=true' <<<"$service_env" || fail "free-media policy is not pinned true"

health_json="$(curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3456/health)" || fail "health endpoint is unreachable"
dashboard_json="$(curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3456/api/dashboard)" || fail "dashboard endpoint is unreachable"

health_file="$(mktemp)"
dashboard_file="$(mktemp)"
trap 'rm -f "$health_file" "$dashboard_file"' EXIT
printf '%s' "$health_json" > "$health_file"
printf '%s' "$dashboard_json" > "$dashboard_file"

HEALTH_FILE="$health_file" DASHBOARD_FILE="$dashboard_file" node <<'NODE'
const fs = require('node:fs');
const identity = require('./config/channel-identity.json');
const shortsPerDayTarget = identity.publishingCadence.shortsPerDay.target;
const shortsPerWeek = shortsPerDayTarget * 7;
const health = JSON.parse(fs.readFileSync(process.env.HEALTH_FILE, 'utf8') || '{}');
const dashboard = JSON.parse(fs.readFileSync(process.env.DASHBOARD_FILE, 'utf8') || '{}');

if (health.status !== 'healthy' || health.initialized !== true || health.setupRequired === true) {
  throw new Error('health is not ready for autonomous production');
}
const expectedAgents = ['strategy', 'scriptWriter', 'thumbnailDesigner', 'seoOptimizer', 'production', 'publishing', 'analytics'];
const agents = new Set(Array.isArray(health.agents) ? health.agents : []);
const missing = expectedAgents.filter(name => !agents.has(name));
if (missing.length) throw new Error('missing agents: ' + missing.join(', '));

if (dashboard.system?.automationPaused !== false) throw new Error('automation is still paused');
const effectiveApproval = dashboard.system?.control ? dashboard.system.control.approvalRequired : String(dashboard.settings?.approval_required) !== 'false';
if (effectiveApproval !== false) throw new Error('human approval is still required');
if (dashboard.channelStrategy?.status !== 'active') throw new Error('channel strategy is not active');
if (Number(dashboard.channelStrategy?.cadence_per_week) !== shortsPerWeek) throw new Error(`Horror Stickman Shorts cadence is not ${shortsPerWeek}/week (channel-identity target ${shortsPerDayTarget}/day)`);
if (String(dashboard.channelStrategy?.default_length) !== 'short') throw new Error('channel strategy is not Shorts-first');
if (!String(dashboard.channelStrategy?.objective || '').toLowerCase().includes('horror stickman')) throw new Error('channel strategy is not the Horror Stickman niche');

const readiness = dashboard.readiness || {};
if (!['passed', 'warning'].includes(readiness.status) || readiness.stale === true) {
  throw new Error('production readiness is not usable');
}
if (Array.isArray(readiness.blockingFailures) && readiness.blockingFailures.length) {
  throw new Error('production readiness has blocking failures: ' + readiness.blockingFailures.join(', '));
}

console.log(JSON.stringify({
  ok: true,
  agents: expectedAgents.length,
  autonomous: true,
  humanApproval: false,
  uploads: true,
  shortsPerWeek,
  shortsPerDayTarget,
  readiness: readiness.status
}));
NODE

echo "Autonomous runtime verified."
