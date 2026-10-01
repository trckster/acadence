import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, type Account } from '../src/db.js';
import { Vault } from '../src/security.js';
import { Engine } from '../src/engine.js';
import { Telegram } from '../src/telegram.js';
import { seeAccounts } from '../src/accounts.js';
import { ProviderError } from '../src/providers.js';

function update(text: string, id = 123, updateId = 1) {
  return { update_id: updateId, message: { message_id: updateId, chat: { type: 'private', id }, from: { id }, text } };
}

function fixture(timezone = 'UTC') {
  const store = new Store(':memory:');
  const vault = new Vault(Buffer.alloc(32, 7).toString('base64'));
  store.run('INSERT INTO users(id,telegram_id,timezone) VALUES(?,?,?)', 'u', '123', timezone);
  store.run("INSERT INTO users(id,telegram_id,timezone) VALUES('other','456','UTC')");
  const calls: { method: string; data: any }[] = [];
  let polls = 0;
  const engine = new Engine(store, vault, { execute: async (_provider, _credentials, action) => {
    assert.equal(action, 'poll');
    polls++;
    return { windows: [
      { kind: 'five_hour', used: 12, resetsAt: null },
      { kind: 'weekly', used: 25, resetsAt: Date.parse('2030-09-25T03:59:00Z') },
      { kind: 'weekly_fable', used: 31.5, resetsAt: Date.parse('2030-09-25T03:59:00Z') }
    ] };
  } });
  const telegram = new Telegram(store, async (method, data) => { calls.push({ method, data }); }, undefined,
    user => seeAccounts(store, vault, engine, user.id));
  const add = (id = 'a', user = 'u', status = 'active', email = `${id}@example.com`) => {
    store.run('INSERT INTO accounts(id,user_id,provider,category,status,credentials) VALUES(?,?,?,?,?,?)',
      id, user, 'claude', 'personal', status, vault.seal({ email, claudeAiOauth: {} }, id));
    return store.get<Account>('SELECT * FROM accounts WHERE id=?', id)!;
  };
  const text = () => calls.filter(call => call.method === 'sendMessage').map(call => call.data.text).join('');
  return { store, engine, telegram, calls, add, text, polls: () => polls };
}

test('/see refreshes only owned active accounts, showing usage, statuses and pending work in the user timezone', async () => {
  const f = fixture('Asia/Tokyo');
  try {
    const account = f.add();
    f.engine.enqueue(account, 'manual', 'manual:a', Date.now());
    f.add('paused', 'u', 'monitoring_paused');
    f.add('expired', 'u', 'reauth_required');
    f.add('foreign', 'other');
    f.store.run("INSERT INTO windows(account_id,kind,used,resets_at,sampled_at) VALUES('a','weekly',99,NULL,?)", Date.now());
    await f.telegram.accept(update('/see@acadence_bot\n'));
    await f.telegram.send();
    assert.equal(f.polls(), 1);
    assert.match(f.text(), /claude \/ personal \/ a@example.com\n    active/);
    assert.match(f.text(), /5h: 12% used; resets not active/);
    assert.match(f.text(), /Week: 25% used; resets 2030-09-25 12:59/);
    assert.match(f.text(), /Week \(Fable\): 31\.5% used; resets 2030-09-25 12:59/);
    assert.match(f.text(), /1 pending operation\(s\)/);
    assert.match(f.text(), /paused@example.com\n    inactive\n    subscription unavailable; run acadence reauth/);
    assert.match(f.text(), /expired@example.com\n    reauth required\n    Usage unavailable: reauthentication required/);
    assert.doesNotMatch(f.text(), /foreign|99%|last known|claudeAiOauth/);
    assert.ok(f.calls.every(call => call.data.chat_id === '123'));
    await f.telegram.accept(update('/see@acadence_bot\n'));
    await f.telegram.send();
    assert.equal(f.polls(), 1, 'replayed update must not refresh or send again');
    assert.equal(f.calls.length, 1);
  } finally { f.store.close(); }
});

