import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeUsage, parseCodexUsage, parseCredentials, cleanEnvironment } from '../src/providers.js';
import { Vault } from '../src/security.js';

const window = (minutes: number) => ({ usedPercent: 25, windowDurationMins: minutes, resetsAt: 1_800_000_000 });
test('Codex detects weekly-only plans even when the weekly limit is primary', () => {
  const snapshot = parseCodexUsage({ rateLimits: { primary: window(10080), secondary: null } });
  assert.deepEqual(snapshot.windows.map(w => w.kind), ['weekly']);
  assert.equal(snapshot.windows[0]!.resetsAt, 1_800_000_000_000);
});
test('Codex chooses the codex bucket and identifies windows by duration', () => {
  const snapshot = parseCodexUsage({ rateLimits: { primary: window(60), secondary: null }, rateLimitsByLimitId: { codex: { primary: window(300), secondary: window(10080) } } });
  assert.deepEqual(snapshot.windows.map(w => w.kind), ['five_hour','weekly']);
  assert.throws(() => parseCodexUsage({ rateLimits: { primary: window(60), secondary: null } }));
});
test('Claude preserves inactive and absent window distinctions', () => {
  const snapshot = parseClaudeUsage({ five_hour: { utilization: 0, resets_at: null }, seven_day: null });
  assert.deepEqual(snapshot.windows, [{ kind: 'five_hour', used: 0, resetsAt: null }]);
  assert.throws(() => parseClaudeUsage({ error: 'upstream outage' }));
  assert.throws(() => parseClaudeUsage({ five_hour: { utilization: 500, resets_at: null }, seven_day: null }));
});
test('API keys cannot accidentally become subscription accounts', () => {
  assert.throws(() => parseCredentials('codex', { OPENAI_API_KEY: 'test-key' }));
  assert.throws(() => parseCredentials('claude', { apiKey: 'test-key' }));
});
test('credentials are authenticated, randomized, and bound to their account', () => {
  const vault = new Vault(Buffer.alloc(32, 1).toString('base64'));
  const encrypted = vault.seal({ token: 'sensitive' }, 'account-a');
  assert.ok(!encrypted.includes('sensitive'));
  assert.deepEqual(vault.open(encrypted, 'account-a'), { token: 'sensitive' });
  assert.notEqual(vault.seal({ token: 'sensitive' }, 'account-a'), encrypted);
  assert.throws(() => vault.open(encrypted, 'account-b'));
  assert.throws(() => new Vault(Buffer.alloc(32, 2).toString('base64')).open(encrypted, 'account-a'));
});
test('provider processes never inherit backend secrets or user provider configuration', () => {
  process.env.ACADENCE_TEST_SECRET = 'secret';
  const env = cleanEnvironment('/isolated');
  assert.equal(env.ACADENCE_TEST_SECRET, undefined);
  assert.equal(env.HOME, '/isolated');
  assert.equal(env.CODEX_HOME, '/isolated/.codex');
  delete process.env.ACADENCE_TEST_SECRET;
});
