#!/usr/bin/env bash
# Routine code rollout on the Oracle VM (run as ubuntu). Safe to re-run.
#
# Pull -> install -> lint/test/dry run -> install unit -> restart when idle -> verify.
# It never edits YOUTUBE_UPLOAD_ENABLED and never switches modes by itself:
#   * the runtime is verified for the mode it is really in (service environment):
#     uploads on -> verify-autonomous-runtime.sh, paused -> verify-runtime.sh,
#     otherwise Mode 1 (test) -> verify-test-runtime.sh;
#   * ROLLOUT_ACTIVATE=true additionally runs activate-autonomous.sh, which is the
#     operator's explicit authorization of Mode 2.
set -euo pipefail

project_dir=/home/ubuntu/youtube-agent-channel
dropin=/etc/systemd/system/youtube-agent.service.d/autonomous.conf
cd "$project_dir"

fail() {
  echo "ROLLOUT_FAILED: $*" >&2
  exit 1
}

[[ "$(id -un)" == "ubuntu" ]] || fail "run as ubuntu"
[[ "$(git branch --show-current)" == "main" ]] || fail "runtime is not on main"
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || fail "tracked files changed on the VM; review before deploying"

# Lint, tests and the dry run must use the same FFmpeg as the service (the unit sets the same paths): the bundled
# ffmpeg-static has no `drawtext` filter, so the documentary thumbnail test failed during the first deploy.
[[ -x /usr/bin/ffmpeg && -x /usr/bin/ffprobe ]] || fail "system FFmpeg is missing (sudo apt install -y ffmpeg); nothing was changed"
export FFMPEG_PATH=/usr/bin/ffmpeg
export FFPROBE_PATH=/usr/bin/ffprobe

before="$(git rev-parse HEAD)"
# Commit the running service was last restarted on. The Deploy workflow fast-forwards the
# checkout BEFORE this script starts, so before == after there and "code changed" cannot
# be told from git alone: without this marker the old process stayed in memory.
deployed_marker=/home/ubuntu/.youtube-agent-deployed-commit
running_commit="$(cat "$deployed_marker" 2>/dev/null || true)"
git fetch origin main
git merge --ff-only origin/main || fail "main cannot be fast-forwarded"
after="$(git rev-parse HEAD)"
echo "Code: ${before:0:12} -> ${after:0:12}"

npm install --include=dev --no-fund --no-audit
npm run lint
npm test
# Offline end-to-end Short (temp DB, no network, no upload).
npm run dry-run:horror

unit_changed=false
if ! cmp -s deploy/oracle-vm/youtube-agent.service /etc/systemd/system/youtube-agent.service; then
  sudo install -m 0644 deploy/oracle-vm/youtube-agent.service /etc/systemd/system/youtube-agent.service
  unit_changed=true
fi
sudo systemctl daemon-reload

# Optional operator-requested cadence change (Deploy workflow input). Only cadence_per_week of the
# existing strategy is written; the value is validated (whole number 1-35) before and inside the script.
if [[ -n "${ROLLOUT_CADENCE:-}" ]]; then
  [[ "$ROLLOUT_CADENCE" =~ ^[0-9]{1,2}$ ]] || fail "cadence must be a whole number between 1 and 35"
  node scripts/set-cadence.js "$ROLLOUT_CADENCE"
fi

# A running node process keeps the old code in memory, so restart when the code or the
# unit changed, but never in the middle of a production run.
restarted=false
if [[ "$before" != "$after" || "$running_commit" != "$after" || "$unit_changed" == "true" ]]; then
  idle=false
  for _ in $(seq 1 60); do
    active="$(curl --silent --max-time 5 http://127.0.0.1:3456/api/dashboard 2>/dev/null |
      node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String(Number(j.system?.activeJobs||0)+(j.system?.autonomousRunning?1:0)))}catch{process.stdout.write("0")}})')"
    if [[ "$active" == "0" ]]; then idle=true; break; fi
    echo "Production run in progress; waiting before restart..."
    sleep 10
  done
  [[ "$idle" == "true" ]] || fail "production still busy after 10 minutes; new code is pulled but the service was NOT restarted. Re-run later"
  sudo systemctl restart youtube-agent.service
  restarted=true
fi

health_ready=false
for _ in $(seq 1 30); do
  if curl --silent --fail --max-time 2 http://127.0.0.1:3456/health >/dev/null 2>&1; then health_ready=true; break; fi
  sleep 2
done
[[ "$health_ready" == "true" ]] || fail "health endpoint did not become ready"
# Record what is now running, only after a restart that came up healthy.
if [[ "$restarted" == "true" ]]; then
  printf '%s\n' "$after" > "$deployed_marker"
fi

# Operator-authorized Mode 2 activation runs AFTER the code restart, so it starts from the new code
# and its own restart/first run cannot make this rollout wait for a busy production.
if [[ "${ROLLOUT_ACTIVATE:-false}" == "true" ]]; then
  bash deploy/oracle-vm/activate-autonomous.sh
fi

# Verify the mode the service is really in (reads the service environment, never writes it).
bash deploy/oracle-vm/verify-current-mode.sh
echo "ROLLOUT_OK commit=${after:0:12}"
