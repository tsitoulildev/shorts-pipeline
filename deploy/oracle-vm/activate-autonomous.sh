#!/usr/bin/env bash
set -euo pipefail

project_dir=/home/ubuntu/youtube-agent-channel
cd "$project_dir"

fail() {
  echo "AUTONOMOUS_ACTIVATION_FAILED: $*" >&2
  exit 1
}

[[ "$(id -un)" == "ubuntu" ]] || fail "run as ubuntu"
[[ "$(git branch --show-current)" == "main" ]] || fail "runtime is not on main"

# Fresh activation must pass the safe deployment contract. Re-running activation on an
# already-autonomous service must first prove the autonomous contract instead of failing
# merely because the upload kill-switch is already enabled.
service_env="$(systemctl show youtube-agent.service --property=Environment --value)"
if grep -q 'YOUTUBE_UPLOAD_ENABLED=true' <<<"$service_env"; then
  # A previously autonomous runtime may still carry the old niche/cadence in its DB.
  # Do not validate the NEW niche contract until this activation has seeded it below.
  systemctl is-active --quiet youtube-agent.service || fail "existing autonomous service is not active"
else
  bash deploy/oracle-vm/verify-runtime.sh
fi

# Persist the no-human-review operating policy, quarantine any old queue entries,
# and seed/activate the canonical Horror Stickman Shorts strategy without printing secrets.
node <<'NODE'
const { Database } = require('./database/db');
const identity = require('./config/channel-identity.json');
const niche = require('./config/horror-stickman-niche.json');

(async () => {
  const db = new Database();
  await db.initialize();
  try {
    await db.setSetting('approval_required', 'false');
    await db.setSetting('automation_paused', 'false');
    await db.setSetting('auto_publish_enabled', 'true');
    await db.setSetting('daily_content_enabled', 'true');
    await db.setSetting('analytics_enabled', 'true');
    await db.setSetting('optimization_enabled', 'true');

    // Quarantine unknown pre-migration queue state exactly once. Re-running activation
    // must never pause newly generated, QA-approved Horror Stickman schedules.
    const quarantineMarker = await db.getSetting('horror_stickman_queue_quarantined_v1');
    if (quarantineMarker !== 'true') {
      await db.executeQuery(
        `UPDATE publish_schedule
         SET status = 'paused',
             error_message = COALESCE(error_message, 'Quarantined during Horror Stickman migration')
         WHERE status = 'scheduled'`
      );
      await db.setSetting(
        'horror_stickman_queue_quarantined_v1',
        'true',
        'Legacy publish queue was quarantined once during Horror Stickman migration'
      );
    }

    const current = await db.getChannelStrategy() || {};
    const autonomousPolicy = [
      'Locked niche: ' + niche.name + '.',
      'No human review. Any weak hook, weak twist, semantic duplicate, brand drift, graphic-horror violation, placeholder media, narration failure, render failure, caption failure, metadata failure, cadence conflict, readiness failure, or ambiguous upload must fail closed and be skipped.'
    ].join(' ');
    const baseConstraints = String(current.constraints || '')
      .split(autonomousPolicy)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    await db.saveChannelStrategy({
      objective: 'Grow an original global English Horror Stickman Shorts channel through high-retention psychological micro-horror, consistent visual identity, and data-driven iteration.',
      audience: identity.audience,
      valueProposition: identity.corePromise,
      contentPillars: identity.contentPillars.map(pillar => pillar.label),
      cadencePerWeek: identity.publishingCadence.shortsPerDay.target * 7,
      videosPerRun: 1,
      defaultFormat: 'story',
      defaultLength: 'short',
      successMetric: 'Maximize Shorts views, stayed-to-watch, completion, average view duration, returning viewers, and subscriber growth without lowering originality or Horror Stickman quality gates.',
      primaryKpi: 'views',
      targetValue: current.target_value ?? null,
      targetWindowDays: current.target_window_days || 28,
      monthlyBudget: current.monthly_budget ?? null,
      outcomeCurrency: current.outcome_currency || 'USD',
      constraints: autonomousPolicy,
      status: 'active'
    });
  } finally {
    await db.close();
  }
})().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
NODE

