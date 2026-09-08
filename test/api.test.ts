import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.js';
import { Vault, hash } from '../src/security.js';
import { Engine } from '../src/engine.js';
import { createApi } from '../src/api.js';
import { Telegram } from '../src/telegram.js';
import { ProviderError } from '../src/providers.js';

async function fixture() {
  const store = new Store(':memory:');
  const vault = new Vault(Buffer.alloc(32, 1).toString('base64'));
  const engine = new Engine(store, vault, { execute: async () => ({ windows: [] }) });
  const telegram = new Telegram(store, async () => ({}));
  const app = await createApi(store, vault, engine, 'acadence_test_bot');
  const login = async (id: number, timezone = 'Europe/Rome') => {
    const start = await app.inject({ method: 'POST', url: '/v1/auth/device', payload: { timezone } });
    assert.equal(start.statusCode, 200);
    const { device, url } = start.json();
    const code = new URL(url).searchParams.get('start');
    telegram.accept({ message: { chat: { type: 'private', id }, from: { id }, text: `/start ${code}` } });
    const response = await app.inject({ method: 'POST', url: '/v1/auth/poll', payload: { device } });
    assert.equal(response.statusCode, 200);
    return { authorization: `Bearer ${response.json().token}` };
  };
  return { store, vault, engine, telegram, app, login, close: async () => { await app.close(); store.close(); } };
}
const credentials = { auth_mode: 'chatgpt', tokens: { access_token: 'access-secret', refresh_token: 'refresh-secret', id_token: `header.${Buffer.from(JSON.stringify({ email: 'test@example.com' })).toString('base64url')}.signature` } };
test('on-demand usage is scoped, fresh, locked against overlap, and hides stale data on failure', async () => {
  const f = await fixture();
  let release = () => {};
  try {
    const headers = await f.login(1);
    const other = await f.login(2);
    const id = (await f.app.inject({ method: 'POST', url: '/v1/accounts', headers, payload: { provider: 'codex', category: 'personal', credentials } })).json().id;
    const url = `/v1/accounts/${id}/usage`;
    f.store.run('INSERT INTO windows(account_id,kind,used,resets_at,sampled_at) VALUES(?,?,?,?,?)', id, 'weekly', 99, null, 1);
    let calls = 0;
    let started = () => {};
    const entered = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.engine.providers.execute = async (_provider, _credentials, action) => {
      calls++;
      assert.equal(action, 'poll');
      started();
      await gate;
      return { windows: [{ kind: 'weekly', used: 12, resetsAt: null }] };
    };
    assert.equal((await f.app.inject({ method: 'POST', url })).statusCode, 401);
    assert.equal((await f.app.inject({ method: 'POST', url, headers: other })).statusCode, 404);
    assert.equal(calls, 0);
    const pending = f.app.inject({ method: 'POST', url, headers });
    void pending.then(() => {});
    await entered;
    const busy = (await f.app.inject({ method: 'POST', url, headers })).json();
    assert.deepEqual(busy.limits, []);
    assert.match(busy.refreshError, /operation in progress/);
    assert.equal((await f.app.inject({ method: 'DELETE', url: `/v1/accounts/${id}`, headers })).statusCode, 409);
    await f.engine.tick();
    assert.equal(calls, 1);
    release();
    const fresh = (await pending).json();
    assert.equal(fresh.refreshError, null);
    assert.deepEqual(fresh.limits, [{ kind: 'weekly', used: 12, resetsAt: null }]);
    assert.equal(f.engine.busy.size, 0);
    f.engine.providers.execute = async () => { throw new ProviderError('unavailable'); };
    const failed = (await f.app.inject({ method: 'POST', url, headers })).json();
    assert.deepEqual(failed.limits, []);
    assert.equal(failed.refreshError, 'unavailable');
    assert.equal(f.store.get<{ used: number }>('SELECT used FROM windows WHERE account_id=?', id)!.used, 12);
    assert.equal(f.engine.busy.size, 0);
    f.engine.providers.execute = async () => { throw new ProviderError('auth'); };
    const expired = (await f.app.inject({ method: 'POST', url, headers })).json();
    assert.equal(expired.status, 'reauth_required');
    assert.deepEqual(expired.limits, []);
    const skipped = (await f.app.inject({ method: 'POST', url, headers })).json();
    assert.equal(skipped.refreshError, 'reauthentication required');
    assert.deepEqual(skipped.limits, []);
  } finally { release(); await f.close(); }
});
test('Telegram sign-in binds identity, stores first timezone, hashes bearer tokens and consumes device once', async () => {
  const f = await fixture();
  try {
    const start = (await f.app.inject({ method: 'POST', url: '/v1/auth/device', payload: { timezone: 'Asia/Tokyo' } })).json();
    const code = new URL(start.url).searchParams.get('start');
    f.telegram.accept({ message: { chat: { type: 'group', id: 1 }, from: { id: 1 }, text: `/start ${code}` } });
    assert.equal((await f.app.inject({ method: 'POST', url: '/v1/auth/poll', payload: { device: start.device } })).statusCode, 202);
    f.telegram.accept({ message: { chat: { type: 'private', id: 1 }, from: { id: 1 }, text: `/start ${code}` } });
    const result = await f.app.inject({ method: 'POST', url: '/v1/auth/poll', payload: { device: start.device } });
    const token = result.json().token;
    assert.equal(f.store.get<{ hash: string }>('SELECT hash FROM tokens')!.hash, hash(token));
    assert.equal((await f.app.inject({ method: 'POST', url: '/v1/auth/poll', payload: { device: start.device } })).statusCode, 410);
    const headers = await f.login(1, 'UTC');
    assert.equal((await f.app.inject({ url: '/v1/schedule', headers })).json().timezone, 'Asia/Tokyo');
  } finally { await f.close(); }
});
test('accounts, schedules, triggers and deletion stay within each tenant', async () => {
  const f = await fixture();
  try {
    const a = await f.login(1);
    const b = await f.login(2);
    const response = await f.app.inject({ method: 'POST', url: '/v1/accounts', headers: a, payload: { provider: 'codex', category: 'work', credentials } });
    const id = response.json().id;
    assert.equal(response.statusCode, 200);
    assert.ok(!JSON.stringify(f.store.all('SELECT credentials FROM accounts')).includes('access-secret'));
    const list = await f.app.inject({ url: '/v1/accounts', headers: a });
    assert.ok(!list.body.includes('access-secret'));
    assert.ok(!list.body.includes('credentials'));
    assert.equal((await f.app.inject({ url: '/v1/accounts', headers: b })).json().length, 0);
    for (const method of ['PUT','DELETE'] as const) {
      assert.equal((await f.app.inject({ method, url: `/v1/accounts/${id}`, headers: b, ...(method === 'PUT' ? { payload: { credentials } } : {}) })).statusCode, 404);
    }
    await f.app.inject({ method: 'PUT', url: '/v1/schedule', headers: a, payload: { anchors: ['13:00','06:00','06:00'], timezone: 'UTC' } });
    assert.deepEqual((await f.app.inject({ url: '/v1/schedule', headers: a })).json().anchors, ['06:00','13:00']);
    assert.deepEqual((await f.app.inject({ url: '/v1/schedule', headers: b })).json().anchors, []);
    await f.app.inject({ method: 'POST', url: '/v1/trigger', headers: a, payload: {} });
    await f.app.inject({ method: 'POST', url: '/v1/trigger', headers: a, payload: {} });
    assert.equal(f.store.all('SELECT * FROM jobs').length, 1);
    f.engine.busy.add(id);
    assert.equal((await f.app.inject({ method: 'DELETE', url: `/v1/accounts/${id}`, headers: a })).statusCode, 409);
    f.engine.busy.delete(id);
    assert.equal((await f.app.inject({ method: 'DELETE', url: `/v1/accounts/${id}`, headers: a })).statusCode, 200);
    assert.equal(f.store.all('SELECT * FROM jobs').length, 0);
    await f.app.inject({ method: 'DELETE', url: '/v1/auth', headers: a });
    assert.equal((await f.app.inject({ url: '/v1/accounts', headers: a })).statusCode, 401);
    assert.equal((await f.app.inject({ url: '/v1/accounts', headers: b })).statusCode, 200);
  } finally { await f.close(); }
});
test('validation and failed authentication never reflect credentials', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.app.inject({ url: '/v1/accounts' })).statusCode, 401);
    const headers = await f.login(1);
    const result = await f.app.inject({ method: 'POST', url: '/v1/accounts', headers, payload: { provider: 'codex', category: 'work', credentials: { secret: 'super-sensitive' } } });
    assert.equal(result.statusCode, 400);
    assert.ok(!result.body.includes('super-sensitive'));
    assert.equal((await f.app.inject({ method: 'PUT', url: '/v1/schedule', headers, payload: { timezone: 'Not/Real', anchors: ['25:90'] } })).statusCode, 400);
    assert.equal((await f.app.inject({ url: '/health' })).statusCode, 200);
  } finally { await f.close(); }
});
test('Telegram outbox retains failures and sends only to the associated user', async () => {
  const f = await fixture();
  try {
    await f.login(123);
    const sent: any[] = [];
    let fail = true;
    const telegram = new Telegram(f.store, async (_method, body) => { if (fail) throw new Error('offline'); sent.push(body); });
    await telegram.send();
    assert.equal(f.store.get<{ attempts: number }>('SELECT attempts FROM notifications')!.attempts, 1);
    fail = false;
    await telegram.send(Date.now() + 120_000);
    assert.equal(sent[0].chat_id, '123');
    await telegram.send(Date.now() + 120_000);
    assert.equal(sent.length, 1);
  } finally { await f.close(); }
});


