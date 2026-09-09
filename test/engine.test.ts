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
  store.run("INSERT INTO accounts(id,user_id,provider,category,credentials) VALUES('a','u','codex','work',?)", vault.seal(credentials, 'a'));
  const account = () => store.get<Account>("SELECT * FROM accounts WHERE id='a'")!;
  const engine = new Engine(store, vault, provider ?? { execute: async () => ({ windows: [] }) });
  return { store, account, engine };
}
test('a window expiring at 10:00 reopens without waiting for the 11:00 slot in Rome', () => {
  const { store, account, engine } = fixture();
  try {
    store.run("UPDATE users SET timezone='Europe/Rome',anchors='[\"06:00\"]'");
    engine.observe(account(), { windows: [{ kind: 'five_hour', used: 13,
      resetsAt: Date.parse('2026-09-09T10:00:16+02:00') }] }, Date.parse('2026-09-09T09:57:39+02:00'));
    for (const time of ['10:17:53', '10:27:23']) {
      const now = Date.parse(`2026-09-09T${time}+02:00`);
      engine.observe(account(), { windows: [{ kind: 'five_hour', used: 0, resetsAt: null }] }, now);
      engine.plan(now);
      assert.equal(account().next_session, Date.parse('2026-09-09T11:00:00+02:00'));
      assert.equal(store.all<Job>('SELECT * FROM jobs').length, 1);
      assert.equal(store.all<Job>('SELECT * FROM jobs')[0]!.reason, 'expiry');
    }
    engine.plan(Date.parse('2026-09-09T11:00:00+02:00'));
    assert.equal(store.all<Job>('SELECT * FROM jobs').length, 1);
    assert.equal(store.all<Job>('SELECT * FROM jobs')[0]!.reason, 'expiry');
  } finally { store.close(); }
});
test('weekly resets notify and open immediately even with an anchor nearby', () => {
  const { store, account, engine } = fixture();
  const now = Date.parse('2026-09-08T12:00:00Z');
  engine.observe(account(), { windows: [{ kind: 'five_hour', used: 70, resetsAt: now + HOUR }, { kind: 'weekly', used: 80, resetsAt: now + HOUR }] }, now - HOUR);
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
  engine.observe(account(), { windows: [{ kind: 'five_hour', used: 70, resetsAt: now + HOUR }] }, now - HOUR);
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
test('failed anchors keep retrying near another anchor until their operation expires', async () => {
  let calls = 0;
  const { store, account, engine } = fixture({ execute: async () => { calls++; throw new ProviderError('unavailable'); } });
  store.run('UPDATE users SET anchors=?', '["06:00","07:00"]');
  const now = Date.parse('2026-09-08T06:00:00Z');
  engine.enqueue(account(), 'anchor', 'anchor:a', now, now + HOUR);
  await engine.executeJob(account(), store.all<Job>('SELECT * FROM jobs')[0]!, now);
  await engine.executeJob(account(), store.all<Job>('SELECT * FROM jobs')[0]!, now + 60_000);
  assert.equal(calls, 2);
  await engine.executeJob(account(), store.all<Job>('SELECT * FROM jobs')[0]!, now + HOUR);
  assert.equal(calls, 2);
  assert.equal(store.all('SELECT * FROM jobs').length, 0);
  store.close();
});
test('slow provider operations cannot prevent another account anchor from being queued', async () => {
  let finish!: () => void;
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  const { store, account, engine } = fixture({ execute: async () => { await blocked; return null; } });
  const before = Date.parse('2026-09-08T05:59:59Z');
  store.run('UPDATE accounts SET next_poll=?', Date.now() + HOUR);
  store.run("INSERT INTO accounts(id,user_id,provider,category,credentials,next_poll,next_session) VALUES('b','u','codex','personal',?,?,?)", vault.seal(credentials, 'b'), Date.now() + HOUR, before + 1000);
  engine.enqueue(account(), 'manual', 'manual:a', before);
  const tick = engine.tick(before);
  await engine.tick(before + 1000);
  assert.equal(store.get<Job>("SELECT * FROM jobs WHERE account_id='b'")?.reason, 'anchor');
  finish();
  await tick;
  store.close();
});

test('ordinary expiry queues one opening without a quota-restoration notification', () => {
  const { store, account, engine } = fixture();
  const now = Date.parse('2026-09-08T12:00:00Z');
  for (const kind of ['five_hour', 'weekly'] as const) {
    engine.observe(account(), { windows: [{ kind, used: 70, resetsAt: now }] }, now - HOUR);
    engine.observe(account(), { windows: [{ kind, used: 0, resetsAt: null }] }, now);
    engine.observe(account(), { windows: [{ kind, used: 1, resetsAt: now + FIVE }] }, now + 1000);
    engine.observe(account(), { windows: [{ kind, used: 1, resetsAt: now + FIVE + 723 }] }, now + 2000);
  }
  assert.equal(store.all('SELECT * FROM notifications').length, 0);
  assert.equal(store.all<Job>('SELECT * FROM jobs').length, 1);
  assert.equal(store.all<Job>('SELECT * FROM jobs')[0]!.reason, 'expiry');
  store.close();
});

test('reminders survive timestamp drift and restart, and repeat for the next window', () => {
  const directory = mkdtempSync(join(tmpdir(), 'acadence-reminders-'));
  try {
    const path = join(directory, 'test.sqlite');
    const { store, account, engine } = fixture(undefined, path);
    const now = Date.parse('2026-09-08T12:00:00Z');
    engine.observe(account(), { windows: [{ kind: 'five_hour', used: 20, resetsAt: now + HOUR }] }, now);
    engine.reminders(now);
    for (const drift of [-30_277, -30_040, -30_004]) {
      engine.observe(account(), { windows: [{ kind: 'five_hour', used: 20, resetsAt: now + HOUR + drift }] }, now + 5000);
      engine.reminders(now + 5000);
    }
    assert.deepEqual(store.all<{ body: string }>('SELECT body FROM notifications').map(n => n.body), [
      'codex / work / email unavailable\n⏳ 5h: 20% used; resets in 1h 0m'
    ]);
    store.close();
    const recovered = new Store(path);
    const worker = new Engine(recovered, vault, { execute: async () => null });
    worker.reminders(now + 10_000);
    assert.equal(recovered.all('SELECT * FROM notifications').length, 1);
    worker.observe(recovered.get<Account>("SELECT * FROM accounts WHERE id='a'")!, {
      windows: [{ kind: 'five_hour', used: 0, resetsAt: now + HOUR + FIVE }]
    }, now + HOUR);
    worker.reminders(now + FIVE);
    assert.equal(recovered.all('SELECT * FROM notifications').length, 2);
    assert.equal(recovered.all('SELECT * FROM jobs').length, 0);
    recovered.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('notifications identify the provider account and format dates in the user timezone', () => {
  const { store, account, engine } = fixture();
  store.run("UPDATE users SET timezone='Europe/Rome'");
  const idToken = `header.${Buffer.from(JSON.stringify({ email: 'you@example.com' })).toString('base64url')}.signature`;
  store.run('UPDATE accounts SET credentials=?', vault.seal({ ...credentials, tokens: { ...credentials.tokens, id_token: idToken } }, 'a'));
  const now = Date.parse('2026-09-08T12:00:00Z');
  engine.observe(account(), { windows: [{ kind: 'weekly', used: 80, resetsAt: now + WEEK }] }, now - HOUR);
  engine.observe(account(), { windows: [{ kind: 'weekly', used: 0, resetsAt: now + WEEK }] }, now);
  assert.equal(store.get<{ body: string }>('SELECT body FROM notifications')!.body,
    'codex / work / you@example.com\n🎁 Quota restored before the scheduled reset.\nWeek: 0% used; resets 2026-09-15 14:00');
  store.close();
});

test('existing reminder keys from earlier versions suppress duplicate delivery', () => {
  const { store, account, engine } = fixture();
  const now = Date.now();
  engine.observe(account(), { windows: [{ kind: 'five_hour', used: 20, resetsAt: now + HOUR }] }, now);
  store.notify('u', 'a', `reminder:a:five_hour:0:${now + HOUR + 723}`, 'Already delivered', now);
  engine.reminders(now);
  assert.equal(store.all('SELECT * FROM notifications').length, 1);
  store.close();
});

test('expiry opens on the next tick, survives restart, and does not repeat on stale usage', async t => {
  const now = Date.parse('2026-09-09T10:00:16+02:00');
  t.mock.timers.enable({ apis: ['Date'], now });
  const directory = mkdtempSync(join(tmpdir(), 'acadence-expiry-'));
  let store: Store | undefined;
  try {
    const path = join(directory, 'test.sqlite');
    const original = fixture(undefined, path);
    original.store.run("UPDATE users SET anchors='[]'");
    original.engine.observe(original.account(), { windows: [{ kind: 'five_hour', used: 0, resetsAt: now }] }, now - HOUR);
    original.store.run('UPDATE accounts SET next_poll=?', now + HOUR);
    original.store.close();
    store = new Store(path);
    let opens = 0;
    const worker = new Engine(store, vault, { execute: async (_provider, _credentials, action) => {
      assert.equal(action, 'open'); opens++; return null;
    } });
    await worker.tick(now - 1);
    assert.equal(opens, 0);
    await worker.tick(now);
    assert.equal(opens, 1);
    assert.equal(store.get<Account>("SELECT * FROM accounts WHERE id='a'")!.last_success, now);
    await worker.tick(now + 5000);
    assert.equal(opens, 1);
    const account = store.get<Account>("SELECT * FROM accounts WHERE id='a'")!;
    worker.observe(account, { windows: [{ kind: 'five_hour', used: 0, resetsAt: now + FIVE }] }, now + 10_000);
    store.run('UPDATE accounts SET next_poll=?', now + FIVE + HOUR);
    t.mock.timers.tick(FIVE);
    await worker.tick(now + FIVE);
    assert.equal(opens, 2);
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('expiry retries retain backoff across ticks and ignore nearby anchors', async t => {
  const now = Date.parse('2026-09-09T12:59:55Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  let attempts = 0;
  const { store, account, engine } = fixture({ execute: async () => {
    attempts++;
    if (attempts === 1) throw new ProviderError('unavailable');
    return null;
  } });
  try {
    engine.observe(account(), { windows: [{ kind: 'five_hour', used: 99, resetsAt: now }] }, now - HOUR);
    store.run('UPDATE accounts SET next_poll=?', now + HOUR);
    await engine.tick(now);
    assert.equal(attempts, 1);
    t.mock.timers.tick(5000);
    await engine.tick(now + 5000);
    assert.equal(attempts, 1);
    assert.equal(store.get<Job>('SELECT * FROM jobs')!.due, now + 60_000);
    t.mock.timers.tick(55_000);
    await engine.tick(now + 60_000);
    assert.equal(attempts, 2);
    assert.equal(store.all('SELECT * FROM jobs').length, 0);
  } finally { store.close(); }
});

test('a fresh poll cancels expiry work when another client already opened a window', async t => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  const actions: string[] = [];
  const { store, account, engine } = fixture({ execute: async (_provider, _credentials, action) => {
    actions.push(action);
    return { windows: [{ kind: 'five_hour', used: 0, resetsAt: now + FIVE }] };
  } });
  try {
    engine.observe(account(), { windows: [{ kind: 'five_hour', used: 80, resetsAt: now }] }, now - HOUR);
    await engine.tick(now);
    assert.deepEqual(actions, ['poll']);
    assert.equal(store.all('SELECT * FROM jobs').length, 0);
  } finally { store.close(); }
});

test('weekly-only accounts reopen on expiry without daily schedule slots', async t => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  let opens = 0;
  const { store, account, engine } = fixture({ execute: async () => { opens++; return null; } });
  try {
    store.run("UPDATE users SET anchors='[]'");
    engine.observe(account(), { windows: [{ kind: 'weekly', used: 50, resetsAt: now }] }, now - HOUR);
    store.run('UPDATE accounts SET next_poll=?', now + HOUR);
    await engine.tick(now);
    await engine.tick(now + 5000);
    assert.equal(opens, 1);
  } finally { store.close(); }
});

test('expiry planning cannot replace a manual request when a poll finds a new window', async t => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  const actions: string[] = [];
  const { store, account, engine } = fixture({ execute: async (_provider, _credentials, action) => {
    actions.push(action);
    return action === 'poll' ? { windows: [{ kind: 'five_hour', used: 0, resetsAt: now + FIVE }] } : null;
  } });
  try {
    engine.observe(account(), { windows: [{ kind: 'five_hour', used: 50, resetsAt: now }] }, now - HOUR);
    engine.enqueue(account(), 'manual', 'manual:a', now);
    await engine.tick(now);
    assert.deepEqual(actions, ['poll', 'open']);
    assert.equal(store.all('SELECT * FROM jobs').length, 0);
  } finally { store.close(); }
});
