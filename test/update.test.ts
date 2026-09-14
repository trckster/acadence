import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { lock } from 'proper-lockfile';
import { updateAcadence } from '../src/update.js';

const execute = promisify(execFile);
const latestUrl = 'https://api.github.com/repos/trckster/acadence/releases/latest';
const releaseUrl = 'https://github.com/trckster/acadence/releases/download/v0.6.0';

async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), 'acadence-update-test-'));
  const prefix = join(temporary, 'custom prefix');
  const packageDir = join(prefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules', 'acadence');
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: 'acadence', version: '0.5.4' }));
  const logs: string[] = [];
  const requests: string[] = [];
  let release: object = { tag_name: 'v0.6.0', draft: false, prerelease: false };
  let archive = Buffer.from('archive');
  let sums: string | undefined;
  const options = {
    packageDir, log: (message: string) => logs.push(message),
    fetch: (async (url: string | URL | Request) => {
      const address = String(url);
      requests.push(address);
      if (address === latestUrl) return Response.json(release);
      if (address === `${releaseUrl}/SHA256SUMS`) return new Response(sums ?? `${createHash('sha256').update(archive).digest('hex')}  acadence.tgz\n`);
      if (address === `${releaseUrl}/acadence.tgz`) return new Response(new Uint8Array(archive));
      throw new Error(`Unexpected URL: ${address}`);
    }) as typeof fetch
  };
  return {
    temporary, prefix, packageDir, options, logs, requests,
    setRelease: (value: object) => { release = value; },
    setArchive: (value: Buffer) => { archive = value; },
    setSums: (value: string) => { sums = value; },
    cleanup: () => rm(temporary, { recursive: true, force: true })
  };
}

test('update installs a verified release into the current custom prefix using npm', async () => {
  const f = await fixture();
  try {
    const source = join(f.temporary, 'package');
    await mkdir(join(source, 'dist'), { recursive: true });
    await writeFile(join(source, 'package.json'), JSON.stringify({
      name: 'acadence', version: '0.6.0', bin: { acadence: 'dist/cli.js' },
      scripts: { postinstall: 'exit 99' }
    }));
    await writeFile(join(source, 'dist', 'cli.js'), '#!/usr/bin/env node\nconsole.log("Acadence 0.6.0\\n");\n', { mode: 0o755 });
    const tarball = join(f.temporary, 'release.tgz');
    await execute('tar', ['-czf', tarball, '-C', f.temporary, 'package']);
    f.setArchive(await readFile(tarball));
    await updateAcadence(f.options);
    assert.equal(JSON.parse(await readFile(join(f.packageDir, 'package.json'), 'utf8')).version, '0.6.0');
    const { stdout } = await execute(join(f.prefix, process.platform === 'win32' ? 'acadence.cmd' : 'bin/acadence'), []);
    assert.match(stdout, /^Acadence 0\.6\.0\n/);
    assert.match(f.logs.join('\n'), /Updated acadence from 0\.5\.4 to 0\.6\.0/);
    assert.deepEqual(f.requests, [latestUrl, `${releaseUrl}/SHA256SUMS`, `${releaseUrl}/acadence.tgz`]);
    assert.ok(!(await readdir(f.prefix)).includes('.acadence-update.lock'));
    f.requests.length = 0;
    await updateAcadence(f.options);
    assert.deepEqual(f.requests, [latestUrl]);
    assert.match(f.logs.at(-1)!, /0\.6\.0 is already up to date/);
  } finally { await f.cleanup(); }
});

test('update never downgrades and compares multi-digit version components numerically', async () => {
  const f = await fixture();
  try {
    for (const version of ['0.5.4', '0.5.3', '0.4.99']) {
      f.setRelease({ tag_name: `v${version}` });
      await updateAcadence(f.options);
      assert.match(f.logs.at(-1)!, /0\.5\.4 is already up to date/);
    }
    assert.deepEqual(f.requests, [latestUrl, latestUrl, latestUrl]);
    f.setRelease({ tag_name: 'v0.10.0' });
    await assert.rejects(updateAcadence(f.options), /Unexpected URL: .*v0\.10\.0\/SHA256SUMS/);
  } finally { await f.cleanup(); }
});

test('invalid releases, missing checksums and corrupt downloads leave the installation intact', async () => {
  const f = await fixture();
  try {
    for (const release of [{}, { tag_name: 'v0.6.0-beta' }, { tag_name: '0.6.0' }, { tag_name: 'v0.6.0', prerelease: true }, { tag_name: 'v0.6.0', draft: true }]) {
      f.setRelease(release);
      await assert.rejects(updateAcadence(f.options), /supported stable version/);
    }
    f.setRelease({ tag_name: 'v0.6.0' });
    f.setSums(`${'0'.repeat(64)}  other.tgz\n`);
    await assert.rejects(updateAcadence(f.options), /checksum.*missing or invalid/);
    f.setSums(`${'0'.repeat(64)}  acadence.tgz\n`);
    await assert.rejects(updateAcadence(f.options), /checksum verification failed/);
    assert.equal(JSON.parse(await readFile(join(f.packageDir, 'package.json'), 'utf8')).version, '0.5.4');
    assert.ok(!(await readdir(f.prefix)).includes('.acadence-update.lock'));
  } finally { await f.cleanup(); }
});

test('HTTP and npm failures report failure and release the update lock', async () => {
  const f = await fixture();
  try {
    await assert.rejects(updateAcadence({ ...f.options, fetch: async () => new Response('', { status: 503 }) }), /HTTP 503/);
    await assert.rejects(updateAcadence(f.options), /npm could not install/);
    assert.doesNotMatch(f.logs.join('\n'), /Updated acadence from/);
    assert.equal(JSON.parse(await readFile(join(f.packageDir, 'package.json'), 'utf8')).version, '0.5.4');
    assert.ok(!(await readdir(f.prefix)).includes('.acadence-update.lock'));
  } finally { await f.cleanup(); }
});

test('concurrent updates and source checkouts are rejected before downloading', async () => {
  const f = await fixture();
  try {
    const release = await lock(f.prefix, { lockfilePath: join(f.prefix, '.acadence-update.lock') });
    try { await assert.rejects(updateAcadence(f.options), /Another acadence update/); }
    finally { await release(); }
    await assert.rejects(updateAcadence({ ...f.options, packageDir: resolve('.') }), /global npm installation/);
    assert.deepEqual(f.requests, []);
  } finally { await f.cleanup(); }
});
