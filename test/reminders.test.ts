import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, type Account } from '../src/db.js';
import { Engine } from '../src/engine.js';
import { Telegram } from '../src/telegram.js';
import { Vault } from '../src/security.js';
import { HOUR, type Snapshot, type WindowKind } from '../src/domain.js';
import { ProviderError } from '../src/providers.js';

function fixture(kind: WindowKind = 'five_hour') {
  const store = new Store(':memory:');
  const vault = new Vault(Buffer.alloc(32, 7).toString('base64'));
  store.run("INSERT INTO users(id,telegram_id,timezone) VALUES('u','123','UTC')");
  store.run("INSERT INTO accounts(id,user_id,provider,category,credentials) VALUES('a','u','claude','work',?)",
    vault.seal({}, 'a'));
  const account = store.get<Account>("SELECT * FROM accounts WHERE id='a'")!;
  const now = Date.now();
  const resetsAt = now + HOUR - 60_000;
  let snapshot: Snapshot = { windows: [{ kind, used: 91, resetsAt }] };
  let polls = 0;
  const engine = new Engine(store, vault, { execute: async (_provider, _credentials, action) => {
    assert.equal(action, 'poll');
    polls++;
    return snapshot;
  } });
  engine.observe(account, { windows: [{ kind, used: 40, resetsAt }] }, now - HOUR);
  engine.reminders(now);
  const sent: string[] = [];
  const telegram = new Telegram(store, async (_method, data) => { sent.push((data as { text: string }).text); },
    (accountId, dedupe) => engine.refreshReminder(accountId, dedupe));
  return { store, engine, telegram, sent, resetsAt, polls: () => polls,
    snapshot: (value: Snapshot) => { snapshot = value; } };
}

for (const kind of ['five_hour', 'weekly'] as const) {
  test(`${kind} reminder pulls fresh usage immediately before sending`, async () => {
    const f = fixture(kind);
    try {
      await f.telegram.send();
      assert.equal(f.polls(), 1);
      assert.equal(f.sent.length, 1);
      assert.match(f.sent[0]!, /9% left/);
      assert.doesNotMatch(f.sent[0]!, /60% left/);
      assert.equal(f.store.get<{ body: string }>('SELECT body FROM notifications')!.body, f.sent[0]);
      await f.telegram.send();
      assert.equal(f.polls(), 1);
    } finally { f.store.close(); }
  });

  for (const used of [97, 98, 100]) {
    test(`${kind} reminder rechecks the remaining quota threshold at ${used}% used`, async () => {
      const f = fixture(kind);
      try {
        f.snapshot({ windows: [{ kind, used, resetsAt: f.resetsAt }] });
        await f.telegram.send();
        assert.equal(f.polls(), 1);
        assert.equal(f.sent.length, used === 97 ? 1 : 0);
        assert.equal(f.store.all('SELECT * FROM notifications WHERE sent IS NULL').length, 0);
      } finally { f.store.close(); }
    });
  }
}

for (const scenario of ['missing', 'expired', 'rolled over', 'weekly exhausted'] as const) {
  test(`a fresh ${scenario} window suppresses the queued reminder`, async () => {
    const f = fixture();
    try {
      f.snapshot({ windows: scenario === 'missing' ? [] : [
        { kind: 'five_hour', used: 91, resetsAt: scenario === 'expired' ? Date.now() - 1 :
          scenario === 'rolled over' ? Date.now() + 5 * HOUR : f.resetsAt },
        ...(scenario === 'weekly exhausted' ? [{ kind: 'weekly' as const, used: 100, resetsAt: Date.now() + 24 * HOUR }] : [])
      ] });
      await f.telegram.send();
      assert.deepEqual(f.sent, []);
      assert.equal(f.store.all("SELECT * FROM notifications WHERE dedupe LIKE 'reminder:%'").length, 0);
    } finally { f.store.close(); }
  });
}

test('failed refresh defers delivery and retries with fresh usage', async () => {
  const f = fixture();
  try {
    const execute = f.engine.providers.execute;
    f.engine.providers.execute = async () => { throw new Error('offline'); };
    await f.telegram.send();
    assert.deepEqual(f.sent, []);
    assert.equal(f.store.get<{ attempts: number }>('SELECT attempts FROM notifications')!.attempts, 1);
    f.engine.providers.execute = execute;
    f.store.run('UPDATE notifications SET due=0');
    await f.telegram.send();
    assert.match(f.sent[0]!, /9% left/);
  } finally { f.store.close(); }
});

test('Telegram retry pulls usage again and suppresses newly exhausted quota', async () => {
  const f = fixture();
  try {
    const telegram = new Telegram(f.store, async () => { throw new Error('Telegram unavailable'); },
      (accountId, dedupe) => f.engine.refreshReminder(accountId, dedupe));
    await telegram.send();
    assert.equal(f.polls(), 1);
    f.snapshot({ windows: [{ kind: 'five_hour', used: 100, resetsAt: f.resetsAt }] });
    f.store.run('UPDATE notifications SET due=0');
    await f.telegram.send();
    assert.equal(f.polls(), 2);
    assert.deepEqual(f.sent, []);
    assert.equal(f.store.all('SELECT * FROM notifications').length, 0);
  } finally { f.store.close(); }
});

test('busy accounts defer reminders without using cached values', async () => {
  const f = fixture();
  try {
    f.engine.busy.add('a');
    await f.telegram.send();
    assert.equal(f.polls(), 0);
    assert.deepEqual(f.sent, []);
    f.engine.busy.clear();
    f.store.run('UPDATE notifications SET due=0');
    await f.telegram.send();
    assert.match(f.sent[0]!, /9% left/);
  } finally { f.store.close(); }
});

test('authentication failure replaces the reminder with a pause warning', async () => {
  const f = fixture();
  try {
    f.engine.providers.execute = async () => { throw new ProviderError('auth'); };
    await f.telegram.send();
    assert.deepEqual(f.sent, []);
    const warning = f.store.get<{ dedupe: string; attempts: number }>('SELECT dedupe,attempts FROM notifications')!;
    assert.match(warning.dedupe, /^paused:/);
    assert.equal(warning.attempts, 0);
    await f.telegram.send();
    assert.match(f.sent[0]!, /Monitoring paused/);
  } finally { f.store.close(); }
});

test('an unwired sender cannot deliver cached reminders', async () => {
  const f = fixture();
  try {
    const sender = new Telegram(f.store, async () => assert.fail('sent stale usage'));
    await sender.send();
    assert.equal(f.store.get<{ attempts: number }>('SELECT attempts FROM notifications')!.attempts, 1);
  } finally { f.store.close(); }
});
