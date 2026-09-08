import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/db.js';
import { Vault } from '../src/security.js';
import { Engine } from '../src/engine.js';
import { Telegram } from '../src/telegram.js';
import { createApi } from '../src/api.js';

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
fs.writeFileSync(process.env.CODEX_HOME + '/auth.json', JSON.stringify({auth_mode:'chatgpt', tokens:{access_token:'test-access',refresh_token:'test-refresh',id_token:'test-id'}}));
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
    assert.match(connected, /Connected test/);
    assert.ok(!connected.includes('test-access'));
    await cli('schedule','add','06:00');
    await cli('schedule','update','06:00','07:00');
    assert.match(await cli('schedule','show'), /07:00/);
    assert.match(await cli('trigger'), /Queued 1/);
    assert.match(await cli('accounts','list'), /codex \/ test/);
    const id = store.get<{ id: string }>('SELECT id FROM accounts')!.id;
    await cli('accounts','reauth',id);
    await cli('accounts','disconnect',id);
    await cli('logout','--all');
    assert.equal(store.all('SELECT * FROM tokens').length, 0);
  } finally { await app.close(); store.close(); await rm(home, { recursive: true, force: true }); }
});
