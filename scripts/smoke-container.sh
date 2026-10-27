#!/usr/bin/env bash
set -euo pipefail
acadence_image=${1:-acadence:local}
acadence_volume="acadence-smoke-$(date +%s)-$$"
docker volume create "$acadence_volume" >/dev/null
trap 'docker volume rm "$acadence_volume" >/dev/null' EXIT
docker run --rm --network none --read-only --tmpfs /tmp:rw,nosuid,nodev,size=512m,mode=1777 --cap-drop ALL --security-opt no-new-privileges:true --entrypoint sh "$acadence_image" -c 'bwrap --version && codex --version && claude --version && node dist/cli.js'
docker run --rm --network none -i --read-only --tmpfs /tmp:rw,nosuid,nodev,size=512m,mode=1777 --cap-drop ALL --security-opt no-new-privileges:true --entrypoint node "$acadence_image" --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
const home = await mkdtemp('/tmp/acadence-provider-smoke-');
const env = {
  PATH: process.env.PATH, HOME: home, CODEX_HOME: `${home}/.codex`, CLAUDE_CONFIG_DIR: `${home}/.claude`,
  LANG: 'C.UTF-8', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1'
};
try {
  await mkdir(env.CODEX_HOME);
  await mkdir(env.CLAUDE_CONFIG_DIR);
  await writeFile(`${env.CODEX_HOME}/config.toml`, 'cli_auth_credentials_store = "file"\n');
  const help = spawnSync('claude', ['--help'], { env, encoding: 'utf8', timeout: 20_000 });
  assert.ifError(help.error);
  assert.equal(help.status, 0);
  for (const flag of ['--tools', '--no-session-persistence', '--output-format']) assert.ok(help.stdout.includes(flag));
  const claude = spawnSync('claude', ['auth', 'status', '--json'], { env, encoding: 'utf8', timeout: 20_000 });
  assert.ifError(claude.error);
  assert.ok(claude.status === 0 || claude.status === 1);
  assert.equal(JSON.parse(claude.stdout).loggedIn, false);
  await new Promise((resolve, reject) => {
    const child = spawn('codex', ['app-server'], { env, cwd: home, stdio: ['pipe', 'pipe', 'ignore'] });
    let checked = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Codex protocol smoke timed out')); }, 20_000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdin.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      if (checked && code === 0) resolve();
      else reject(new Error('Codex protocol smoke failed'));
    });
    const send = message => child.stdin.write(JSON.stringify(message) + '\n');
    createInterface({ input: child.stdout }).on('line', line => {
      try {
        const message = JSON.parse(line);
        if (message.id === 1) {
          assert.equal(message.error, undefined);
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/read', params: { refreshToken: false } });
        } else if (message.id === 2) {
          assert.equal(message.error, undefined);
          assert.equal(message.result.account, null);
          checked = true;
          child.stdin.end();
        }
      } catch (error) { child.kill('SIGKILL'); reject(error); }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'acadence_smoke', version: '0.0.0' }, capabilities: { experimentalApi: true } } });
  });
  console.log('Isolated Claude auth status and Codex app-server protocol passed');
} finally { await rm(home, { recursive: true, force: true }); }
JS
docker run --rm --network none -i --read-only --tmpfs /tmp --mount "source=$acadence_volume,target=/data" --cap-drop ALL --security-opt no-new-privileges:true --entrypoint node "$acadence_image" --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { lock } from 'proper-lockfile';
import { Store } from './dist/db.js';
import { Vault } from './dist/security.js';
import { Engine } from './dist/engine.js';
import { createApi } from './dist/api.js';
const store = new Store('/data/acadence.sqlite');
const release = await lock('/data/acadence.sqlite');
await assert.rejects(lock('/data/acadence.sqlite'));
store.run("INSERT INTO users(id,telegram_id,timezone) VALUES('smoke','1','UTC')");
const vault = new Vault(Buffer.alloc(32, 1).toString('base64'));
const engine = new Engine(store, vault, { execute: async () => ({ windows: [] }) });
const app = await createApi(store, vault, engine, 'test_bot');
const address = await app.listen({ host: '127.0.0.1', port: 0 });
assert.equal((await fetch(address + '/health')).status, 200);
assert.equal((await fetch(address + '/v1/accounts')).status, 401);
await app.close();
await release();
store.close();
console.log('Container API, SQLite and exclusive worker lock passed');
JS
docker run --rm --network none --read-only --mount "source=$acadence_volume,target=/data" --entrypoint node "$acadence_image" --input-type=module -e "import {Store} from './dist/db.js'; const s=new Store('/data/acadence.sqlite'); if(s.get('SELECT id FROM users')?.id!=='smoke')process.exit(1); s.close(); console.log('SQLite survived container recreation');"
