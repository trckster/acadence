import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/db.js';
import { Vault, hash, secret } from '../src/security.js';
import { Engine } from '../src/engine.js';
import { Telegram } from '../src/telegram.js';
import { createApi } from '../src/api.js';

async function runCli(args: string[], env: NodeJS.ProcessEnv, input = ''): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = execFile(process.execPath, ['--import', 'tsx', resolve('src/cli.ts'), ...args], { env, timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolveOutput(stdout);
    });
    child.stdin!.end(input);
  });
}

test('help commands work at every level and removed commands and flags are rejected', async () => {
  const help = await runCli(['help'], process.env);
  assert.equal(await runCli([], process.env), help);
  const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  assert.ok(help.startsWith(`Acadence ${version}\n`));
  for (const command of ['see', 'connect', 'disconnect', 'reauth']) assert.ok(help.includes(command));
  assert.doesNotMatch(help, /^  accounts\b/m);
  await assert.rejects(runCli(['accounts', 'list'], process.env), /unknown command/);
  for (const path of [[], ['see'], ['connect'], ['disconnect'], ['reauth'], ['schedule', 'add']]) {
    const output = await runCli(['help', ...path], process.env);
    assert.match(output, /Usage: acadence/);
    assert.doesNotMatch(output, /--help|--version|\bupdate\b|<account>|<id>/);
  }
  assert.match(await runCli(['reauth', 'help'], process.env), /Choose an account/);
  for (const args of [['accounts'], ['accounts', 'reauth'], ['accounts', 'connect'], ['accounts', 'disconnect'], ['--version'], ['-V'], ['usage'], ['schedule', 'update', '06:00', '07:00'], ['help', 'missing'],
    ...[[], ['connect'], ['disconnect'], ['reauth'], ['schedule', 'add'], ['help']].flatMap(path => ['--help', '-h'].map(flag => [...path, flag]))]) {
    await assert.rejects(runCli(args, process.env), /unknown (?:command|option)|Unknown command/);
  }
});

