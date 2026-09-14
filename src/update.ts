import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { lock } from 'proper-lockfile';
import { fetchWithContext, RequestError, responseJson } from './errors.js';

const execute = promisify(execFile);
const repository = 'https://github.com/trckster/acadence';
const latestRelease = 'https://api.github.com/repos/trckster/acadence/releases/latest';
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

async function npmCommand(): Promise<{ command: string; args: string[] }> {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const executable = resolve(directory, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    try {
      await access(executable, constants.X_OK);
      if (process.platform !== 'win32') return { command: executable, args: [] };
      const cli = resolve(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js');
      await access(cli, constants.R_OK);
      return { command: process.execPath, args: [cli] };
    } catch {}
  }
  throw new Error('npm is required to update acadence; install npm and make it available on PATH');
}

export async function updateAcadence(options: {
  packageDir?: string;
  fetch?: typeof fetch;
  log?: (message: string) => void;
} = {}): Promise<void> {
  const packageDir = await realpath(options.packageDir ?? fileURLToPath(new URL('..', import.meta.url)));
  const modules = dirname(packageDir);
  const prefix = process.platform === 'win32' ? dirname(modules) : dirname(dirname(modules));
  if (basename(packageDir) !== 'acadence' || basename(modules) !== 'node_modules' ||
    (process.platform !== 'win32' && basename(dirname(modules)) !== 'lib')) {
    throw new Error('Self-update requires a global npm installation. Install acadence with the installer in the README, then run acadence update');
  }
  try {
    await access(prefix, constants.W_OK);
    await access(modules, constants.W_OK);
    await access(packageDir, constants.W_OK);
  } catch {
    throw new Error(`Cannot update acadence in ${prefix}: permission denied. Run with the permissions used to install it`);
  }
  const npm = await npmCommand();
  const log = options.log ?? console.log;
  const download = async (url: string) => {
    const response = await (options.fetch ?? fetchWithContext)(url, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'acadence' },
      signal: AbortSignal.timeout(120_000)
    });
    if (!response.ok) throw new RequestError(`GET ${url}: HTTP ${response.status}; could not download the acadence release`);
    return response;
  };
  let releaseLock: () => Promise<void>;
  try { releaseLock = await lock(prefix, { lockfilePath: join(prefix, '.acadence-update.lock'), retries: 0 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOCKED') throw new Error('Another acadence update is already running; try again when it finishes');
    throw error;
  }
  try {
    const current = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')).version as string;
    if (!stableVersion.test(current)) throw new Error(`Cannot self-update unsupported version ${current}`);
    log(`Checking for updates (installed: ${current})…`);
    const release = await responseJson(await download(latestRelease), latestRelease, 'GET');
    const version: string = typeof release?.tag_name === 'string' ? release.tag_name.replace(/^v/, '') : '';
    if (!stableVersion.test(version) || release.tag_name !== `v${version}` || release.draft || release.prerelease) {
      throw new Error('The latest GitHub release does not have a supported stable version');
    }
    const currentParts = current.split('.').map(BigInt);
    const latestParts = version.split('.').map(BigInt);
    const changed = latestParts.findIndex((part, index) => part !== currentParts[index]);
    if (changed === -1 || latestParts[changed]! < currentParts[changed]!) {
      log(`Acadence ${current} is already up to date${changed === -1 ? '' : ` (latest release: ${version})`}.`);
      return;
    }
    const temporary = await mkdtemp(join(tmpdir(), 'acadence-update-'));
    try {
      log(`Downloading acadence ${version}…`);
      const base = `${repository}/releases/download/v${version}`;
      const sums = await (await download(`${base}/SHA256SUMS`)).text();
      const checksums = sums.split(/\r?\n/).filter(line => /^[a-fA-F0-9]{64} [ *]acadence\.tgz$/.test(line));
      if (checksums.length !== 1) throw new Error('Release checksum for acadence.tgz is missing or invalid');
      const archive = Buffer.from(await (await download(`${base}/acadence.tgz`)).arrayBuffer());
      if (createHash('sha256').update(archive).digest('hex') !== checksums[0]!.slice(0, 64).toLowerCase()) {
        throw new Error('Release checksum verification failed; acadence was not updated');
      }
      const tarball = join(temporary, 'acadence.tgz');
      await writeFile(tarball, archive);
      log(`Installing acadence ${version} in ${prefix}…`);
      // The CLI's private-file umask must not make a shared installation unreadable.
      const previousMask = process.umask(0o022);
      try {
        await execute(npm.command, [...npm.args, 'install', '--global', '--prefix', prefix, '--ignore-scripts', '--engine-strict', '--no-audit', '--no-fund', tarball], {
          cwd: temporary, timeout: 300_000, maxBuffer: 4 * 1024 * 1024
        });
      } catch (error) {
        throw new Error('npm could not install the update. Check network access, Node.js compatibility and installation permissions, then retry acadence update', { cause: error });
      } finally { process.umask(previousMask); }
      const installed = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
      const { stdout } = await execute(process.execPath, [join(packageDir, 'dist', 'cli.js')], { cwd: temporary, timeout: 30_000 });
      if (installed.name !== 'acadence' || installed.version !== version || !stdout.startsWith(`Acadence ${version}\n`)) {
        throw new Error('Update verification failed; reinstall acadence using the installer in the README');
      }
      log(`Updated acadence from ${current} to ${version}.`);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  } finally { await releaseLock(); }
}
