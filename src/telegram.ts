import { randomUUID } from 'node:crypto';
import { Store, type User } from './db.js';
import { hash } from './security.js';

export type TelegramApi = (method: string, data: object) => Promise<any>;
export function telegramApi(token: string): TelegramApi {
  return async (method, data) => {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
      signal: AbortSignal.timeout(35_000), redirect: 'error'
    });
    const result = await response.json() as { ok: boolean; result: unknown };
    if (!response.ok || !result.ok) throw new Error('Telegram request failed');
    return result.result;
  };
}
export class Telegram {
  private stopped = false;
  private sending = false;
  lastSuccess = Date.now();
  constructor(readonly store: Store, readonly api: TelegramApi) {}
  accept(update: any, now = Date.now()) {
    this.store.transaction(() => this.link(update, now));
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
          this.store.transaction(() => {
            this.link(update, Date.now());
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
      const pending = this.store.all<{ id: number; body: string; telegram_id: string; attempts: number }>(`SELECT n.id,n.body,n.attempts,u.telegram_id FROM notifications n
        JOIN users u ON u.id=n.user_id WHERE n.sent IS NULL AND n.due<=? ORDER BY n.id LIMIT 20`, now);
      for (const item of pending) {
        try {
          await this.api('sendMessage', { chat_id: item.telegram_id, text: item.body });
          this.store.run('UPDATE notifications SET sent=? WHERE id=?', Date.now(), item.id);
        } catch {
          this.store.run('UPDATE notifications SET attempts=attempts+1,due=? WHERE id=?', Date.now() + Math.min(3_600_000, 60_000 * 2 ** Math.min(item.attempts, 6)), item.id);
        }
      }
    } finally { this.sending = false; }
  }
  stop() { this.stopped = true; }
}