test('/see labels saved usage on contention and provider failure, but hides it on authentication failure', async () => {
  const f = fixture();
  try {
    const account = f.add();
    f.engine.observe(account, { windows: [{ kind: 'weekly', used: 42, resetsAt: null }] }, Date.parse('2026-09-25T03:59:00Z'));
    f.engine.busy.add(account.id);
    await f.telegram.accept(update('/see'));
    await f.telegram.send();
    assert.equal(f.polls(), 0);
    assert.match(f.text(), /Usage unavailable: account operation in progress/);
    assert.match(f.text(), /Week: 42% used; resets not active \(last known; checked 2026-09-25 03:59\)/);
    f.engine.busy.clear();
    f.calls.length = 0;
    f.engine.providers.execute = async () => { throw new Error('offline'); };
    await f.telegram.accept(update('/see', 123, 2));
    await f.telegram.send();
    assert.match(f.text(), /Usage unavailable: provider unavailable/);
    assert.match(f.text(), /42%.*last known/);
    f.calls.length = 0;
    f.engine.providers.execute = async () => { throw new ProviderError('auth'); };
    await f.telegram.accept(update('/see', 123, 3));
    await f.telegram.send();
    assert.match(f.text(), /reauth required/);
    assert.doesNotMatch(f.text(), /42%|last known/);
  } finally { f.store.close(); }
});

test('/help and bare /start explain commands before sign-in, and /see handles unlinked and empty users', async () => {
  const f = fixture();
  try {
    for (const command of ['/help', '/start@acadence_bot']) {
      await f.telegram.accept(update(command, 789));
      assert.match(f.text(), /\/see.*current usage/);
      assert.match(f.text(), /\/help.*help/);
      assert.match(f.text(), /acadence login/);
      assert.match(f.text(), /acadence connect/);
      f.calls.length = 0;
    }
    await f.telegram.accept(update('/see', 789));
    assert.match(f.text(), /Run acadence login/);
    assert.equal(f.store.all('SELECT * FROM users').length, 2, 'commands must not implicitly link a user');
    f.calls.length = 0;
    await f.telegram.accept(update('/see'));
    await f.telegram.send();
    assert.equal(f.text(), 'No accounts connected');
  } finally { f.store.close(); }
});

test('commands ignore groups, bots, mismatched identities and unrelated text', async () => {
  const f = fixture();
  try {
    f.add();
    const group = update('/see'); group.message.chat.type = 'group';
    const mismatch = update('/see'); mismatch.message.from.id = 456;
    const bot = { ...update('/help'), message: { ...update('/help').message, from: { id: 123, is_bot: true } } };
    for (const item of [group, mismatch, bot, update('/see extra'), update('see'), update('/unknown')]) await f.telegram.accept(item);
    await f.telegram.send();
    assert.equal(f.polls(), 0);
    assert.deepEqual(f.calls, []);
  } finally { f.store.close(); }
});

test('long /see replies are split without losing text and queued replies survive delivery failure', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 20; i++) f.add(`a${i}`, 'u', 'active', `${'x'.repeat(200)}${i}@example.com`);
    await f.telegram.accept(update('/see'));
    const queued = f.store.all<{ body: string }>("SELECT body FROM notifications WHERE dedupe LIKE 'command:%' ORDER BY id");
    assert.ok(queued.length > 1);
    assert.ok(queued.every(item => item.body.length <= 4096));
    const failed = new Telegram(f.store, async () => { throw new Error('offline'); });
    await failed.send();
    assert.equal(f.store.all('SELECT id FROM notifications WHERE sent IS NULL').length, queued.length);
    await f.telegram.send(Date.now() + 120_000);
    assert.equal(f.text(), queued.map(item => item.body).join(''));
    for (let i = 0; i < 20; i++) assert.ok(f.text().includes(`${i}@example.com`));
    assert.equal(f.polls(), 20);
  } finally { f.store.close(); }
});

test('poll dispatches commands and advances its offset even when an unlinked chat blocks replies', async () => {
  const f = fixture();
  try {
    let requests = 0;
    const telegram = new Telegram(f.store, async (method, data) => {
      if (method === 'sendMessage') throw new Error('bot blocked');
      assert.equal(method, 'getUpdates');
      if (requests++ === 0) {
        assert.equal((data as { offset: number }).offset, 0);
        return [update('/help', 789, 10), update('/help', 123, 11)];
      }
      assert.equal((data as { offset: number }).offset, 12);
      telegram.stop();
      return [];
    });
    await telegram.poll();
    await f.telegram.send();
    assert.match(f.text(), /Acadence bot commands/);
    assert.equal(f.store.get<{ value: string }>("SELECT value FROM metadata WHERE key='telegram_offset'")!.value, '12');
  } finally { f.store.close(); }
});

test('command menu advertises /see and /help in private chats', async () => {
  const f = fixture();
  try {
    await f.telegram.registerCommands();
    assert.equal(f.calls[0]!.method, 'setMyCommands');
    assert.deepEqual(f.calls[0]!.data.scope, { type: 'all_private_chats' });
    assert.deepEqual(f.calls[0]!.data.commands.map((command: { command: string }) => command.command), ['see', 'help']);
  } finally { f.store.close(); }
});