test('account identity is service, type and email, and reauth preserves identity', async () => {
  const f = await fixture();
  try {
    const headers = await f.login(1);
    const other = await f.login(2);
    const codex = (email: string) => ({ ...credentials, tokens: { ...credentials.tokens,
      id_token: `header.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.signature` } });
    const connect = (email: string, category = 'personal', auth = headers) => f.app.inject({
      method: 'POST', url: '/v1/accounts', headers: auth, payload: { provider: 'codex', category, credentials: codex(email) }
    });
    const first = await connect('first@example.com');
    assert.equal(first.statusCode, 200);
    assert.equal((await connect('second@example.com')).statusCode, 200);
    assert.equal((await connect('FIRST@example.com')).statusCode, 409);
    assert.equal((await connect('first@example.com', 'work')).statusCode, 200);
    assert.equal((await connect('first@example.com', 'personal', other)).statusCode, 200);
    assert.equal((await connect('third@example.com', 'arbitrary')).statusCode, 400);
    assert.equal((await connect('invalid')).statusCode, 400);
    const claude = await f.app.inject({ method: 'POST', url: '/v1/accounts', headers, payload: {
      provider: 'claude', category: 'personal', credentials: { email: 'first@example.com', claudeAiOauth: {
        accessToken: 'a', refreshToken: 'r', expiresAt: 123, scopes: []
      } }
    } });
    assert.equal(claude.statusCode, 200);
    const url = `/v1/accounts/${first.json().id}`;
    assert.equal((await f.app.inject({ method: 'PUT', url, headers, payload: { credentials: codex('second@example.com') } })).statusCode, 409);
    assert.equal((await f.app.inject({ method: 'PUT', url, headers, payload: { credentials: codex('FIRST@example.com') } })).statusCode, 200);
    const rows = (await f.app.inject({ url: '/v1/accounts', headers })).json();
    assert.equal(rows.length, 4);
    assert.ok(rows.every((row: any) => !('label' in row) && row.category && row.email));
  } finally { await f.close(); }
});

