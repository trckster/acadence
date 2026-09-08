# Acadence

Schedule Claude Code and Codex usage windows from your terminal, with updates in Telegram.

## Features

- **Multiple accounts** — Manage Claude Code and Codex accounts in one place.
- **Daily schedule** — Start usage windows automatically at your preferred times.
- **Usage tracking** — Check current usage and reset times for each account.
- **Telegram updates** — Get notified about resets, expiring usage windows, and account issues.

## Get started

Requires Node.js 24+, npm, Telegram, and the official Claude Code or Codex CLI for the accounts you connect.

```bash
curl -fsSL https://raw.githubusercontent.com/trckster/acadence/master/scripts/install.sh | bash
```

Sign in through Telegram, connect an account, and set a daily start time:

```bash
acadence login
acadence accounts connect codex --label personal
acadence schedule add 06:00
acadence accounts list
```

Use `claude` instead of `codex` to connect a Claude Code account. Run `acadence help` for all commands.
