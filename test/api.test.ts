import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.js';
import { Vault, hash } from '../src/security.js';
import { Engine } from '../src/engine.js';
import { createApi } from '../src/api.js';
import { Telegram } from '../src/telegram.js';

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
const credentials = { auth_mode: 'chatgpt', tokens: { access_token: 'access-secret', refresh_token: 'refresh-secret', id_token: 'id-secret' } };
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
    const response = await f.app.inject({ method: 'POST', url: '/v1/accounts', headers: a, payload: { provider: 'codex', label: 'work', credentials } });
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
    const result = await f.app.inject({ method: 'POST', url: '/v1/accounts', headers, payload: { provider: 'codex', label: 'work', credentials: { secret: 'super-sensitive' } } });
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
