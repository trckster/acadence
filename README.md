# Acadence

Multi-user Claude Code and Codex usage-window scheduler. TypeScript, SQLite, a globally installable CLI, and one shared Telegram bot. Each user has multiple accounts and one timezone/schedule.

## Install and use

Requires Node.js 24+, npm, Telegram, and the official `claude`/`codex` CLI for the accounts you connect.

```bash
curl -fsSL https://raw.githubusercontent.com/trckster/acadence/master/scripts/install.sh | bash
acadence login
acadence accounts connect codex --label personal
acadence accounts connect claude --label work
acadence accounts list
acadence usage
acadence schedule add 06:00
acadence schedule add 13:00
acadence schedule update 13:00 14:00
acadence schedule remove 14:00
acadence schedule show
acadence trigger
acadence accounts reauth you@example.com
acadence accounts disconnect you@example.com
acadence logout --all
```

The API defaults to `https://acadance.daniil.online`. Sign-in opens Telegram; approve only a sign-in you initiated. First login stores the detected system timezone. Change it with `acadence schedule timezone Europe/Rome`. `login --api https://your-host` supports self-hosting.

`acadence usage` shows the last recorded usage for every connected account belonging to the signed-in user: account status, five-hour and weekly usage percentages where available, reset times, and when each reading was checked. Accounts without readings are also listed. Usage is checked by the server hourly and shortly after openings; this command displays stored readings without requesting a fresh provider check.

Both `usage` and `accounts list` identify accounts by provider, label, and email:

```text
codex / personal: you@example.com
    active
    5h: 25% used; resets in 2h 3m; checked 2026-09-08 12:00
    Week: 42.5% used; resets 2026-09-14 09:00; checked 2026-09-08 12:00
```

Timestamps always use `YYYY-MM-DD HH:mm` with a 24-hour clock in the client's timezone. Future resets less than 24 hours away show remaining hours and minutes instead (or `in less than 1m`). Missing email or quota readings are marked unavailable. Codex emails come from the saved sign-in token; Claude emails are captured from `claude auth status` during connection or reauthentication. Reauthenticate an existing Claude account by label to capture its email.

`accounts reauth` and `accounts disconnect` accept an email or label. If multiple accounts match, narrow the selection with `--provider codex` (or `claude`) and/or `--label personal`. For example: `acadence accounts reauth you@example.com --provider codex --label personal`. Existing commands using internal account IDs remain compatible.

Account connection runs the official provider login in a separate temporary profile and transfers credentials over HTTPS without printing tokens or changing your existing provider login. The CLI token is stored with mode 0600 in `~/.config/acadence/client.json`. Server credentials use AES-256-GCM; refreshed credentials remain on the server. Tokens expire after one year; `logout --all` revokes all CLI sessions.

## Scheduling

Anchors run daily in the user's timezone; continuations run every five elapsed hours, only when the next anchor is at least five hours away. With `06:00`, openings are `06:00, 11:00, 16:00, 21:00`, then next day's `06:00`. With `06:00, 13:00`, they are `06:00, 13:00, 18:00, 23:00`. DST gaps shift an anchor forward; repeated times run once, at the earlier occurrence. Anchors missed by more than 90 seconds during downtime are skipped.

Accounts are checked hourly and shortly after openings. Codex windows are identified by duration, including weekly-only plans. Resets require changed provider state: an advanced reset timestamp or restored quota. A weekly reset opens immediately; a five-hour reset waits if an anchor is less than five hours away. Telegram reports resets, approaching expiration, and repeated failures. Failed openings retry after a minute; SQLite preserves retries and notification deduplication across restarts. A crash after a provider accepts a request or Telegram accepts a message can cause one duplicate on recovery, because neither offers an end-to-end idempotency guarantee here.

## Run and deploy

```bash
npm ci
npm test
npm run build
cp .env.example .env
openssl rand -base64 32
```

Put the generated value in `ENCRYPTION_KEY` and your dedicated BotFather token in `TELEGRAM_BOT_TOKEN`. Keep the encryption key stable and backed up separately; changing it makes stored accounts unreadable. The bot must have no webhook configured. For local development, export these variables, set `DATABASE_PATH=./data/acadence.sqlite`, and run `npm start`; connect with `acadence login --api http://localhost:3000`.

In Coolify, add this Git repository as a **Docker Compose** application using `docker-compose.yml`. Set both required secrets, and assign `https://acadance.daniil.online:3000` to the `acadence` service (Coolify terminates HTTPS on port 443). Point DNS at Coolify. Deploy **one replica**, with overlapping/rolling deployments disabled. The service runs as non-root, restarts unless stopped, and exposes `/health`. The named volume `acadence-data` persists `/data`, including SQLite WAL state; never delete it during redeploys. Back up the volume while the service is stopped, together with a separately secured copy of the encryption key.

Optional variables: `WORKER_CONCURRENCY` (default 4), `CODEX_MODEL`, `CLAUDE_MODEL` (otherwise provider defaults). The image pins provider CLI versions; update and test the Docker build arguments when upgrading. Container temporary credentials live on tmpfs and are removed after each operation.

## Provider support boundary

Codex uses the official [app-server quota interface](https://learn.chatgpt.com/docs/app-server) and [headless credential transfer](https://learn.chatgpt.com/docs/auth). Claude quota polling uses the undocumented `/api/oauth/usage` response used by Claude Code; inference runs the unmodified CLI. Unknown quota formats raise an alert instead of guessing. Live authentication/inference requires your accounts; automated tests use provider fixtures.

Claude's current [credential rules](https://code.claude.com/docs/en/legal-and-compliance) restrict third-party collection/storage of Claude.ai credentials. The requested central credential-transfer design therefore needs Anthropic's authorization before offering Claude integration as a public service. Shipping this adapter does not establish that authorization or guarantee continued endpoint availability.
