# Deploying to a small Ubuntu server

A guide for running the pipeline as a systemd service on a small Ubuntu 24.04 machine (the scripts were written for an ARM64 free-tier VM, they work on x86-64 too). The scripts assume the application lives in `/home/ubuntu/youtube-agent-channel` and runs as the user `ubuntu`; change the `project_dir` lines at the top of the scripts if yours differs. Use `<VM_HOST>` below for your server's address.

## Local secrets
Create `.env` directly on the server from `.env.example` (never copy it through chat or git):

- Set `FREE_MEDIA_ONLY=true` and `YOUTUBE_UPLOAD_ENABLED=false`, fill only the values you need, then `chmod 600 .env`.
- Generate a unique, long `API_KEY`.
- Set `YOUTUBE_EXPECTED_CHANNEL_ID` to the id of the channel the videos must go to. Without it every upload is refused and the production readiness check fails.
- Set `WIKIMEDIA_CONTACT` to a URL or address Wikimedia can reach (their API policy requires it).
- The YouTube OAuth client and its tokens belong in the git-ignored `config/credentials.json` and `config/tokens.json`; restrict both to mode 600.

## Re-authorize YouTube
In the Google Cloud console (APIs and Services, OAuth consent screen) set the app's publishing status to **In production**. An app left in "Testing" gets refresh tokens that Google revokes after 7 days, and every upload then fails with `invalid_grant`.

To authorise (or re-authorise) while the service keeps running:

1. From your computer open an SSH tunnel: `ssh -L 8080:localhost:8080 ubuntu@<VM_HOST>`.
2. On the server, from the application folder, run `node oauth-server.js`, open the printed link in the browser on your computer and approve.
3. Press Ctrl+C as soon as the tokens are saved (otherwise the script starts a second copy of the app), then `sudo systemctl restart youtube-agent`.

**Approve with the Google account that owns the channel.** The token follows the Google account that approves the consent screen, not the Google Cloud project: approving with another account makes uploads go to that account's channel. The production readiness check (`youtube_access`) compares the authorised channel with `YOUTUBE_EXPECTED_CHANNEL_ID`; while they differ it fails and every upload is held as `scheduled` with the alert "Wrong YouTube channel authorized". After a re-authorisation, refresh the check and read the channel back before trusting it:

```bash
curl -s -X POST -H "x-api-key: $API_KEY" http://127.0.0.1:3456/api/readiness/run
curl -s http://127.0.0.1:3456/api/readiness | grep -o '"channelTitle":"[^"]*"\|"channelId":"[^"]*"'
```

(Load `API_KEY` from `.env` in your shell without printing it.)

## Install the runtime
Install Node.js 24, npm, git and Ubuntu's `ffmpeg` package. Clone the repository into the application folder and run, as `ubuntu`:

```bash
git pull --ff-only origin main
bash deploy/oracle-vm/install.sh
```

The installer checks the branch and revision, the permissions of the credential files, the media policy and the system FFmpeg, then installs dependencies and runs lint, shell syntax checks, the full tests, an offline end-to-end dry run and the live readiness check before it installs the systemd service.

Deployment is two-stage. Stage 1 starts the service paused with uploads disabled and runs `deploy/oracle-vm/verify-runtime.sh`, which proves the service is healthy, every agent is initialised, the readiness gate is current and uploads are still off. Only after stage 1 passes does the installer run `deploy/oracle-vm/activate-autonomous.sh`, which is the operator's explicit authorisation to publish: it lifts the pause and the approval requirement, enables autonomous mode and public uploads, verifies the runtime again and requests the first run. Quality gates stay strict. Re-running the installer always returns to the safe paused stage first.

Diagnostics: `systemctl status youtube-agent` and `journalctl -u youtube-agent -n 100 --no-pager`. Do not print secrets.

## Updating a running server
Run the workflow **Deploy to Oracle** (manual only) with `activate_autonomous` left false, or run `bash deploy/oracle-vm/rollout.sh` on the server after `git pull --ff-only origin main`. Configure the workflow's `oracle-production` environment (never repository-wide) with the secrets `ORACLE_SSH_KEY` (a dedicated passphrase-less key), `ORACLE_SSH_KNOWN_HOSTS` and `ORACLE_HOST`, the variable `ORACLE_USER`, a required reviewer and deployment branches limited to `main`. The workflow's final step verifies that the server is in the mode you expect.

## Upload authorisation policy
Four independent controls, never interchangeable: `AUTONOMOUS_MODE`, `YOUTUBE_UPLOAD_ENABLED` (the kill switch, it wins over everything), `APPROVAL_REQUIRED` and `AUTOMATION_PAUSED`. The base systemd unit always boots with uploads disabled and approval on. Every upload re-runs the quality checks on the stored files and is verified on YouTube before it is recorded as published. An upload whose outcome is unknown is reconciled, never blindly retried.

Emergency stop without stopping production: set `YOUTUBE_UPLOAD_ENABLED=false` in `/etc/systemd/system/youtube-agent.service.d/autonomous.conf`, then `sudo systemctl daemon-reload && sudo systemctl restart youtube-agent.service`. Interrupted work resumes after the restart.

## Optional free backup voice (Piper)
When the hosted text-to-speech is unavailable or its free quota is spent, narration can fall back to a local open-source voice. The narration quality gates still apply.

```bash
bash deploy/oracle-vm/install-piper.sh
```

The script is idempotent and appends only the two `LOCAL_TTS_*` lines to `.env`; it never restarts the service. **Check the voice licence first** (see [NOTICE.md](../../NOTICE.md)): the default voice, `en_US-ljspeech-high`, is listed as public domain in the Piper model card, while `en_US-ryan-high` is trained on data licensed CC BY-NC-SA 4.0 (non-commercial) and should not be used for monetised videos. Pick another with `PIPER_VOICE=<name> bash deploy/oracle-vm/install-piper.sh`.

## Do not run untrusted code on the server
Do not register a self-hosted GitHub Actions runner on this repository, and never run code from pull requests on the production server.
