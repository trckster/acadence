import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type Account, type Job } from '../src/db.js';
import { Engine } from '../src/engine.js';
import { Vault } from '../src/security.js';
import { HOUR, FIVE, WEEK } from '../src/domain.js';
import { ProviderError, type ProviderAdapter } from '../src/providers.js';

const vault = new Vault(Buffer.alloc(32, 7).toString('base64'));
const credentials = { auth_mode: 'chatgpt' as const, tokens: { access_token: 'a', refresh_token: 'b', id_token: 'c' } };
function fixture(provider?: ProviderAdapter, path = ':memory:') {
  const store = new Store(path);
  store.run("INSERT INTO users(id,telegram_id,timezone,anchors) VALUES('u','123','UTC','[\"06:00\",\"13:00\"]')");
  store.run("INSERT INTO accounts(id,user_id,provider,label,credentials) VALUES('a','u','codex','work',?)", vault.seal(credentials, 'a'));
  const account = () => store.get<Account>("SELECT * FROM accounts WHERE id='a'")!;
  const engine = new Engine(store, vault, provider ?? { execute: async () => ({ windows: [] }) });
  return { store, account, engine };
}
test('weekly resets notify and open immediately even with an anchor nearby', () => {
  const { store, account, engine } = fixture();
  const now = Date.parse('2026-09-08T12:00:00Z');
  engine.observe(account(), { windows: [{ kind: 'five_hour', used: 70, resetsAt: now - 1 }, { kind: 'weekly', used: 80, resetsAt: now - 1 }] }, now - HOUR);
  engine.observe(account(), { windows: [{ kind: 'five_hour', used: 0, resetsAt: now + FIVE }, { kind: 'weekly', used: 0, resetsAt: now + WEEK }] }, now);
  assert.equal(store.all('SELECT * FROM notifications').length, 2);
  assert.equal(store.all<Job>('SELECT * FROM jobs')[0]!.reason, 'weekly_reset');
  assert.equal(store.all('SELECT * FROM jobs').length, 1);
  engine.observe(account(), { windows: [{ kind: 'five_hour', used: 0, resetsAt: now + FIVE }, { kind: 'weekly', used: 0, resetsAt: now + WEEK }] }, now + HOUR);
  assert.equal(store.all('SELECT * FROM notifications').length, 2);
  store.close();
});
test('five-hour reset waits for a nearby anchor and absence cancels continuations', () => {
  const { store, account, engine } = fixture();
  const now = Date.parse('2026-09-08T12:00:00Z');
  engine.observe(account(), { windows: [{ kind: 'five_hour', used: 70, resetsAt: now - 1 }] }, now - HOUR);
  engine.observe(account(), { windows: [{ kind: 'five_hour', used: 0, resetsAt: now + FIVE }] }, now);
  assert.equal(store.all('SELECT * FROM jobs').length, 0);
  assert.equal(account().next_session, Date.parse('2026-09-08T13:00:00Z'));
  engine.observe(account(), { windows: [{ kind: 'weekly', used: 20, resetsAt: now + WEEK }] }, now);
  assert.equal(account().next_session, null);
  store.close();
});
test('failures retry after a minute, notify after three attempts, then stop on auth change', async () => {
  let code: 'unavailable' | 'auth' = 'unavailable';
  const { store, account, engine } = fixture({ execute: async () => { throw new ProviderError(code); } });
  engine.enqueue(account(), 'manual', 'manual:a', Date.now());
  engine.enqueue(account(), 'manual', 'manual:a', Date.now());
  assert.equal(store.all('SELECT * FROM jobs').length, 1);
  for (let i = 0; i < 3; i++) {
    const before = Date.now();
    await engine.executeJob(account(), store.all<Job>('SELECT * FROM jobs')[0]!, before);
    const job = store.all<Job>('SELECT * FROM jobs')[0]!;
    assert.equal(job.attempts, i + 1);
    assert.ok(job.due >= before + 60_000);
  }
  assert.equal(store.all('SELECT * FROM notifications').length, 1);
  code = 'auth';
  await engine.executeJob(account(), store.all<Job>('SELECT * FROM jobs')[0]!, Date.now());
  assert.equal(account().status, 'reauth_required');
  assert.equal(store.all('SELECT * FROM jobs').length, 0);
  store.close();
});
test('successful opens coalesce due work without success notifications', async () => {
  let calls = 0;
  const { store, account, engine } = fixture({ execute: async () => { calls++; return null; } });
  const now = Date.now();
  engine.enqueue(account(), 'manual', 'manual:a', now);
  engine.enqueue(account(), 'weekly_reset', 'weekly:a', now);
  await engine.executeJob(account(), store.all<Job>('SELECT * FROM jobs')[0]!, now);
  assert.equal(calls, 1);
  assert.equal(store.all('SELECT * FROM jobs').length, 0);
  assert.equal(store.all('SELECT * FROM notifications').length, 0);
  store.close();
});
test('reminders are persistent and deduplicated', () => {
  const { store, account, engine } = fixture();
  const now = Date.now();
  engine.observe(account(), { windows: [{ kind: 'five_hour', used: 20, resetsAt: now + HOUR }, { kind: 'weekly', used: 20, resetsAt: now + 24 * HOUR }] }, now);
  engine.reminders(now);
  engine.reminders(now + 5000);
  assert.equal(store.all('SELECT * FROM notifications').length, 2);
  store.close();
});
test('queued retries and observations survive reopening SQLite', () => {
  const directory = mkdtempSync(join(tmpdir(), 'acadence-test-'));
  try {
    const path = join(directory, 'test.sqlite');
    const { store, account, engine } = fixture(undefined, path);
    engine.enqueue(account(), 'manual', 'manual:a', Date.now());
    engine.observe(account(), { windows: [{ kind: 'weekly', used: 20, resetsAt: Date.now() + WEEK }] }, Date.now());
    store.close();
    const recovered = new Store(path);
    assert.equal(recovered.all('SELECT * FROM jobs').length, 1);
    assert.equal(recovered.all('SELECT * FROM observations').length, 1);
    assert.equal(recovered.all('SELECT * FROM windows').length, 1);
    recovered.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('overlapping worker ticks never start duplicate operations for one account', async () => {
  let calls = 0;
  let finish!: () => void;
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  const { store, account, engine } = fixture({ execute: async () => { calls++; await blocked; return null; } });
  store.run('UPDATE accounts SET next_poll=?', Date.now() + HOUR);
  engine.enqueue(account(), 'manual', 'manual:a', Date.now());
  const first = engine.tick();
  await engine.tick();
  assert.equal(calls, 1);
  finish();
  await first;
  assert.equal(store.all('SELECT * FROM jobs').length, 0);
  store.close();
});
test('schedule edits and credential replacement invalidate older queued work', async () => {
  let calls = 0;
  const { store, account, engine } = fixture({ execute: async () => { calls++; return null; } });
  engine.enqueue(account(), 'scheduled', 'scheduled:a', Date.now());
  store.run('UPDATE users SET schedule_version=schedule_version+1');
  await engine.executeJob(account(), store.all<Job>('SELECT * FROM jobs')[0]!, Date.now());
  assert.equal(calls, 0);
  engine.enqueue(account(), 'manual', 'manual:a', Date.now());
  store.run('UPDATE accounts SET version=version+1');
  await engine.executeJob(account(), store.all<Job>('SELECT * FROM jobs')[0]!, Date.now());
  assert.equal(calls, 0);
  assert.equal(store.all('SELECT * FROM jobs').length, 0);
  store.close();
});
test('different opening reasons share one retry operation and weekly resets take priority', () => {
  const { store, account, engine } = fixture();
  const now = Date.now();
  engine.enqueue(account(), 'scheduled', 'anchor:a', now, now + FIVE);
  store.run('UPDATE jobs SET due=?,attempts=2', now + 60_000);
  engine.enqueue(account(), 'manual', 'manual:a', now + 1000);
  engine.enqueue(account(), 'weekly_reset', 'weekly:a', now + 2000);
  const jobs = store.all<Job>('SELECT * FROM jobs');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.reason, 'weekly_reset');
  assert.equal(jobs[0]!.expires, null);
  assert.equal(jobs[0]!.attempts, 2);
  store.close();
});