test('see fetches owned accounts and never displays stale windows', async () => {
  const home = await mkdtemp(join(tmpdir(), 'acadence-usage-test-'));
  const store = new Store(':memory:');
  const vault = new Vault(Buffer.alloc(32, 4).toString('base64'));
  let providerCalls = 0;
  const engine = new Engine(store, vault, { execute: async (_provider, credentials, action) => {
    providerCalls++;
    assert.equal(action, 'poll');
    return { windows: 'tokens' in credentials && credentials.tokens.id_token !== 'unavailable' ? [
      { kind: 'five_hour', used: 30, resetsAt: Date.parse('2030-09-08T17:00:00Z') },
      { kind: 'weekly', used: 45, resetsAt: null }
    ] : [] };
  } });
  const app = await createApi(store, vault, engine, 'test_bot');
  try {
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const env = { ...process.env, HOME: home, TZ: 'UTC', LANG: 'en_US.UTF-8' };
    const cli = (...args: string[]) => runCli(args.length ? args : ['see'], env);
    const choose = (action: string, input: string) => runCli([action], env, input);
    await assert.rejects(cli(), /Run acadence login first/);
    const token = secret();
    store.run("INSERT INTO users(id,telegram_id,timezone) VALUES('owner','1','UTC'),('other','2','UTC')");
    store.run('INSERT INTO tokens(hash,user_id,created,expires) VALUES(?,?,?,?)', hash(token), 'owner', Date.now(), Date.now() + 60_000);
    const configDir = join(home, '.config', 'acadence');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'client.json'), JSON.stringify({ url, token }));
    assert.equal((await cli()).trim(), 'No accounts connected');
    for (const [id, user, provider, category, status, error] of [
      ['personal', 'owner', 'codex', 'personal', 'active', null],
      ['work', 'owner', 'claude', 'work', 'reauth_required', 'auth'],
      ['new', 'owner', 'codex', 'personal', 'active', null],
      ['foreign', 'other', 'codex', 'personal', 'active', null]
    ]) {
      store.run('INSERT INTO accounts(id,user_id,provider,category,status,last_error,credentials) VALUES(?,?,?,?,?,?,?)',
        id!, user!, provider!, category!, status!, error!, vault.seal(provider === 'claude'
          ? { claudeAiOauth: {}, email: 'work@example.com' }
          : { tokens: { id_token: id === 'personal' ? `header.${Buffer.from(JSON.stringify({ email: 'personal@example.com' })).toString('base64url')}.signature` : 'unavailable' } }, id!));
    }
    const sampledAt = Date.parse('2026-09-08T12:00:00Z');
    const resetsAt = Date.parse('2026-09-08T17:00:00Z');
    for (const [id, kind, used, reset, present] of [
      ['personal', 'five_hour', 25, resetsAt, 1],
      ['personal', 'weekly', 42.5, null, 1],
      ['work', 'weekly', 100, resetsAt, 1],
      ['work', 'five_hour', 99, resetsAt, 0],
      ['foreign', 'weekly', 88, resetsAt, 1]
    ] as const) {
      store.run('INSERT INTO windows(account_id,kind,used,resets_at,sampled_at,present) VALUES(?,?,?,?,?,?)', id, kind, used, reset, sampledAt, present);
    }
    const output = await cli();
    assert.match(output, /codex \/ personal \/ personal@example.com\n    active/);
    assert.match(output, /5h: 30% used; resets 2030-09-08 17:00/);
    assert.match(output, /Week: 45% used; resets not active/);
    assert.doesNotMatch(output, /\b(?:AM|PM|checked)\b/);
    assert.match(output, /claude \/ work \/ work@example.com\n    reauth required \(authentication expired or rejected; run acadence reauth\)/);
    assert.match(output, /Usage unavailable: reauthentication required/);
    assert.match(output, /codex \/ personal \/ email unavailable\n    active\n    5h: usage unavailable\n    Week: usage unavailable/);
    assert.doesNotMatch(output, /private-other-user|25%|42\.5%|100%|88%|99%|credential-must-not-appear/);
    assert.equal(providerCalls, 2);
    assert.equal(await cli('see'), output);
    assert.equal(providerCalls, 4);
    store.run('UPDATE accounts SET credentials=? WHERE id=?', vault.seal({ tokens: { id_token: `header.${Buffer.from(JSON.stringify({ email: 'work@example.com' })).toString('base64url')}.signature` } }, 'new'), 'new');
    for (const action of ['disconnect', 'reauth']) {
      await assert.rejects(cli(action, 'new'), /too many arguments/);
      await assert.rejects(cli(action, '--provider', 'codex'), /unknown option/);
      assert.match(await choose(action, '\n'), /Cancelled/);
      assert.match(await choose(action, ''), /Cancelled/);
    }
    assert.equal(store.all('SELECT id FROM accounts').length, 4);
    const selection = await choose('disconnect', '0\n99\nabc\n2\n');
    assert.match(selection, /Enter a number from 1 to 3/);
    assert.match(selection, /2\. codex \/ personal \/ work@example.com/);
    assert.match(selection, /1\. claude \/ work \/ work@example.com/);
    assert.doesNotMatch(selection, /private-other-user|foreign/);
    assert.equal(store.get('SELECT id FROM accounts WHERE id=?', 'new'), undefined);
    await choose('disconnect', '1\n');
    assert.match(await choose('disconnect', '\n'), /Choose an account/);
    assert.equal(store.all('SELECT id FROM accounts').length, 2);
    await choose('disconnect', '1\n');
    assert.equal((await choose('disconnect', '')).trim(), 'No accounts connected');
    assert.equal((await choose('reauth', '')).trim(), 'No accounts connected');
    assert.equal((await cli()).trim(), 'No accounts connected');
    assert.equal(store.all('SELECT id FROM accounts').length, 1);
    store.run('DELETE FROM tokens');
    await assert.rejects(cli(), /Sign in with acadence login/);
  } finally { await app.close(); store.close(); await rm(home, { recursive: true, force: true }); }
});

