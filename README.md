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

Use ↑/↓ and Enter to choose a service (Claude Code or Codex), then sign in. Its email and Personal/Work type are detected from sign-in metadata: individual subscriptions are Personal; team, business, education, and enterprise subscriptions are Work. If the subscription type is missing or unrecognized, an arrow menu asks you to choose. Esc cancels any menu. You can also use `acadence connect codex --type personal` (or `claude`) to choose the provider directly and override type detection. Both `acadence disconnect` and `acadence reauth` use ↑/↓ and Enter to select an account. Run `acadence` or `acadence help` for all commands and the current version.

Accounts are identified by service, type (`personal` or `work`), and the email read from sign-in. Multiple accounts of the same service and type can use different emails. Reconnecting the same combination prompts you to use `acadence reauth`. Custom labels are no longer supported. On server upgrade, existing `work` labels become work accounts; all other labels become personal. Existing credentials, schedules, and usage history are preserved.

`acadence see` shows `not active` for idle usage windows. For Codex, a zero-usage window with a reset a full window away gets a second read about two seconds later: if the reset moves forward with the clock, it is treated as idle. Fixed reset times still count down even at 0% usage. Windows omitted by the provider remain `usage unavailable`.

When a reported usage window expires, the worker sends a short message to open the next window on its next tick (normally within five seconds), independently of daily schedule slots. This also works after a worker restart and when no daily anchors are configured. Failed openings retry after a minute. Checking usage with `acadence see` can detect an expired window and queue an opening for the worker.

Codex openings use `gpt-5.6-luna` by default; set `CODEX_MODEL` on the server to override it. A short Luna request was verified to establish a fixed five-hour countdown while displayed usage remained at 0%. Daily schedule slots still provide additional opening attempts; they do not postpone expiry-driven openings.

Upgrade the server and client together: this version replaces the `accounts` command namespace and the account-creation API now requires an account type. Legacy duplicate identities are preserved and can still reauthenticate; new duplicate connections are rejected.
