# Security policy

## Reporting a vulnerability
Please report security problems **privately**. Use the repository's "Security" tab and choose "Report a vulnerability" (GitHub private vulnerability reporting). Do not open a public issue or pull request for a vulnerability, and do not post secrets or logs that contain them anywhere public.

Please include what you found, how to reproduce it, and what an attacker could do. You will get an answer as soon as the maintainers can look at it; this is a small project without a service-level promise.

## Scope
In scope: the code in this repository (the pipeline, the local API and dashboard, the deployment scripts and the GitHub workflows). Out of scope: the services it talks to (Google, Wikimedia, LLM providers) and your own server configuration.

## Handling secrets
- Never commit `.env`, `config/credentials.json`, `config/tokens.json`, private keys or tokens. They are listed in `.gitignore`; keep it that way. Secret scanning and push protection are enabled on the repository.
- If a secret was ever committed, treat it as leaked: revoke or rotate it first, then clean up.
- The local API and dashboard bind to `127.0.0.1` by default and are not designed to be exposed to the internet. Reach them through an SSH tunnel.
- Use a long random `API_KEY`. Keep every upload-related flag off unless you mean to publish.
- Do not attach a self-hosted GitHub Actions runner to a public repository.
