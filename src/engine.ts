import { Store, type Account, type Job, type User, type WindowRow } from './db.js';
import { canContinue, FIVE, HOUR, nextScheduled, resetDetected, type Snapshot } from './domain.js';
import { type Credentials, type ProviderAdapter, ProviderError } from './providers.js';
import { Vault } from './security.js';

export class Engine {
  readonly busy = new Set<string>();
  private running = false;
  lastTick = Date.now();
  constructor(readonly store: Store, readonly vault: Vault, readonly providers: ProviderAdapter, readonly concurrency = 4) {}
  enqueue(account: Account, reason: string, dedupe: string, now: number, expires: number | null = null) {
    const user = this.store.get<User>('SELECT * FROM users WHERE id=?', account.user_id)!;
    this.store.run('INSERT OR IGNORE INTO jobs(account_id,reason,dedupe,due,account_version,schedule_version,expires) VALUES(?,?,?,?,?,?,?)',
      account.id, reason, dedupe, now, account.version, user.schedule_version, expires);
  }
  observe(account: Account, snapshot: Snapshot, now: number) {
    this.store.transaction(() => {
      const user = this.store.get<User>('SELECT * FROM users WHERE id=?', account.user_id)!;
      const schedule = this.store.schedule(user);
      let weeklyReset = false;
      let fiveReset = false;
      const resets: string[] = [];
      this.store.run('INSERT INTO observations(account_id,sampled_at,snapshot) VALUES(?,?,?)', account.id, now, JSON.stringify(snapshot));
      const previous = this.store.all<WindowRow>('SELECT * FROM windows WHERE account_id=?', account.id);
      this.store.run('UPDATE windows SET present=0 WHERE account_id=?', account.id);
      for (const window of snapshot.windows) {
        const old = previous.find(w => w.kind === window.kind);
        const reset = !!old?.present && resetDetected({ kind: old.kind, used: old.used, resetsAt: old.resets_at }, window, now);
        const generation = (old?.generation ?? 0) + (reset ? 1 : 0);
        this.store.run(`INSERT INTO windows(account_id,kind,used,resets_at,generation,sampled_at,present) VALUES(?,?,?,?,?,?,1)
          ON CONFLICT(account_id,kind) DO UPDATE SET used=excluded.used,resets_at=excluded.resets_at,generation=excluded.generation,sampled_at=excluded.sampled_at,present=1`,
        account.id, window.kind, window.used, window.resetsAt, generation, now);
        if (reset) {
          resets.push(`${window.kind}:${generation}`);
          this.store.notify(account.user_id, account.id, `reset:${account.id}:${window.kind}:${generation}`, `${account.label}: ${window.kind === 'weekly' ? 'weekly' : '5-hour'} usage window reset detected.`, now);
          if (window.kind === 'weekly') weeklyReset = true;
          else fiveReset = true;
        }
      }
      const hasFive = snapshot.windows.some(w => w.kind === 'five_hour');
      const previouslyFive = previous.some(w => w.kind === 'five_hour' && w.present);
      if (!hasFive) {
        this.store.run('UPDATE accounts SET next_session=NULL WHERE id=?', account.id);
        this.store.run("DELETE FROM jobs WHERE account_id=? AND reason IN ('scheduled','five_reset')", account.id);
      } else if (!previouslyFive || account.next_session === null) {
        this.store.run('UPDATE accounts SET next_session=? WHERE id=?', nextScheduled(schedule, now), account.id);
      }
      if (weeklyReset || fiveReset) {
        this.store.run("DELETE FROM jobs WHERE account_id=? AND reason IN ('weekly_reset','five_reset')", account.id);
        if (weeklyReset || (hasFive && canContinue(schedule, now))) {
          this.enqueue(account, weeklyReset ? 'weekly_reset' : 'five_reset', `reset-open:${account.id}:${resets.join(':')}`, now, weeklyReset ? null : now + FIVE);
        }
      }
      this.store.run('UPDATE accounts SET failures=0,last_error=NULL WHERE id=?', account.id);
    });
  }
  async operate(account: Account, action: 'poll' | 'open') {
    return this.providers.execute(account.provider, this.vault.open<Credentials>(account.credentials, account.id), action, credentials => {
      this.store.run('UPDATE accounts SET credentials=? WHERE id=? AND version=?', this.vault.seal(credentials, account.id), account.id, account.version);
    });
  }
  failure(account: Account, error: unknown, attempts: number, now: number) {
    const code = error instanceof ProviderError ? error.code : 'unavailable';
    this.store.run('UPDATE accounts SET last_error=? WHERE id=?', code, account.id);
    if (code === 'auth') {
      this.store.run("UPDATE accounts SET status='reauth_required' WHERE id=?", account.id);
      this.store.run('DELETE FROM jobs WHERE account_id=?', account.id);
      this.store.notify(account.user_id, account.id, `auth:${account.id}:${account.version}`, `${account.label}: authentication expired or was rejected. Run acadence accounts reauth ${account.id}.`, now);
    } else if (attempts >= 3 || code === 'quota_schema') {
      if (code === 'quota_schema') this.store.run("DELETE FROM jobs WHERE account_id=? AND reason IN ('scheduled','five_reset')", account.id);
      this.store.notify(account.user_id, account.id, `error:${account.id}:${code}:${Math.floor(now / (24 * HOUR))}`,
        `${account.label}: ${code === 'quota_schema' ? 'provider quota format is unsupported; check for an Acadence update' : 'provider requests repeatedly failed; Acadence will keep retrying'}.`, now);
    }
  }
  async poll(account: Account, now: number) {
    this.store.run('UPDATE accounts SET next_poll=? WHERE id=?', now + HOUR, account.id);
    try {
      const snapshot = await this.operate(account, 'poll');
      if (snapshot) this.observe(account, snapshot, now);
    } catch (error) {
      const failures = account.failures + 1;
      this.store.run('UPDATE accounts SET failures=? WHERE id=?', failures, account.id);
      this.failure(account, error, failures, now);
    }
  }
  async executeJob(account: Account, job: Job, now: number) {
    const user = this.store.get<User>('SELECT * FROM users WHERE id=?', account.user_id)!;
    const scheduled = job.reason === 'scheduled' || job.reason === 'five_reset';
    if (job.account_version !== account.version || (job.expires !== null && job.expires <= now) ||
      (scheduled && (job.schedule_version !== user.schedule_version || !canContinue(this.store.schedule(user), now) && (job.reason === 'five_reset' || job.attempts > 0)))) {
      this.store.run('DELETE FROM jobs WHERE id=?', job.id);
      return;
    }
    try {
      await this.operate(account, 'open');
      this.store.transaction(() => {
        this.store.run('DELETE FROM jobs WHERE account_id=? AND due<=?', account.id, now);
        this.store.run('UPDATE accounts SET last_success=?,last_error=NULL,next_poll=MIN(next_poll,?) WHERE id=?', now, now + 60_000, account.id);
      });
    } catch (error) {
      this.store.run('UPDATE jobs SET attempts=attempts+1,due=? WHERE id=?', Date.now() + 60_000, job.id);
      this.failure(account, error, job.attempts + 1, now);
    }
  }
  reminders(now: number) {
    const rows = this.store.all<WindowRow & { user_id: string; label: string }>(`SELECT w.*,a.user_id,a.label FROM windows w JOIN accounts a ON a.id=w.account_id
      WHERE w.present=1 AND a.status='active' AND w.resets_at>?`, now);
    for (const window of rows) {
      const lead = window.kind === 'five_hour' ? HOUR : 24 * HOUR;
      if (window.resets_at! - now <= lead) {
        this.store.notify(window.user_id, window.account_id, `reminder:${window.account_id}:${window.kind}:${window.generation}:${window.resets_at}`,
          `${window.label}: ${window.kind === 'five_hour' ? '5-hour' : 'weekly'} window expires at ${new Date(window.resets_at!).toISOString()} (within ${window.kind === 'five_hour' ? '1 hour' : '1 day'}).`, now);
      }
    }
  }
  async tick(now = Date.now()) {
    if (this.running) return;
    this.running = true;
    this.lastTick = Date.now();
    try {
      this.reminders(now);
      const accounts = this.store.all<Account>("SELECT * FROM accounts WHERE status='active' ORDER BY MIN(next_poll,COALESCE(next_session,next_poll))");
      for (let i = 0; i < accounts.length; i += this.concurrency) {
        await Promise.all(accounts.slice(i, i + this.concurrency).map(async initial => {
          if (this.busy.has(initial.id)) return;
          this.busy.add(initial.id);
          try {
            if (initial.next_poll <= now) await this.poll(initial, now);
            const account = this.store.get<Account>('SELECT * FROM accounts WHERE id=?', initial.id);
            if (!account || account.status !== 'active') return;
            if (account.last_error !== 'quota_schema' && account.next_session !== null && account.next_session <= now) {
              const user = this.store.get<User>('SELECT * FROM users WHERE id=?', account.user_id)!;
              if (now - account.next_session < 90_000) this.enqueue(account, 'scheduled', `schedule:${account.id}:${user.schedule_version}:${account.next_session}`, now, account.next_session + FIVE);
              this.store.run('UPDATE accounts SET next_session=? WHERE id=?', nextScheduled(this.store.schedule(user), now), account.id);
            }
            const job = this.store.get<Job>("SELECT * FROM jobs WHERE account_id=? AND due<=? ORDER BY CASE reason WHEN 'weekly_reset' THEN 0 WHEN 'manual' THEN 1 ELSE 2 END,id LIMIT 1", account.id, Date.now());
            if (job) await this.executeJob(account, job, Date.now());
          } finally { this.busy.delete(initial.id); }
        }));
        this.lastTick = Date.now();
      }
      this.reminders(Date.now());
      this.store.run('DELETE FROM observations WHERE sampled_at<?', now - 35 * 24 * HOUR);
      this.store.run('DELETE FROM notifications WHERE sent IS NOT NULL AND sent<?', now - 35 * 24 * HOUR);
      this.store.run('DELETE FROM devices WHERE expires<?', now);
      this.store.run('DELETE FROM tokens WHERE expires<?', now);
    } finally { this.running = false; this.lastTick = Date.now(); }
  }
  async drain() { while (this.running) await new Promise(resolve => setTimeout(resolve, 100)); }
}
