import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/db.js';
import { Vault, hash, secret } from '../src/security.js';
import { Engine } from '../src/engine.js';
import { Telegram } from '../src/telegram.js';
import { createApi } from '../src/api.js';

test('usage shows all owned accounts and stored windows, including unavailable usage', async () => {
  const home = await mkdtemp(join(tmpdir(), 'acadence-usage-test-'));
  const store = new Store(':memory:');
  const vault = new Vault(Buffer.alloc(32, 4).toString('base64'));
  let providerCalls = 0;
  const engine = new Engine(store, vault, { execute: async () => { providerCalls++; return { windows: [] }; } });
  const app = await createApi(store, vault, engine, 'test_bot');
  try {
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const cli = async (...args: string[]) => (await promisify(execFile)(process.execPath, ['--import', 'tsx', resolve('src/cli.ts'), ...(args.length ? args : ['usage'])], {
      env: { ...process.env, HOME: home, TZ: 'UTC', LANG: 'en_US.UTF-8' }
    })).stdout;
    await assert.rejects(cli(), /Run acadence login first/);
    const token = secret();
    store.run("INSERT INTO users(id,telegram_id,timezone) VALUES('owner','1','UTC'),('other','2','UTC')");
    store.run('INSERT INTO tokens(hash,user_id,created,expires) VALUES(?,?,?,?)', hash(token), 'owner', Date.now(), Date.now() + 60_000);
    const configDir = join(home, '.config', 'acadence');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'client.json'), JSON.stringify({ url, token }));
    assert.equal((await cli()).trim(), 'No accounts connected');
    for (const [id, user, provider, label, status, error] of [
      ['personal', 'owner', 'codex', 'personal', 'active', null],
      ['work', 'owner', 'claude', 'work', 'reauth_required', 'auth'],
      ['new', 'owner', 'codex', 'new', 'active', null],
      ['foreign', 'other', 'codex', 'private-other-user', 'active', null]
    ]) {
      store.run('INSERT INTO accounts(id,user_id,provider,label,status,last_error,credentials) VALUES(?,?,?,?,?,?,?)',
        id!, user!, provider!, label!, status!, error!, vault.seal(provider === 'claude'
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
    assert.match(output, /codex \/ personal: personal@example.com\n    active/);
    assert.match(output, /5h: 25% used; resets .+; checked .+/);
    assert.match(output, /Week: 42\.5% used; resets not active; checked .+/);
    assert.match(output, /claude \/ work: work@example.com\n    reauth required \(auth\)/);
    assert.match(output, /Week: 100% used/);
    assert.match(output, /codex \/ new: email unavailable\n    active\n    5h: usage unavailable\n    Week: usage unavailable/);
    assert.doesNotMatch(output, /private-other-user|88%|99%|credential-must-not-appear/);
    assert.equal(providerCalls, 0);
    assert.equal(await cli('accounts', 'list'), output);
    store.run('UPDATE accounts SET credentials=? WHERE id=?', vault.seal({ tokens: { id_token: `header.${Buffer.from(JSON.stringify({ email: 'work@example.com' })).toString('base64url')}.signature` } }, 'new'), 'new');
    await assert.rejects(cli('accounts', 'disconnect', 'work@example.com'), /Multiple accounts match/);
    await assert.rejects(cli('accounts', 'reauth', 'work@example.com'), /Multiple accounts match/);
    assert.equal(store.all('SELECT id FROM accounts').length, 4);
    await assert.rejects(cli('accounts', 'disconnect', 'private-other-user'), /Account not found/);
    await cli('accounts', 'disconnect', 'WORK@example.com', '--provider', 'codex', '--label', 'new');
    assert.equal(store.get('SELECT id FROM accounts WHERE id=?', 'new'), undefined);
    await cli('accounts', 'disconnect', 'personal@example.com');
    await cli('accounts', 'disconnect', 'work');
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
    const file = join(home, '.config/acadence/client.json');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const cli = async (...args: string[]) => (await promisify(execFile)(process.execPath, [...base, ...args], { env })).stdout;
    const connected = await cli('accounts','connect','codex','--label','test');
    assert.match(connected, /Connected codex \/ test/);
    assert.ok(!connected.includes('test-access'));
    await cli('schedule','add','06:00');
    await cli('schedule','update','06:00','07:00');
    assert.match(await cli('schedule','show'), /07:00/);
    assert.match(await cli('trigger'), /Queued 1/);
    assert.match(await cli('accounts','list'), /codex \/ test/);
    const id = store.get<{ id: string }>('SELECT id FROM accounts')!.id;
    await cli('accounts','reauth','test@example.com');
    await cli('accounts','disconnect',id);
    await cli('logout','--all');
    assert.equal(store.all('SELECT * FROM tokens').length, 0);
  } finally { await app.close(); store.close(); await rm(home, { recursive: true, force: true }); }
});
