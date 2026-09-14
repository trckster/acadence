# Acadence

Schedule Claude Code and Codex usage windows from your terminal, with updates in Telegram.

## Features

- **Daily schedule** — Start usage windows automatically at your preferred times.
- **Usage tracking** — Check current usage and reset times for each account.
- **Telegram updates** — Get notified about resets, expiring usage windows, and account issues.
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

Update an installed copy to the latest stable release:

```bash
acadence update
```

The command verifies the release's SHA-256 checksum and updates the global npm installation it was launched from, including custom prefixes. It requires npm and write access to that installation, keeps your sign-in and settings, and does nothing if your version is already current or newer. Source checkouts and local project installations should use the installer above first.

Acadence aims to keep usage windows running throughout the day while sticking to your schedule.
