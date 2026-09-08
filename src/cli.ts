#!/usr/bin/env node
import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { anchorSchema, timezoneSchema, type Provider, type Schedule } from './domain.js';
import { claudeAccountEmail, cleanEnvironment, parseCredentials, runProcess } from './providers.js';
import { formatReset } from './format.js';
import { fetchWithContext, responseJson, requestTarget, RequestError, formatError, providerErrorMessage } from './errors.js';

process.umask(0o077);
const program = new Command().name('acadence').description('Manage Claude Code and Codex usage windows');
const configDir = join(homedir(), '.config', 'acadence');
const configFile = join(configDir, 'client.json');
const production = 'https://acadence.daniil.online';
const configSchema = z.object({ token: z.string().length(43), url: z.string().url() });
type Config = z.infer<typeof configSchema>;
function validateUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) throw new Error('API must use HTTPS (HTTP allowed only on localhost)');
  return url.origin;
}
async function config(): Promise<Config> {
  try { const value = configSchema.parse(JSON.parse(await readFile(configFile, 'utf8'))); validateUrl(value.url); return value; }
  catch { throw new Error('Run acadence login first'); }
}
async function request(path: string, method = 'GET', body?: unknown, auth?: Config, timeout = 30_000) {
  const current = auth ?? await config();
  const url = validateUrl(current.url) + path;
  const response = await fetchWithContext(url, {
    method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(current.token ? { authorization: `Bearer ${current.token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(timeout)
  });
  const result = await responseJson(response, url, method);
  if (!response.ok) {
    const detail = typeof result?.error === 'string' ? `; ${formatError(new Error(result.error)).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 500)}` : '';
    throw new RequestError(`${requestTarget(url, method)}: HTTP ${response.status}${detail}`);
  }
  return result;
}
function browser(url: string) {
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(command, [url], { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}
async function interactive(command: string, args: string[], home: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { env: { ...cleanEnvironment(home), DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, TERM: process.env.TERM }, cwd: home, stdio: 'inherit' });
    child.on('error', () => reject(new Error(`Install ${command} and make it available on PATH first`)));
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} sign-in failed`)));
  });
}
async function credentials(provider: Provider, consume: (data: unknown) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'acadence-login-'));
  const dir = join(home, provider === 'codex' ? '.codex' : '.claude');
  await mkdir(dir, { mode: 0o700 });
  try {
    if (provider === 'codex') {
      await writeFile(join(dir, 'config.toml'), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
      await interactive('codex', ['login'], home);
    } else await interactive('claude', ['auth', 'login'], home);
    let raw: string;
    try { raw = await readFile(join(dir, provider === 'codex' ? 'auth.json' : '.credentials.json'), 'utf8'); }
    catch {
      if (provider !== 'claude' || process.platform !== 'darwin') throw new Error('Provider did not save transferable subscription credentials');
      const suffix = createHash('sha256').update(dir).digest('hex').slice(0, 8);
      raw = await runProcess('security', ['find-generic-password', '-s', `Claude Code-credentials-${suffix}`, '-w'], cleanEnvironment(home), home);
    }
    const data = parseCredentials(provider, JSON.parse(raw));
    if ('claudeAiOauth' in data) data.email = await claudeAccountEmail(home);
    await consume(data);
  } finally {
    if (provider === 'claude' && process.platform === 'darwin') {
      const suffix = createHash('sha256').update(dir).digest('hex').slice(0, 8);
      await runProcess('security', ['delete-generic-password', '-s', `Claude Code-credentials-${suffix}`], cleanEnvironment(home), home).catch(() => {});
    }
    await rm(home, { recursive: true, force: true });
  }
}

