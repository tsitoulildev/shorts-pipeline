#!/usr/bin/env bash
# Installs the optional FREE backup voice (Piper) and wires it into .env.
# Idempotent and non-destructive: never touches other .env lines, never restarts
# the service (restart it yourself when it is idle), never prints any secret.
set -euo pipefail

project_dir=/home/ubuntu/youtube-agent-channel
venv=/home/ubuntu/piper
voices=/home/ubuntu/piper-voices
# PIPER_VOICE overrides the voice. Check the voice's licence first (see NOTICE.md): the default is listed as public domain, but some voices (e.g. en_US-ryan-high) are trained on non-commercial data.
voice="${PIPER_VOICE:-en_US-ljspeech-high}"
env_file="$project_dir/.env"

# Ubuntu ships python3 without ensurepip; install the venv package when missing.
if ! python3 -c 'import ensurepip' >/dev/null 2>&1; then
  echo "python3-venv is missing; installing it (needs sudo)"
  if ! sudo -n apt-get install -y python3-venv >/dev/null 2>&1 && ! sudo apt-get install -y python3-venv; then
    echo "PIPER_PREREQ_FAILED: run 'sudo apt install -y python3-venv' and run this script again" >&2
    exit 1
  fi
fi
python3 -m venv "$venv"
"$venv/bin/pip" install --quiet piper-tts
mkdir -p "$voices"
(cd "$voices" && "$venv/bin/python3" -m piper.download_voices "$voice")

wav=$(mktemp /tmp/piper-test-XXXXXX.wav)
trap 'rm -f "$wav"' EXIT
"$venv/bin/python3" -m piper -m "$voice" --data-dir "$voices" -f "$wav" -- 'The knocking answered every step he took.'
size=$(stat -c %s "$wav")
if [[ "$size" -lt 10000 ]]; then
  echo "PIPER_TEST_FAILED: output too small ($size bytes); .env not changed" >&2
  exit 1
fi
echo "PIPER_TEST_OK: $size bytes"

cmd="LOCAL_TTS_COMMAND=$venv/bin/python3 -m piper -m $voice --data-dir $voices --input-file {text} -f {wav}"
label="LOCAL_TTS_LABEL=piper:$voice"
touch "$env_file"
if grep -q '^LOCAL_TTS_COMMAND=' "$env_file"; then
  echo "ENV_UNCHANGED: LOCAL_TTS_COMMAND already set"
else
  printf '\n%s\n%s\n' "$cmd" "$label" >> "$env_file"
  echo "ENV_UPDATED: backup voice configured"
fi
echo "Restart the service when it is idle: sudo systemctl restart youtube-agent.service"
