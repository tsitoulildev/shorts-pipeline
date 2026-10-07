#!/usr/bin/env bash
set -euo pipefail

project_dir=/home/ubuntu/youtube-agent-channel
cd "$project_dir"

if [[ "$(id -un)" != ubuntu ]]; then
  echo "Run as ubuntu on the Oracle VM." >&2
  exit 1
fi
if [[ "$(git branch --show-current)" != main ]]; then
  echo "Deploy the reviewed main branch." >&2
  exit 1
fi
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Tracked files changed; review changes before deployment." >&2
  exit 1
fi
git fetch origin main
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
  echo "Local main differs from origin/main; pull with --ff-only and review the commit." >&2
  exit 1
fi

for secret_file in .env config/credentials.json config/tokens.json; do
  if [[ -e "$secret_file" && "$(stat -c '%a' "$secret_file")" != 600 ]]; then
    echo "Set $secret_file permissions to 600 before installation." >&2
    exit 1
  fi
done
if [[ ! -f .env ]]; then
  echo "Create .env locally on the VM from .env.example and fill credentials before installation." >&2
  exit 1
fi

# Match the PATH used by systemd's /usr/bin/env and require the CI Node major.
service_path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
if ! env -i PATH="$service_path" node -e 'process.exit(Number(process.versions.node.split(".")[0]) === 24 ? 0 : 1)'; then
  echo "Install Node.js 24 on the system PATH used by systemd." >&2
  exit 1
fi
if [[ ! -x /usr/bin/ffmpeg || ! -x /usr/bin/ffprobe ]]; then
  echo "Install system ffmpeg and ffprobe (sudo apt-get install ffmpeg)." >&2
  exit 1
fi
export FFMPEG_PATH=/usr/bin/ffmpeg
export FFPROBE_PATH=/usr/bin/ffprobe
ffmpeg -version | head -n 1
ffprobe -version | head -n 1

# This repository has no committed lockfile; use the same install mode as CI.
# Include the lint tooling even when the caller sets NODE_ENV=production.
npm install --include=dev --no-fund --no-audit

# Parse the file without echoing values, and fail closed on the two media controls.
node <<'NODE'
const fs = require('node:fs');
const dotenv = require('dotenv');
const config = dotenv.parse(fs.readFileSync('.env'));
if (config.FREE_MEDIA_ONLY !== 'true' || config.YOUTUBE_UPLOAD_ENABLED !== 'false') {
  console.error('Require FREE_MEDIA_ONLY=true and YOUTUBE_UPLOAD_ENABLED=false in .env.');
  process.exitCode = 1;
}
NODE

npm run lint
npm test
# Offline end-to-end Short on this machine (temp DB, no network, no upload).
npm run dry-run:horror
npm run readiness:production

# Keep the built-in scheduler paused until the first real acceptance run and
# explicit upload approval. Its persisted setting survives a reboot or crash.
node <<'NODE'
const { Database } = require('./database/db');
(async () => {
  const db = new Database();
  await db.initialize();
  try {
    await db.setSetting('automation_paused', 'true');
  } finally {
    await db.close();
  }
})().catch(error => {
  console.error('Could not persist the paused automation state:', error.message);
  process.exitCode = 1;
});
NODE

sudo install -m 0644 deploy/oracle-vm/youtube-agent.service /etc/systemd/system/youtube-agent.service
sudo rm -f /etc/systemd/system/youtube-agent.service.d/autonomous.conf
sudo systemctl daemon-reload
sudo systemctl enable --now youtube-agent.service
sudo systemctl restart youtube-agent.service
sudo systemctl is-enabled youtube-agent.service
sudo systemctl is-active youtube-agent.service

# Prove the safe runtime first; only then switch into autonomous production.
bash deploy/oracle-vm/verify-runtime.sh
bash deploy/oracle-vm/activate-autonomous.sh

echo "Service passed safe acceptance and autonomous activation."
