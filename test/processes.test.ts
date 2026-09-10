import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { claudeAccountEmail, Providers, type Credentials } from '../src/providers.js';

test('Claude email discovery uses isolated auth status and tolerates unavailable metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acadence-email-test-'));
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = `${dir}:${previousPath}`;
    await writeFile(join(dir, 'claude'), `#!/usr/bin/env node
if (process.argv.slice(2).join(' ') !== 'auth status --json' || process.env.CLAUDE_CONFIG_DIR !== process.env.HOME + '/.claude') process.exit(2);
process.stdout.write(JSON.stringify({ loggedIn: true, email: 'claude@example.com' }));
`, { mode: 0o700 });
    assert.equal(await claudeAccountEmail(dir), 'claude@example.com');
    await writeFile(join(dir, 'claude'), '#!/usr/bin/env node\nprocess.stdout.write("invalid-json");\n', { mode: 0o700 });
    assert.equal(await claudeAccountEmail(dir), undefined);
  } finally { process.env.PATH = previousPath; await rm(dir, { recursive: true, force: true }); }
});

const codex = { auth_mode: 'chatgpt' as const, tokens: { access_token: 'test-access', refresh_token: 'test-refresh', id_token: 'test-id' } };
test('Codex subprocess performs RPC initialization, waits for completion and saves rotated credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acadence-protocol-test-'));
  const previousPath = process.env.PATH;
  try {
    await writeFile(join(dir, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const path = process.env.CODEX_HOME + '/auth.json';
const auth = JSON.parse(fs.readFileSync(path));
auth.tokens.access_token = 'rotated';
fs.writeFileSync(path, JSON.stringify(auth));
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
let initialized = false;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') { initialized = true; send({ id: request.id, result: {} }); }
  else if (request.method === 'initialized') {}
  else if (!initialized) process.exit(2);
  else if (request.method === 'account/read') send({ id: request.id, result: { account: { type: 'chatgpt' } } });
  else if (request.method === 'account/rateLimits/read') send({ id: request.id, result: { rateLimits: { primary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: 1800000000 }, secondary: null } } });
  else if (request.method === 'thread/start') {
    if (request.params.model !== 'gpt-5.6-luna') process.exit(2);
    send({ id: request.id, result: { thread: { id: 'thread' } } });
  }
  else if (request.method === 'turn/start') {
    send({ id: request.id, result: { turn: { id: 'turn' } } });
    setTimeout(() => send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } }), 20);
  }
});
`, { mode: 0o700 });
    process.env.PATH = `${dir}:${previousPath}`;
    const providers = new Providers();
    const saved: Credentials[] = [];
    const result = await providers.execute('codex', codex, 'poll', data => saved.push(data));
    assert.equal(result!.windows[0]!.kind, 'weekly');
    assert.equal((saved[0] as typeof codex).tokens.access_token, 'rotated');
    assert.equal(await providers.execute('codex', codex, 'open', data => saved.push(data)), null);
    assert.equal(saved.length, 2);
  } finally {
    process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true });
  }
});
test('Claude subprocess treats a non-error result as success and suppresses credential output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acadence-claude-test-'));
  const previousPath = process.env.PATH;
  try {
    await writeFile(join(dir, 'claude'), `#!/usr/bin/env node
