# Instructions for sessions working in this repository

This repository is **code only**.

- **Standing documents never live here.** No session log, lessons learned, "where things are", operating brief, hand-off note, incident report or plan is ever created in this repository. They live in the private archive repository, in the sibling folder `youtube-agent-channel` (next to this one). Read its `CLAUDE.md` first, read and write the standing docs there, and write nothing of that kind here. If the sibling folder is missing, stop and ask the owner.
- **No personal or infrastructure data** in anything you add to any file, commit message, pull request or issue: no IP addresses, host names, user names, local paths, e-mail addresses, account names, channel names or ids. Use placeholders such as `<VM_HOST>`. Commits use the repository's no-reply identity.
- **No secrets, ever.** `.env`, `config/credentials.json` and `config/tokens.json` stay untracked. Never put a token-shaped string in a test; build it at run time.
- **Safety flags stay off.** Do not change an upload-related flag, loosen a quality gate or raise a cadence unless the owner asks.
- **Proof before "done":** `npm run lint` and the tests pass, and CI is green on the commit. Keep text files LF.
- One push per pull request.
