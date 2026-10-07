#!/usr/bin/env bash
# Picks the verifier that matches the mode the service is really in. The systemd
# Environment wins over .env, so that is what is read. Read-only: never edits any setting.
#   upload on            -> Mode 2, verify-autonomous-runtime.sh
#   upload off, paused   -> acceptance state, verify-runtime.sh
#   upload off, running  -> Mode 1 (test), verify-test-runtime.sh
set -euo pipefail

project_dir=/home/ubuntu/youtube-agent-channel
cd "$project_dir"

service_env="$(systemctl show youtube-agent.service --property=Environment --value)"
if grep -q 'YOUTUBE_UPLOAD_ENABLED=true' <<<"$service_env"; then
  exec bash deploy/oracle-vm/verify-autonomous-runtime.sh
fi

paused="$(curl --silent --max-time 10 http://127.0.0.1:3456/api/dashboard | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).system?.automationPaused===true))}catch{process.stdout.write("false")}})')"
if [[ "$paused" == "true" ]]; then
  exec bash deploy/oracle-vm/verify-runtime.sh
fi
exec bash deploy/oracle-vm/verify-test-runtime.sh
