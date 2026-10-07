# shorts-pipeline

An automation pipeline for short vertical videos (YouTube Shorts). It researches a subject, writes a script, records a narration, renders the video and, only when you allow it, uploads it. It is built to run on **free tiers only**: free LLM providers, free text-to-speech, FFmpeg for all video work, and openly licensed images.

> Status: working software that is still being reshaped. The newest part is the **Dark History** path (true, well documented stories). An older fiction path is still in the code and is being retired.

## What the Dark History path does

Short videos about real, old, well documented events (shipwrecks, disappearances, disasters). Every step is built so that nothing is invented:

1. **Footage first.** A story is eligible only if every part of its source text has real, correctly licensed images. Text comes from Wikipedia, images from Wikimedia Commons. The licence of each image is read from the file's own metadata and stored with it. No stand-ins, no AI-generated pictures of real events.
2. **Story pool.** A background job researches candidate events ahead of time (no living persons, nothing newer than about 50 years), downloads the images and keeps a stock of ready stories. When the stock runs low it raises an alert (and the code can compute a slower cadence), instead of publishing something weak.
3. **Grounded script.** The writer may only narrate facts that are in the source text. Each beat lists the source sentences it relies on.
4. **Fact-check gate.** Every number, name and quotation must be found in the source, and a second model pass checks that each sentence is supported. Anything unsupported rejects the script. The gate is never relaxed to hit a cadence.
5. **Render** (being added): slow zoom and pan (Ken Burns) on the real images, narration, burned-in captions, a thumbnail made from a real image, and a final gate that re-checks every image file, licence and credit before anything can be published.
6. **Attribution.** The Wikipedia credit and the author, licence and URL of every image go, unchanged, into the video description.

## Requirements

- Node.js 18 or newer (the project's CI runs Node 24).
- FFmpeg. The `ffmpeg-static` package provides one at install time; a system FFmpeg (`/usr/bin/ffmpeg`) is also supported.
- Optional free API keys for text models (see `.env.example`). Nothing paid is used or needed.

## Quick start

```bash
git clone <repository-url> shorts-pipeline
cd shorts-pipeline
npm install
cp .env.example .env      # then edit .env; it is never committed
npm test                  # the whole offline test chain
npm run lint
```

Look at what the footage step would do for a story, without any LLM key (this contacts Wikipedia and Wikimedia Commons, so set `WIKIMEDIA_CONTACT` in `.env` to a URL or address where Wikimedia can reach you):

```bash
node scripts/dark-history-probe.js "Mary Celeste" --no-llm
```

## Configuration

Everything is configured through `.env` (copy `.env.example`; every key is explained there). The ones to know first:

| Key | Meaning |
| --- | --- |
| `FREE_LLM_ONLY`, `FREE_MEDIA_ONLY` | Keep the pipeline on free providers (default on). |
| `WIKIMEDIA_CONTACT` | Contact shown to Wikimedia in the User-Agent. Required by their API policy. |
| `YOUTUBE_EXPECTED_CHANNEL_ID` | **Required before any upload.** The id of the channel the videos must go to. Uploads are refused if it is empty or the authorised account owns another channel. |
| `YOUTUBE_UPLOAD_ENABLED` | Master switch for uploads. Off unless you turn it on. |
| `APPROVAL_REQUIRED`, `AUTONOMOUS_MODE`, `AUTOMATION_PAUSED` | Who decides what is published. |
| `DARK_HISTORY_POOL_ENABLED` | The background story research. Off by default. |
| `API_KEY` | Protects the local API. Use a long random value. |

## Safety by design

- Every flag that can publish something is **off by default**.
- Quality gates (footage rights, fact-check, narration, captions, metadata, duplicates, cadence) reject content; nothing lowers them to reach a target.
- No secrets in the repository: `.env`, `config/credentials.json` and `config/tokens.json` are ignored by git. The local dashboard and API listen on `127.0.0.1` and are not meant to be exposed to the internet.
- Failures that concern the account rather than the content (an expired login, the wrong channel) keep the work scheduled and tell the owner what to do.

## Content and licences

Wikipedia text is CC BY-SA 4.0 and each Commons image has its own licence. The pipeline prefers public-domain and CC0 images, then CC BY, and uses CC BY-SA only when nothing else covers a part of the story, and it always writes the credits. If you publish videos made with it, you remain responsible for checking the licences and the platform's rules. Third-party notices, including a licence warning about one optional text-to-speech voice, are in [NOTICE.md](NOTICE.md).

## Deployment

A deployment guide for a small Ubuntu server (systemd service, two-stage acceptance, kill switch, YouTube re-authorisation) is in [deploy/oracle-vm/README.md](deploy/oracle-vm/README.md).

## Contributing and security

Run `npm run lint` and `npm test` before you open a pull request, keep secrets and personal data out of every file, and keep every upload-related flag off by default. See [SECURITY.md](SECURITY.md); please report vulnerabilities privately, not in public issues.

## Licence

MIT, see [LICENSE](LICENSE). Part of the code descends from an MIT-licensed project; its notice is kept in the licence file.