if (!process.argv.includes('--tools') || !process.argv.includes('--no-session-persistence')) process.exit(2);
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Hello' }));
`, { mode: 0o700 });
    process.env.PATH = `${dir}:${previousPath}`;
    const credentials = { claudeAiOauth: { accessToken: 'test', refreshToken: 'test', expiresAt: Date.now() + 3600000, scopes: ['user:profile','user:inference'] } };
    assert.equal(await new Providers().execute('claude', credentials, 'open', () => {}), null);
  } finally { process.env.PATH = previousPath; await rm(dir, { recursive: true, force: true }); }
});
test('Claude refreshes on 401 and persists rotation before retrying quota lookup', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  const saved: Credentials[] = [];
  try {
    globalThis.fetch = async (input, init) => {
      requests++;
      if (String(input).endsWith('/v1/oauth/token')) {
        assert.equal(saved.length, 0);
        return new Response(JSON.stringify({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600 }), { status: 200 });
      }
      const headers = init!.headers as Record<string, string>;
      if (headers.Authorization === 'Bearer original') return new Response('{}', { status: 401 });
      assert.equal(headers.Authorization, 'Bearer rotated-access');
      assert.equal(saved.length, 1);
      return new Response(JSON.stringify({ five_hour: { utilization: 0, resets_at: null }, seven_day: null }), { status: 200 });
    };
    const credentials = { email: 'claude@example.com', claudeAiOauth: { accessToken: 'original', refreshToken: 'original-refresh', expiresAt: Date.now() + 3600000, scopes: ['user:profile','user:inference'] } };
    const result = await new Providers().execute('claude', credentials, 'poll', data => saved.push(data));
    assert.equal(result!.windows[0]!.kind, 'five_hour');
    assert.equal(requests, 3);
    assert.equal((saved.at(-1) as typeof credentials).claudeAiOauth.refreshToken, 'rotated-refresh');
    assert.equal((saved.at(-1) as typeof credentials).email, 'claude@example.com');
  } finally { globalThis.fetch = originalFetch; }
});
test('missing provider executable fails promptly without leaking an unresolved process wait', async () => {
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = '/nonexistent/acadence-test-bin';
    await assert.rejects(new Providers().execute('codex', codex, 'poll', () => {}), /unavailable/);
  } finally { process.env.PATH = previousPath; }
});

test('Codex confirms sliding idle deadlines without hiding real zero-usage windows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acadence-idle-test-'));
  const previousPath = process.env.PATH;
  try {
    await writeFile(join(dir, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const mode = JSON.parse(fs.readFileSync(process.env.CODEX_HOME + '/auth.json')).tokens.access_token;
const start = Math.floor(Date.now() / 1000);
let reads = 0;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result = {};
  if (request.method === 'account/rateLimits/read') {
    reads++;
    const now = Math.floor(Date.now() / 1000);
    const window = minutes => ({ usedPercent: mode === 'activated' && reads > 1 ? 1 : 0,
      windowDurationMins: minutes, resetsAt: (mode === 'fixed' || mode === 'jitter' ? start : now) + minutes * 60 + (mode === 'jitter' && reads > 1 ? 1 : 0) });
    result = { rateLimits: { primary: window(300), secondary: window(10080) } };
    if (mode === 'missing' && reads > 1) result.rateLimits.primary = null;
    if (mode === 'invalid' && reads > 1) result = { unexpected: true };
  }
  process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n');
});
`, { mode: 0o700 });
    process.env.PATH = `${dir}:${previousPath}`;
    const poll = (mode: string) => new Providers().execute('codex', {
      ...codex, tokens: { ...codex.tokens, access_token: mode }
    }, 'poll', () => {});
    const [idle, fixed, activated, missing, jitter] = await Promise.all([
      poll('sliding'), poll('fixed'), poll('activated'), poll('missing'), poll('jitter')
    ]);
    assert.deepEqual(idle!.windows, [
      { kind: 'five_hour', used: 0, resetsAt: null },
      { kind: 'weekly', used: 0, resetsAt: null }
    ]);
    assert.ok(fixed!.windows.every(window => window.used === 0 && window.resetsAt !== null));
    // The live Luna probe retained a fixed countdown at 0%, with one-second jitter.
    assert.ok(jitter!.windows.every(window => window.used === 0 && window.resetsAt !== null));
    assert.ok(activated!.windows.every(window => window.used === 1 && window.resetsAt !== null));
    assert.deepEqual(missing!.windows, [{ kind: 'weekly', used: 0, resetsAt: null }]);
    await assert.rejects(poll('invalid'), /quota_schema/);
  } finally { process.env.PATH = previousPath; await rm(dir, { recursive: true, force: true }); }
});
