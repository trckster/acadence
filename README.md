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
acadence connect
acadence schedule add 06:00
acadence see
```

Use ↑/↓ and Enter to choose a service (Claude Code or Codex), then an account type (Personal or Work). Esc cancels. Sign in to the account you want to connect; its email is detected automatically. You can also use `acadence connect codex --type personal` (or `claude`) to choose the provider directly. Use `acadence disconnect` to choose an account to remove. Run `acadence` or `acadence help` for all commands and the current version.

Accounts are identified by service, type (`personal` or `work`), and the email read from sign-in. Multiple accounts of the same service and type can use different emails. Reconnecting the same combination prompts you to use `acadence reauth`. Custom labels are no longer supported. On server upgrade, existing `work` labels become work accounts; all other labels become personal. Existing credentials, schedules, and usage history are preserved.

Upgrade the server and client together: this version replaces the `accounts` command namespace and the account-creation API now requires an account type. Legacy duplicate identities are preserved and can still reauthenticate; new duplicate connections are rejected.