test('CLI completes login, isolated provider connection, scheduling, trigger and logout', async () => {
  const home = await mkdtemp(join(tmpdir(), 'acadence-cli-test-'));
  const store = new Store(':memory:');
  const vault = new Vault(Buffer.alloc(32, 4).toString('base64'));
  const engine = new Engine(store, vault, { execute: async () => ({ windows: [] }) });
  const telegram = new Telegram(store, async () => ({}));
  const app = await createApi(store, vault, engine, 'test_bot');
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const bin = join(home, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'codex'), `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] !== 'login') process.exit(1);
fs.writeFileSync(process.env.CODEX_HOME + '/auth.json', JSON.stringify({auth_mode:'chatgpt', tokens:{access_token:'test-access',refresh_token:'test-refresh',id_token:'header.' + Buffer.from(JSON.stringify({email:'test@example.com'})).toString('base64url') + '.signature'}}));
`, { mode: 0o700 });
    await writeFile(join(bin, 'xdg-open'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };
    const base = ['--import', 'tsx', resolve('src/cli.ts')];
    const child = spawn(process.execPath, [...base, 'login', '--api', url], { env, stdio: ['ignore','pipe','pipe'] });
    let output = '';
    let errors = '';
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      const match = /https:\/\/t.me\/test_bot\?start=([A-Za-z0-9_-]{43})/.exec(output);
      if (match) telegram.accept({ message: { chat: { type: 'private', id: 123 }, from: { id: 123 }, text: `/start ${match[1]}` } });
    });
    child.stderr.on('data', chunk => { errors += chunk.toString(); });
    const exit = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI login timed out')); }, 15_000);
      child.on('exit', code => { clearTimeout(timer); resolve(code); });
      child.on('error', reject);
    });
    assert.equal(exit, 0, errors);
    assert.match(output, /Signed in/);
    assert.match(output, /Next, run acadence connect/);
    const file = join(home, '.config/acadence/client.json');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const cli = async (...args: string[]) => (await promisify(execFile)(process.execPath, [...base, ...args], { env })).stdout;
    assert.match(await runCli(['connect'], env, '\x1b'), /Cancelled/);
    assert.match(await runCli(['connect'], env, '\x03'), /Cancelled/);
    assert.match(await runCli(['connect'], env), /Cancelled/);
    assert.equal(store.all('SELECT * FROM accounts').length, 0);
    const connected = await runCli(['connect', '--type', 'personal'], env, '\x1b[B\x1b[A\x1b[A\r');
    assert.match(connected, /❯ Codex/);
    assert.doesNotMatch(connected, /Provider number/);
    assert.match(connected, /Connected codex \/ personal \/ test@example.com/);
    assert.ok(!connected.includes('test-access'));
    await assert.rejects(cli('connect', 'codex', '--label', 'second'), /unknown option/);
    await assert.rejects(cli('connect', 'codex', '--type', 'other'), /Invalid input/);
    await assert.rejects(cli('connect', 'codex', '--type', 'personal'), /already connected/);
    assert.match(await runCli(['connect', 'codex'], env, '\x1b'), /Cancelled/);
    const work = await runCli(['connect', 'codex'], env, '\x1b[B\r');
    assert.match(work, /Connected codex \/ work \/ test@example.com/);
    await runCli(['disconnect'], env, '2\n');
    await cli('schedule','add','06:00');
    await cli('schedule','remove','06:00');
    await cli('schedule','add','07:00');
    assert.match(await cli('schedule','show'), /07:00/);
    assert.match(await cli('trigger'), /Queued 1/);
    assert.match(await cli('see'), /codex \/ personal \/ test@example.com/);
    const id = store.get<{ id: string }>('SELECT id FROM accounts')!.id;
    const reauth = await runCli(['reauth'], env, '1\n');
    assert.match(reauth, /Authentication updated/);
    assert.doesNotMatch(reauth, new RegExp(id));
    const disconnected = await runCli(['disconnect'], env, '1\n');
    assert.match(disconnected, /Disconnected/);
    assert.doesNotMatch(disconnected, new RegExp(id));
    assert.equal(store.get('SELECT id FROM accounts WHERE id=?', id), undefined);
    await cli('logout','--all');
    assert.equal(store.all('SELECT * FROM tokens').length, 0);
  } finally { await app.close(); store.close(); await rm(home, { recursive: true, force: true }); }
});

test('CLI request errors show destination, status and cause, including usage refresh failures', async () => {
  const { createServer } = await import('node:http');
  const home = await mkdtemp(join(tmpdir(), 'acadence-errors-test-'));
  let status = 502;
  let body = '<html>upstream-private-detail</html>';
  const server = createServer((request, response) => {
    if (request.url === '/v1/accounts') {
      response.end(JSON.stringify([{ id: 'test', provider: 'claude', category: 'personal', status: 'active', pending: [] }]));
    } else { response.writeHead(status); response.end(body); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const env = { ...process.env, HOME: home };
  try {
    await assert.rejects(runCli(['login', '--api', url], env), error => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(`POST ${url}/v1/auth/device: HTTP 502; expected a JSON response`));
      assert.doesNotMatch(error.message, /upstream-private-detail/);
      return true;
    });
    status = 401; body = JSON.stringify({ error: 'Sign in with acadence login' });
    await assert.rejects(runCli(['login', '--api', url], env), /HTTP 401; Sign in with acadence login/);
    status = 503; body = JSON.stringify({ error: 'credential secret-value' });
    await assert.rejects(runCli(['login', '--api', url], env), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HTTP 503/);
      assert.doesNotMatch(error.message, /secret-value/);
      return true;
    });
    const dir = join(home, '.config', 'acadence');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'client.json'), JSON.stringify({ url, token: 'a'.repeat(43) }));
    assert.match(await runCli(['see'], env), /Usage unavailable: POST http:\/\/127\.0\.0\.1:\d+\/v1\/accounts\/test\/usage: HTTP 503/);
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await assert.rejects(runCli(['login', '--api', url], env), /POST http:\/\/127\.0\.0\.1:\d+\/v1\/auth\/device: connection refused \(ECONNREFUSED\)/);
  } finally {
    server.close();
    await rm(home, { recursive: true, force: true });
  }
});
