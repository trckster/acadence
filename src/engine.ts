import { Store, type Account, type Job, type User, type WindowRow } from './db.js';
import { anchorsAround, canContinue, FIVE, HOUR, nextAnchor, nextScheduled, resetDetected, windowRolledOver, type Snapshot } from './domain.js';
import { accountEmail, type Credentials, type ProviderAdapter, ProviderError } from './providers.js';
import { formatUsage } from './format.js';
import { Vault } from './security.js';

export class Engine {
  readonly busy = new Set<string>();
  private running = false;
  lastTick = Date.now();
  constructor(readonly store: Store, readonly vault: Vault, readonly providers: ProviderAdapter, readonly concurrency = 4) {}
  async runIfIdle<T>(accountId: string, operation: () => Promise<T>): Promise<{ result: T } | null> {
    if (this.busy.has(accountId) || this.busy.size >= this.concurrency) return null;
    this.busy.add(accountId);
    try {
      // Wrap completed results so null/undefined cannot be mistaken for contention.
      return { result: await operation() };
    } finally { this.busy.delete(accountId); }
  }
  private accountName(account: Pick<Account, 'id' | 'provider' | 'category' | 'credentials'>) {
    return `${account.provider} / ${account.category} / ${accountEmail(this.vault.open<Credentials>(account.credentials, account.id)) ?? 'email unavailable'}`;
  }
  enqueue(account: Account, reason: string, dedupe: string, now: number, expires: number | null = null) {
    const user = this.store.get<User>('SELECT * FROM users WHERE id=?', account.user_id)!;
    const existing = this.store.get<Job>('SELECT * FROM jobs WHERE account_id=?', account.id);
    if (existing?.dedupe === dedupe) return;
    if (existing) {
      const priority: Record<string, number> = { manual: 0, anchor: 1, weekly_reset: 2, expiry: 3, scheduled: 4, five_reset: 5 };
      const promote = priority[reason]! <= priority[existing.reason]!;
      const newAnchor = promote && reason === 'anchor';
      const due = newAnchor ? now : Math.min(existing.due, !promote && existing.attempts > 0 ? existing.due : now);
      this.store.run('UPDATE jobs SET reason=?,dedupe=?,due=?,attempts=?,account_version=?,schedule_version=?,expires=? WHERE id=?',
        promote ? reason : existing.reason, promote ? dedupe : existing.dedupe,
        due, newAnchor ? 0 : existing.attempts, account.version,
        user.schedule_version, promote ? expires : existing.expires, existing.id);
    } else {
      this.store.run('INSERT INTO jobs(account_id,reason,dedupe,due,account_version,schedule_version,expires) VALUES(?,?,?,?,?,?,?)',
        account.id, reason, dedupe, now, account.version, user.schedule_version, expires);
    }
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
        // Preserve the expiry before an idle response clears its timestamp.
        // A future deadline means another client has already opened the next window.
        if (old?.present && old.resets_at !== null && old.resets_at <= now &&
            (account.last_success === null || account.last_success < old.resets_at) &&
            (window.resetsAt !== null ? window.resetsAt <= now : window.used === 0)) {
          this.enqueue(account, 'expiry', `expiry:${account.id}`, now);
        }
        const reset = !!old?.present && resetDetected({ kind: old.kind, used: old.used, resetsAt: old.resets_at }, window, now);
        const rollover = !!old?.present && windowRolledOver({ kind: old.kind, used: old.used, resetsAt: old.resets_at }, window, now);
        const generation = (old?.generation ?? 0) + (reset || rollover || !!old && !old.present ? 1 : 0);
        this.store.run(`INSERT INTO windows(account_id,kind,used,resets_at,generation,sampled_at,present) VALUES(?,?,?,?,?,?,1)
          ON CONFLICT(account_id,kind) DO UPDATE SET used=excluded.used,resets_at=excluded.resets_at,generation=excluded.generation,sampled_at=excluded.sampled_at,present=1`,
        account.id, window.kind, window.used, window.resetsAt, generation, now);
        if (reset) {
          resets.push(`${window.kind}:${generation}`);
          this.store.notify(account.user_id, account.id, `reset:${account.id}:${window.kind}:${generation}`, `${this.accountName(account)}\n🎁 Quota restored before the scheduled reset.\n${formatUsage(window, now, user.timezone)}`, now);
          if (window.kind === 'weekly') weeklyReset = true;
          else fiveReset = true;
        }
      }
      const hasFive = snapshot.windows.some(w => w.kind === 'five_hour');
      const previouslyFive = previous.some(w => w.kind === 'five_hour' && w.present);
      if (!hasFive) {
        this.store.run('UPDATE accounts SET next_session=NULL WHERE id=?', account.id);
        this.store.run("DELETE FROM jobs WHERE account_id=? AND reason IN ('anchor','scheduled','five_reset')", account.id);
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
      this.store.notify(account.user_id, account.id, `auth:${account.id}:${account.version}`, `⚠️ ${this.accountName(account)}\nAuthentication expired or was rejected. Run acadence reauth.`, now);
    } else if (attempts >= 3 || code === 'quota_schema') {
      if (code === 'quota_schema') this.store.run("DELETE FROM jobs WHERE account_id=? AND reason IN ('anchor','scheduled','five_reset','expiry')", account.id);
      this.store.notify(account.user_id, account.id, `error:${account.id}:${code}:${Math.floor(now / (24 * HOUR))}`,
        `⚠️ ${this.accountName(account)}\n${code === 'quota_schema' ? 'provider quota format is unsupported; check for an Acadence update' : 'provider requests repeatedly failed; Acadence will keep retrying'}.`, now);
    }
  }
  async poll(account: Account, now: number) {
    this.store.run('UPDATE accounts SET next_poll=? WHERE id=?', now + HOUR, account.id);
    try {
      const snapshot = await this.operate(account, 'poll');
      if (snapshot) this.observe(account, snapshot, Date.now());
      return snapshot;
    } catch (error) {
      const failures = account.failures + 1;
      this.store.run('UPDATE accounts SET failures=? WHERE id=?', failures, account.id);
      this.failure(account, error, failures, now);
      return null;
    }
  }
  async executeJob(account: Account, job: Job, now: number) {
    const user = this.store.get<User>('SELECT * FROM users WHERE id=?', account.user_id)!;
    const schedule = this.store.schedule(user);
    const scheduled = ['anchor','scheduled','five_reset'].includes(job.reason);
    if (job.account_version !== account.version || (job.expires !== null && job.expires <= now) ||
      (scheduled && (job.schedule_version !== user.schedule_version || job.reason !== 'anchor' && !canContinue(schedule, now) && (job.reason === 'five_reset' || job.attempts > 0)))) {
      this.store.run('DELETE FROM jobs WHERE id=?', job.id);
      return;
    }
    if (job.reason === 'expiry') {
      const windows = this.store.all<WindowRow>('SELECT * FROM windows WHERE account_id=? AND present=1', account.id);
      if (!windows.some(window => window.resets_at === null ? window.used === 0 :
          window.resets_at <= now && (account.last_success === null || account.last_success < window.resets_at))) {
        this.store.run('DELETE FROM jobs WHERE id=?', job.id);
        return;
      }
    }
    const next = nextAnchor(schedule, now);
    const plannedOpening = now - job.due < 90_000 &&
      (job.reason === 'anchor' && job.attempts === 0 || anchorsAround(schedule, job.due).includes(job.due));
    if (job.reason !== 'manual' && !plannedOpening && next !== null && next - now <= FIVE) {
      this.store.run('UPDATE jobs SET due=? WHERE id=?', next, job.id);
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
    const rows = this.store.all<WindowRow & { user_id: string; timezone: string }>(`SELECT w.*,a.user_id,u.timezone FROM windows w JOIN accounts a ON a.id=w.account_id JOIN users u ON u.id=a.user_id
      WHERE w.present=1 AND a.status='active' AND w.resets_at>?`, now);
    for (const window of rows) {
      const lead = window.kind === 'five_hour' ? HOUR : 24 * HOUR;
      if (window.resets_at! - now <= lead) {
        const dedupe = `reminder:${window.account_id}:${window.kind}:${window.generation}`;
        // Honor reminders persisted by older versions, whose keys included the exact expiry.
        if (this.store.get('SELECT id FROM notifications WHERE dedupe=? OR dedupe LIKE ?', dedupe, `${dedupe}:%`)) continue;
        this.store.notify(window.user_id, window.account_id, dedupe,
          `${this.accountName(this.store.get<Account>('SELECT * FROM accounts WHERE id=?', window.account_id)!)}\n⏳ ${formatUsage({ kind: window.kind, used: window.used, resetsAt: window.resets_at }, now, window.timezone)}`, now);
      }
    }
  }
  plan(now: number) {
    this.store.transaction(() => {
      // Inspect persisted deadlines every worker tick, independently of hourly
      // polling and fixed schedule slots. last_success prevents reopening the
      // same expired window while provider usage reporting catches up.
      const expired = this.store.all<Account>(`SELECT DISTINCT a.* FROM accounts a JOIN windows w ON w.account_id=a.id
        WHERE a.status='active' AND (a.last_error IS NULL OR a.last_error!='quota_schema')
        AND w.present=1 AND w.resets_at<=? AND (a.last_success IS NULL OR a.last_success<w.resets_at)`, now);
      for (const account of expired) this.enqueue(account, 'expiry', `expiry:${account.id}`, now);
      const due = this.store.all<Account>("SELECT * FROM accounts WHERE status='active' AND (last_error IS NULL OR last_error!='quota_schema') AND next_session<=?", now);
      for (const account of due) {
        const user = this.store.get<User>('SELECT * FROM users WHERE id=?', account.user_id)!;
        const schedule = this.store.schedule(user);
        const slot = account.next_session!;
        if (now - slot < 90_000) {
          const reason = anchorsAround(schedule, slot).includes(slot) ? 'anchor' : 'scheduled';
          this.enqueue(account, reason, `schedule:${account.id}:${user.schedule_version}:${slot}`, now,
            Math.min(slot + FIVE, nextAnchor(schedule, slot) ?? Infinity));
        }
        this.store.run('UPDATE accounts SET next_session=? WHERE id=?', nextScheduled(schedule, now), account.id);
      }
    });
  }
  async tick(now = Date.now()) {
    this.plan(now);
    this.reminders(now);
    if (this.running) return;
    this.running = true;
    this.lastTick = Date.now();
    try {
      const accounts = this.store.all<Account>("SELECT * FROM accounts WHERE status='active' ORDER BY MIN(next_poll,COALESCE(next_session,next_poll))");
      for (let i = 0; i < accounts.length; i += this.concurrency) {
        await Promise.all(accounts.slice(i, i + this.concurrency).map(initial => {
          const latest = this.store.get<Account>('SELECT * FROM accounts WHERE id=?', initial.id);
          if (!latest || latest.status !== 'active') return;
          return this.runIfIdle(initial.id, async () => {
            if (latest.next_poll <= now) await this.poll(latest, now);
            const account = this.store.get<Account>('SELECT * FROM accounts WHERE id=?', initial.id);
            if (!account || account.status !== 'active') return;
            const job = this.store.get<Job>("SELECT * FROM jobs WHERE account_id=? AND due<=? ORDER BY CASE reason WHEN 'weekly_reset' THEN 0 WHEN 'manual' THEN 1 ELSE 2 END,id LIMIT 1", account.id, Date.now());
            if (job) await this.executeJob(account, job, Date.now());
          });
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