test('legacy duplicate identities can reauthenticate without allowing new duplicates', async () => {
  const f = await fixture();
  try {
    const headers = await f.login(1);
    const connected = await f.app.inject({ method: 'POST', url: '/v1/accounts', headers,
      payload: { provider: 'codex', category: 'personal', credentials } });
    const id = connected.json().id;
    f.store.run(`INSERT INTO accounts(id,user_id,provider,category,credentials)
      SELECT 'legacy',user_id,provider,category,? FROM accounts WHERE id=?`, f.vault.seal(credentials, 'legacy'), id);
    for (const accountId of [id, 'legacy']) {
      assert.equal((await f.app.inject({ method: 'PUT', url: `/v1/accounts/${accountId}`, headers,
        payload: { credentials } })).statusCode, 200);
    }
    assert.equal((await f.app.inject({ method: 'POST', url: '/v1/accounts', headers,
      payload: { provider: 'codex', category: 'personal', credentials } })).statusCode, 409);
    f.store.run('UPDATE accounts SET credentials=? WHERE id=?',
      f.vault.seal({ ...credentials, tokens: { ...credentials.tokens, id_token: 'email-unavailable' } }, 'legacy'), 'legacy');
    assert.equal((await f.app.inject({ method: 'PUT', url: '/v1/accounts/legacy', headers,
      payload: { credentials } })).statusCode, 409);
  } finally { await f.close(); }
});
