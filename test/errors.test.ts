import test from 'node:test';
import assert from 'node:assert/strict';
import { networkReason, requestTarget, responseJson } from '../src/errors.js';
import { telegramApi } from '../src/telegram.js';

test('network diagnostics retain nested causes without exposing arbitrary error text', () => {
  assert.equal(networkReason(new TypeError('fetch failed', { cause: Object.assign(new Error('secret-value'), { code: 'ENOTFOUND' }) })), 'DNS lookup failed (ENOTFOUND)');
  assert.equal(networkReason(new AggregateError([Object.assign(new Error(), { code: 'ECONNREFUSED' })])), 'connection refused (ECONNREFUSED)');
  assert.equal(networkReason(new DOMException('secret-value', 'TimeoutError')), 'connection timed out');
  assert.equal(networkReason(new Error('secret-value')), 'network request failed');
  const cyclic = new Error(); cyclic.cause = cyclic;
  assert.equal(networkReason(cyclic), 'network request failed');
  assert.equal(requestTarget('https://user:password@example.com/path?token=secret#secret', 'POST'), 'POST https://example.com/path');
});

test('malformed JSON retains HTTP status and destination without exposing response bodies', async () => {
  await assert.rejects(responseJson(new Response('<html>secret-value</html>', { status: 502 }), 'https://example.com/v1/auth/device', 'POST'), {
    message: 'POST https://example.com/v1/auth/device: HTTP 502; expected a JSON response'
  });
});

test('Telegram failures identify the operation and redact the bot token', async t => {
  const api = telegramApi('123:secret-value');
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error(), { code: 'ECONNREFUSED' }) }); });
  await assert.rejects(api('getMe', {}), { message: 'POST https://api.telegram.org/bot[redacted]/getMe: connection refused (ECONNREFUSED)' });
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ok: false, description: 'secret-value' }), { status: 401 }));
  await assert.rejects(api('getMe', {}), { message: 'POST https://api.telegram.org/bot[redacted]/getMe: HTTP 401; Telegram request rejected' });
});
