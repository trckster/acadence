# Acadence

Schedule Claude Code and Codex usage windows from your terminal, with updates in Telegram.

## Features

- **Daily schedule** — Start usage windows automatically at your preferred times.
- **Usage tracking** — Check current usage and reset times for each account, including Claude's separate Fable weekly allowance when available.
- **Telegram updates** — Get notified about resets, expiring usage windows, and account issues, with controls to enable or disable alerts.
- **Multiple accounts** — Manage Claude Code and Codex accounts in one place.

## Get started

Requires Node.js 24+, npm, Telegram, and the official Claude Code or Codex CLI for the accounts you connect.

```bash
curl -fsSL https://raw.githubusercontent.com/trckster/acadence/master/scripts/install.sh | bash
```

Sign in through Telegram, connect an account, and set a daily start time:

```bash
acadence login
acadence connect
acadence schedule add 06:00
acadence see
```

`acadence connect` walks you through choosing a service and signing in. Run `acadence help` for all commands.

In a private chat with the Telegram bot, use `/see` for the same current account usage and status as `acadence see`, with timestamps in your configured timezone. Use `/help` for bot commands and sign-in instructions. Account and schedule changes stay in the CLI.

Control automatic Telegram notifications from any signed-in CLI:

```bash
acadence notifications status
acadence notifications disable
acadence notifications enable
```

Notifications are enabled by default. This setting applies to your Acadence user across all sessions and connected accounts. Disabling discards queued automatic alerts and prevents new ones from being queued; enabling resumes alerts without replaying a backlog. Monitoring and schedules keep running, and Telegram sign-in confirmations and replies to bot commands still work.

Update an installed copy to the latest stable release:

```bash
acadence update
```

The command verifies the release's SHA-256 checksum and updates the global npm installation it was launched from, including custom prefixes. It requires npm and write access to that installation, keeps your sign-in and settings, and does nothing if your version is already current or newer. Source checkouts and local project installations should use the installer above first.

Acadence aims to keep usage windows running throughout the day while sticking to your schedule.

## Development

Use the Node.js version in `.node-version` and the npm version in `package.json`'s
`packageManager` field. CI tests Node.js 24 LTS and Node.js 26; the container and
release workflow use the pinned Node.js 24 LTS version.

```bash
npm install --global "$(node -p "require('./package.json').packageManager")"
npm ci
npm run check
npm test
npm run build
docker build -t acadence:local .
bash scripts/smoke-container.sh
```

The container smoke check disables external networking and uses temporary
credentials directories and a disposable volume to verify the provider CLIs, API, SQLite persistence, and worker
lock. It does not require Telegram or provider credentials.
