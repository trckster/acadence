import { randomUUID } from 'node:crypto';
import { Store, type User } from './db.js';
import { fetchWithContext, responseJson, requestTarget, RequestError } from './errors.js';
import { hash } from './security.js';
import type { AccountView } from './account-view.js';
import { formatAccounts } from './format.js';

const help = 'Acadence bot commands:\n/see — Fetch current usage and status for every connected account.\n/help — Show this help.\n\nTo get started, run acadence login in your terminal and approve the sign-in here. Then run acadence connect to add an account. Manage accounts and schedules in the CLI; run acadence help for all commands.';

function messageChunks(body: string): string[] {
  const chunks: string[] = [];
  while (body.length > 4000) {
    let end = body.lastIndexOf('\n', 4000);
    if (end <= 0) {
      end = 4000;
      if (/[\uD800-\uDBFF]/.test(body[end - 1]!)) end--;
    } else end++;
    chunks.push(body.slice(0, end));
    body = body.slice(end);
  }
  if (body) chunks.push(body);
  return chunks;
}

export type TelegramApi = (method: string, data: object) => Promise<any>;
export function telegramApi(token: string): TelegramApi {
  return async (method, data) => {
    const url = `https://api.telegram.org/bot${token}/${method}`;
    const response = await fetchWithContext(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
      signal: AbortSignal.timeout(35_000), redirect: 'error'
    });
    const result = await responseJson(response, url, 'POST');
    if (!response.ok || !result?.ok) throw new RequestError(`${requestTarget(url, 'POST')}: HTTP ${response.status}; Telegram request rejected`);
    return result.result;
  };
}
export class Telegram {
  private stopped = false;
  private sending = false;
  lastSuccess = Date.now();
  constructor(readonly store: Store, readonly api: TelegramApi,
    readonly refreshReminder?: (accountId: string, dedupe: string) => Promise<string | null>,
    readonly seeAccounts?: (user: User) => Promise<AccountView[]>) {}
  async registerCommands() {
    await this.api('setMyCommands', { scope: { type: 'all_private_chats' }, commands: [
      { command: 'see', description: 'Fetch current usage and status for every connected account' },
      { command: 'help', description: 'Show bot commands and sign-in instructions' }
    ] });
  }
  async accept(update: any, now = Date.now()) {
    this.store.transaction(() => this.link(update, now));
    const message = update.message;
    if (message?.chat?.type !== 'private' || message.from?.is_bot || message.from?.id == null || String(message.from.id) !== String(message.chat.id)) return;
    const match = /^\/(see|help|start)(?:@\w+)?\s*$/.exec(message.text ?? '');
    if (!match) return;
    const user = this.store.get<User>('SELECT * FROM users WHERE telegram_id=?', String(message.from.id));
    const dedupe = `command:${message.chat.id}:${update.update_id ?? message.message_id ?? randomUUID()}`;
    if (this.store.get('SELECT id FROM notifications WHERE dedupe=?', `${dedupe}:0`)) return;
    let body = help;
    if (match[1] === 'see') {
      if (!user) body = 'Run acadence login in your terminal and approve the sign-in here before using /see. Then run acadence connect to add an account. Use /help for bot commands.';
      else {
        try {
          if (!this.seeAccounts) throw new Error('Usage refresh unavailable');
          body = formatAccounts(await this.seeAccounts(user), Date.now(), user.timezone);
        } catch { body = 'Could not load account usage. Please try /see again shortly.'; }
      }
    }
    const chunks = messageChunks(body);
    if (user) this.store.transaction(() => {
      chunks.forEach((chunk, i) => this.store.notify(user.id, null, `${dedupe}:${i}`, chunk, now));
    });
    else for (const chunk of chunks) {
      // Unlinked chats have no outbox; a blocked bot must not stall everyone else's updates.
      try { await this.api('sendMessage', { chat_id: String(message.chat.id), text: chunk }); }
      catch {}
    }
  }
  private link(update: any, now: number) {
    const message = update.message;
    if (message?.chat?.type !== 'private' || message.from?.is_bot || String(message.from?.id) !== String(message.chat.id)) return;
    const match = /^\/start(?:@\w+)? ([A-Za-z0-9_-]{43})$/.exec(message.text ?? '');
    if (!match) return;
    {
      const device = this.store.get<{ hash: string; timezone: string }>('SELECT hash,timezone FROM devices WHERE code_hash=? AND expires>? AND user_id IS NULL', hash(match[1]!), now);
      if (!device) return;
      const telegramId = String(message.from.id);
      let user = this.store.get<User>('SELECT * FROM users WHERE telegram_id=?', telegramId);
      if (!user) {
        const id = randomUUID();
        this.store.run('INSERT INTO users(id,telegram_id,timezone) VALUES(?,?,?)', id, telegramId, device.timezone);
        user = this.store.get<User>('SELECT * FROM users WHERE id=?', id)!;
      }
      this.store.run('UPDATE devices SET user_id=? WHERE hash=?', user.id, device.hash);
      this.store.notify(user.id, null, `login:${device.hash}`, 'Acadence CLI sign-in approved. Return to your terminal. Only approve sign-ins you started yourself.', now);
    }
  }
  async poll() {
    while (!this.stopped) {
      try {
        const offset = Number(this.store.get<{ value: string }>("SELECT value FROM metadata WHERE key='telegram_offset'")?.value ?? 0);
        const updates = await this.api('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
        for (const update of updates) {
          await this.accept(update);
          this.store.transaction(() => {
            this.store.run("INSERT INTO metadata(key,value) VALUES('telegram_offset',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", String(update.update_id + 1));
          });
        }
        this.lastSuccess = Date.now();
      } catch {
        if (!this.stopped) await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }
  async send(now = Date.now()) {
    if (this.sending) return;
    this.sending = true;
    try {
      const pending = this.store.all<{ id: number; account_id: string | null; dedupe: string; body: string; telegram_id: string; attempts: number }>(`SELECT n.id,n.account_id,n.dedupe,n.body,n.attempts,u.telegram_id FROM notifications n
        JOIN users u ON u.id=n.user_id WHERE n.sent IS NULL AND n.due<=? ORDER BY n.id LIMIT 20`, now);
      for (const item of pending) {
        // Pausing or reconnecting can cancel queued messages while a send awaits Telegram.
        if (!this.store.get('SELECT id FROM notifications WHERE id=? AND dedupe=? AND sent IS NULL', item.id, item.dedupe)) continue;
        try {
          let body = item.body;
          if (item.dedupe.startsWith('reminder:')) {
            if (!this.refreshReminder || !item.account_id) throw new Error('Reminder refresh unavailable');
            const fresh = await this.refreshReminder(item.account_id, item.dedupe);
            if (fresh === null) {
              this.store.run('DELETE FROM notifications WHERE id=? AND dedupe=? AND sent IS NULL', item.id, item.dedupe);
              continue;
            }
            body = fresh;
            this.store.run('UPDATE notifications SET body=? WHERE id=? AND dedupe=? AND sent IS NULL', body, item.id, item.dedupe);
          }
          // A refresh can pause the account and replace its queued notifications.
          if (!this.store.get('SELECT id FROM notifications WHERE id=? AND dedupe=? AND sent IS NULL', item.id, item.dedupe)) continue;
          await this.api('sendMessage', { chat_id: item.telegram_id, text: body });
          this.store.run('UPDATE notifications SET sent=? WHERE id=? AND dedupe=?', Date.now(), item.id, item.dedupe);
        } catch {
          this.store.run('UPDATE notifications SET attempts=attempts+1,due=? WHERE id=? AND dedupe=?', Date.now() + Math.min(3_600_000, 60_000 * 2 ** Math.min(item.attempts, 6)), item.id, item.dedupe);
        }
      }
    } finally { this.sending = false; }
  }
  stop() { this.stopped = true; }
}
