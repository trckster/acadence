#!/usr/bin/env bash
set -euo pipefail
acadence_image=${1:-acadence:local}
acadence_volume="acadence-smoke-$(date +%s)-$$"
docker volume create "$acadence_volume" >/dev/null
trap 'docker volume rm "$acadence_volume" >/dev/null' EXIT
docker run --rm --read-only --tmpfs /tmp:rw,nosuid,nodev,size=512m,mode=1777 --cap-drop ALL --security-opt no-new-privileges:true --entrypoint sh "$acadence_image" -c 'codex --version && claude --version && node dist/cli.js --version'
docker run --rm -i --read-only --tmpfs /tmp --mount "source=$acadence_volume,target=/data" --cap-drop ALL --security-opt no-new-privileges:true --entrypoint node "$acadence_image" --input-type=module <<'JS'
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
docker run --rm --read-only --mount "source=$acadence_volume,target=/data" --entrypoint node "$acadence_image" --input-type=module -e "import {Store} from './dist/db.js'; const s=new Store('/data/acadence.sqlite'); if(s.get('SELECT id FROM users')?.id!=='smoke')process.exit(1); s.close(); console.log('SQLite survived container recreation');"