# Override only after safe acceptance. The base service remains fail-closed (Mode 1).
# Running this script IS the operator's explicit authorization of autonomous
# publishing (Mode 2); the application records the transition on startup and never
# changes YOUTUBE_UPLOAD_ENABLED itself. Emergency stop without stopping production:
#   set YOUTUBE_UPLOAD_ENABLED=false in this drop-in, daemon-reload, restart.
sudo mkdir -p /etc/systemd/system/youtube-agent.service.d
cat <<'EOF' | sudo tee /etc/systemd/system/youtube-agent.service.d/autonomous.conf >/dev/null
[Service]
Environment=AUTONOMOUS_MODE=true
Environment=APPROVAL_REQUIRED=false
Environment=AUTOMATION_PAUSED=false
Environment=YOUTUBE_UPLOAD_ENABLED=true
Environment=DEFAULT_PRIVACY_STATUS=public
EOF

sudo systemctl daemon-reload

# Do not interrupt an already-correct autonomous runtime or an in-flight production.
# Decide from the RUNNING process, not from the unit file: after daemon-reload the unit already
# shows the drop-in written above, so checking it always "matched" and the service was never
# restarted (2026-10-03: Mode 2 written, old Mode 1 process kept running, activation failed).
# A scheduler paused in memory (operator pause before acceptance) also needs the restart, because
# the pause setting was cleared above and only a fresh process reads it.
main_pid="$(systemctl show youtube-agent.service --property=MainPID --value 2>/dev/null || echo 0)"
live_env=""
if [[ "$main_pid" =~ ^[0-9]+$ && "$main_pid" != "0" ]]; then
  live_env="$(sudo cat "/proc/$main_pid/environ" 2>/dev/null | tr '\0' '\n' || true)"
fi
live_paused="$(curl --silent --max-time 5 http://127.0.0.1:3456/api/dashboard 2>/dev/null |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).system?.automationPaused))}catch{process.stdout.write("unknown")}})')"
if systemctl is-active --quiet youtube-agent.service &&
   [[ "$live_paused" == "false" ]] &&
   grep -qx 'AUTONOMOUS_MODE=true' <<<"$live_env" &&
   grep -qx 'APPROVAL_REQUIRED=false' <<<"$live_env" &&
   grep -qx 'AUTOMATION_PAUSED=false' <<<"$live_env" &&
   grep -qx 'YOUTUBE_UPLOAD_ENABLED=true' <<<"$live_env" &&
   grep -qx 'DEFAULT_PRIVACY_STATUS=public' <<<"$live_env"; then
  echo "Running service already autonomous and unpaused; skipping restart."
else
  sudo systemctl restart youtube-agent.service
fi

# Wait for the HTTP service instead of assuming a fixed startup time.
health_ready=false
for _ in $(seq 1 30); do
  if curl --silent --fail --max-time 2 http://127.0.0.1:3456/health >/dev/null 2>&1; then
    health_ready=true
    break
  fi
  sleep 1
done
[[ "$health_ready" == "true" ]] || fail "health endpoint did not become ready after service activation"

bash deploy/oracle-vm/verify-autonomous-runtime.sh

# Start one run immediately. Read API_KEY without echoing it.
api_key="$(node - <<'NODE'
const fs = require('node:fs');
const dotenv = require('dotenv');
const config = dotenv.parse(fs.readFileSync('.env'));
process.stdout.write(String(config.API_KEY || ''));
NODE
)"
[[ -n "$api_key" && "$api_key" != "change-me-before-start" ]] || fail "API_KEY is missing"

http_code="$(
  curl --silent --show-error --output /tmp/youtube-agent-autonomous-start.json --write-out '%{http_code}'     --max-time 15     -X POST http://127.0.0.1:3456/api/operator/start     -H "x-api-key: $api_key"     -H 'content-type: application/json'     --data '{}'
)"
if [[ "$http_code" == "409" ]]; then
  if ! grep -Eqi 'already active|current generation job|current .* finish' /tmp/youtube-agent-autonomous-start.json; then
    cat /tmp/youtube-agent-autonomous-start.json >&2 || true
    fail "initial autonomous operator start was rejected for an unexpected reason"
  fi
elif [[ "$http_code" != "202" ]]; then
  cat /tmp/youtube-agent-autonomous-start.json >&2 || true
  fail "initial autonomous operator start returned HTTP $http_code"
fi
rm -f /tmp/youtube-agent-autonomous-start.json

echo "Autonomous Horror Stickman Shorts is active: quality-gated generation enabled, human approval disabled, public YouTube upload enabled, initial operator run requested."