program.command('login').description('Sign in and link Telegram notifications').option('--api <url>', 'API override for self-hosting', production).action(async options => {
  const url = validateUrl(options.api);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const auth = { url, token: '' };
  const device = await request('/v1/auth/device', 'POST', { timezone }, auth);
  console.log(`Open Telegram to approve this sign-in:\n${device.url}`);
  browser(device.url);
  const deadline = Date.now() + device.expiresIn * 1000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    const result = await request('/v1/auth/poll', 'POST', { device: device.device }, auth);
    if (!result.token) continue;
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    const temporary = join(configDir, `client-${process.pid}.json`);
    await writeFile(temporary, JSON.stringify({ url, token: result.token }), { mode: 0o600 });
    await rename(temporary, configFile);
    console.log(`Signed in. Timezone: ${(await request('/v1/schedule')).timezone}`);
    return;
  }
  throw new Error('Sign-in expired; run acadence login again');
});
program.command('logout').option('--all', 'Revoke all CLI sessions').action(async options => {
  await request(`/v1/auth?all=${!!options.all}`, 'DELETE');
  await rm(configFile, { force: true });
  console.log('Signed out');
});
const accounts = program.command('accounts').description('Connect and manage provider accounts');
accounts.command('connect <provider>').option('--label <name>', 'Account name', 'default').action(async (provider, options) => {
  const type = z.enum(['claude','codex']).parse(provider);
  await config();
  await credentials(type, async data => {
    await request('/v1/accounts', 'POST', { provider: type, label: options.label, credentials: data });
    console.log(`Connected ${type} / ${options.label}`);
  });
});
async function showAccounts() {
  const rows = await request('/v1/accounts');
  for (let i = 0; i < rows.length; i += 4) {
    await Promise.all(rows.slice(i, i + 4).map(async (row: any) => {
      row.limits = [];
      try {
        Object.assign(row, await request(`/v1/accounts/${encodeURIComponent(row.id)}/usage`, 'POST', {}, undefined, 120_000));
      } catch (error) {
        row.refreshError = formatError(error);
      }
    }));
  }
  const now = Date.now();
  if (!rows.length) { console.log('No accounts connected'); return; }
  for (const row of rows) {
    if (row !== rows[0]) console.log();
    console.log(`${row.provider} / ${row.label}: ${row.email ?? 'email unavailable'}`);
    console.log(`    ${row.status.replaceAll('_', ' ')}${row.lastError ? ` (${providerErrorMessage(row.lastError)})` : ''}`);
    if (row.refreshError) console.log(`    Usage unavailable: ${providerErrorMessage(row.refreshError)}`);
    for (const [kind, label] of [['five_hour', '5h'], ['weekly', 'Week']]) {
      const limit = row.limits.find((item: any) => item.kind === kind);
      console.log(limit
        ? `    ${label}: ${limit.used}% used; resets ${formatReset(limit.resetsAt, now)}`
        : `    ${label}: usage unavailable`);
    }
    if (row.pending.length) console.log(`    ${row.pending.length} pending operation(s)`);
  }
}
accounts.command('list').description('Fetch current usage and status for every connected account').action(showAccounts);
async function chooseAccount(action: string) {
  const rows = await request('/v1/accounts');
  if (!rows.length) { console.log('No accounts connected'); return; }
  console.log(`Choose an account to ${action}:`);
  rows.forEach((row: any, index: number) => {
    console.log(`  ${index + 1}. ${row.provider} / ${row.label}: ${row.email ?? 'email unavailable'} (${row.status.replaceAll('_', ' ')})`);
  });
  const input = createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => process.stdout.write('Account number (Enter to cancel): ');
  try {
    prompt();
    for await (const line of input) {
      const value = line.trim();
      if (!value) break;
      const number = Number(value);
      if (/^[0-9]+$/.test(value) && Number.isSafeInteger(number) && number >= 1 && number <= rows.length) return rows[number - 1];
      console.log(`Enter a number from 1 to ${rows.length}.`);
      prompt();
    }
    console.log('Cancelled');
  } finally { input.close(); }
}
accounts.command('disconnect').description('Choose an account to disconnect').action(async () => {
  const account = await chooseAccount('disconnect');
  if (!account) return;
  await request(`/v1/accounts/${encodeURIComponent(account.id)}`, 'DELETE');
  console.log('Disconnected');
});
accounts.command('reauth').description('Choose an account to reauthenticate').action(async () => {
  const account = await chooseAccount('reauthenticate');
  if (!account) return;
  await credentials(account.provider, async data => {
    await request(`/v1/accounts/${encodeURIComponent(account.id)}`, 'PUT', { credentials: data });
    console.log('Authentication updated');
  });
});
const schedule = program.command('schedule').description('Manage shared daily anchors');
const display = (value: Schedule) => console.log(`${value.timezone}: ${value.anchors.join(', ') || 'no anchors'}`);
schedule.command('show').action(async () => display(await request('/v1/schedule')));
async function changeAnchors(change: (anchors: string[]) => string[]) {
  const current = await request('/v1/schedule');
  display(await request('/v1/schedule', 'PUT', { ...current, anchors: change(current.anchors) }));
}
schedule.command('add <time>').action(async time => { anchorSchema.parse(time); await changeAnchors(anchors => [...new Set([...anchors, time])]); });
schedule.command('remove <time>').action(async time => { anchorSchema.parse(time); await changeAnchors(anchors => anchors.filter(anchor => anchor !== time)); });
schedule.command('timezone <zone>').action(async zone => { timezoneSchema.parse(zone); display(await request('/v1/schedule', 'PUT', { ...await request('/v1/schedule'), timezone: zone })); });
program.command('trigger').description('Queue an immediate request for every connected account').action(async () => {
  const result = await request('/v1/trigger', 'POST', {});
  console.log(`Queued ${result.queued} account(s). Check acadence accounts list for status.`);
});
function configureHelp(command: Command) {
  command.helpOption(false).addHelpCommand(false);
  for (const child of command.commands) configureHelp(child);
  command.command('help [command...]').description('Display help for a command').helpOption(false).addHelpCommand(false)
    .action((path: string[]) => {
      let target = command;
      for (const name of path) {
        const child = target.commands.find(item => item.name() === name);
        if (!child) throw new Error(`Unknown command: ${name}`);
        target = child;
      }
      target.outputHelp();
    });
}
configureHelp(program);
if (process.argv.length === 2) console.log(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version);
else program.parseAsync().catch(error => {
  console.error(error instanceof z.ZodError ? 'Invalid input or unsupported provider credential format' : formatError(error));
  process.exitCode = 1;
});
