import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import type { Provider, Snapshot, Window } from './domain.js';

const token = z.string().min(1).max(32_000);
export const claudeCredentials = z.object({ claudeAiOauth: z.object({
  accessToken: token, refreshToken: token, expiresAt: z.number().finite(),
  scopes: z.array(z.string()).max(30), subscriptionType: z.string().nullable().optional(),
  rateLimitTier: z.string().nullable().optional(), clientId: z.string().uuid().optional()
}) });
export const codexCredentials = z.object({
  auth_mode: z.literal('chatgpt').optional(),
  tokens: z.object({ access_token: token, refresh_token: token, id_token: token, account_id: z.string().max(300).optional() }),
  last_refresh: z.string().optional()
});
export type Credentials = z.infer<typeof claudeCredentials> | z.infer<typeof codexCredentials>;
export function parseCredentials(provider: Provider, value: unknown): Credentials {
  return provider === 'claude' ? claudeCredentials.parse(value) : codexCredentials.parse(value);
}

export class ProviderError extends Error {
  constructor(public code: 'auth' | 'unavailable' | 'quota_schema' | 'rate_limit') { super(code); }
}
const used = z.number().finite().min(0).max(100);
const claudeWindow = z.object({ utilization: used, resets_at: z.string().datetime({ offset: true }).nullable() });
export function parseClaudeUsage(value: unknown): Snapshot {
  const data = z.object({ five_hour: claudeWindow.nullable(), seven_day: claudeWindow.nullable() }).parse(value);
  const windows: Window[] = [];
  if (data.five_hour) windows.push({ kind: 'five_hour', used: data.five_hour.utilization, resetsAt: data.five_hour.resets_at ? Date.parse(data.five_hour.resets_at) : null });
  if (data.seven_day) windows.push({ kind: 'weekly', used: data.seven_day.utilization, resetsAt: data.seven_day.resets_at ? Date.parse(data.seven_day.resets_at) : null });
  return { windows };
}
const codexWindow = z.object({ usedPercent: used, windowDurationMins: z.number().int().positive().nullable(), resetsAt: z.number().int().nonnegative().nullable() });
const bucket = z.object({ primary: codexWindow.nullable(), secondary: codexWindow.nullable(), limitId: z.string().nullable().optional() });
export function parseCodexUsage(value: unknown): Snapshot {
  const data = z.object({ rateLimits: bucket, rateLimitsByLimitId: z.record(z.string(), bucket).nullable().optional() }).parse(value);
  const limits = data.rateLimitsByLimitId?.codex ?? data.rateLimits;
  if (limits.limitId && limits.limitId !== 'codex') throw new ProviderError('quota_schema');
  const windows: Window[] = [];
  for (const item of [limits.primary, limits.secondary]) {
    if (!item) continue;
    const kind = item.windowDurationMins === 300 ? 'five_hour' : item.windowDurationMins === 10080 ? 'weekly' : null;
    if (!kind || windows.some(w => w.kind === kind)) throw new ProviderError('quota_schema');
    windows.push({ kind, used: item.usedPercent, resetsAt: item.resetsAt === null ? null : item.resetsAt * 1000 });
  }
  return { windows };
}

export function cleanEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH, VOLTA_HOME: process.env.VOLTA_HOME ?? join(homedir(), '.volta'), HOME: home, USERPROFILE: home, TMPDIR: tmpdir(),
    LANG: 'C.UTF-8', CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
    DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1'
  };
}

export function runProcess(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, timeout = 90_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.length > 1_000_000) child.kill('SIGKILL');
    });
    child.stderr.resume();
    child.on('error', () => { clearTimeout(timer); reject(new ProviderError('unavailable')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new ProviderError('unavailable'));
    });
  });
}

class CodexRpc {
  private child;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private events: any[] = [];
  private closed = false;
  constructor(home: string, cwd: string) {
    this.child = spawn('codex', ['app-server'], { env: cleanEnvironment(home), cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.resume();
    createInterface({ input: this.child.stdout }).on('line', line => {
      if (line.length > 2_000_000) { this.close(); return; }
      try {
        const message = JSON.parse(line);
        if (message.id !== undefined && message.method) {
          this.child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Unsupported request' } }) + '\n');
        } else if (message.id !== undefined) {
          const pending = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) pending?.reject(new ProviderError(/auth|login|401|refresh token/i.test(JSON.stringify(message.error)) ? 'auth' : 'unavailable'));
          else pending?.resolve(message.result);
        } else {
          this.events.push(message);
          if (this.events.length > 2000) this.events.shift();
        }
      } catch { this.close(); }
    });
    this.child.on('error', () => this.fail());
    this.child.on('exit', () => this.fail());
    this.child.stdin.on('error', () => this.fail());
  }
  private fail() {
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(new ProviderError('unavailable'));
    this.pending.clear();
  }
  async call(method: string, params: object = {}): Promise<any> {
    if (this.closed) throw new ProviderError('unavailable');
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new ProviderError('unavailable')); }, 30_000);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  async initialize() {
    await this.call('initialize', { clientInfo: { name: 'acadence', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  }
  async open(cwd: string) {
    const { thread } = await this.call('thread/start', {
      cwd, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true,
      baseInstructions: 'Reply with hello only. Do not use tools.',
      ...(process.env.CODEX_MODEL ? { model: process.env.CODEX_MODEL } : {})
    });
    const { turn } = await this.call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Hello. Reply with hello only.', text_elements: [] }] });
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && !this.closed) {
      const event = this.events.find(e => e.method === 'turn/completed' && e.params?.threadId === thread.id && e.params?.turn?.id === turn.id);
      if (event) {
        if (event.params.turn.status !== 'completed') throw new ProviderError('unavailable');
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new ProviderError('unavailable');
  }
  close() { this.child.kill('SIGKILL'); this.fail(); }
  async finish() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => this.close(), 1000);
      this.child.once('close', () => { clearTimeout(timer); resolve(); });
      this.child.stdin.end();
    });
  }
}

export type ProviderAdapter = {
  execute(provider: Provider, credentials: Credentials, action: 'poll' | 'open', save: (credentials: Credentials) => void): Promise<Snapshot | null>;
};

export class Providers implements ProviderAdapter {
  async execute(provider: Provider, credentials: Credentials, action: 'poll' | 'open', save: (credentials: Credentials) => void): Promise<Snapshot | null> {
    const home = await mkdtemp(join(tmpdir(), 'acadence-provider-'));
    const config = join(home, provider === 'codex' ? '.codex' : '.claude');
    const file = join(config, provider === 'codex' ? 'auth.json' : '.credentials.json');
    const cwd = join(home, 'work');
    await mkdir(config, { mode: 0o700 });
    await mkdir(cwd, { mode: 0o700 });
    await writeFile(file, JSON.stringify(credentials), { mode: 0o600 });
    let rpc: CodexRpc | undefined;
    try {
      if (provider === 'codex') {
        await writeFile(join(config, 'config.toml'), 'cli_auth_credentials_store = "file"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[features]\nshell_tool = false\n', { mode: 0o600 });
        rpc = new CodexRpc(home, cwd);
        await rpc.initialize();
        await rpc.call('account/read', { refreshToken: true });
        if (action === 'open') { await rpc.open(cwd); return null; }
        return parseCodexUsage(await rpc.call('account/rateLimits/read'));
      }
      let data = claudeCredentials.parse(credentials);
      const refresh = async () => {
        const response = await fetch('https://platform.claude.com/v1/oauth/token', {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: data.claudeAiOauth.refreshToken,
            client_id: data.claudeAiOauth.clientId ?? '9d1c250a-e61b-44d9-88ed-5944d1962f5e', scope: data.claudeAiOauth.scopes.join(' ') })
        });
        if (!response.ok) throw new ProviderError([400, 401, 403].includes(response.status) ? 'auth' : 'unavailable');
        const refreshed = z.object({ access_token: token, refresh_token: token.optional(), expires_in: z.number().positive() }).parse(await response.json());
        data = { claudeAiOauth: { ...data.claudeAiOauth, accessToken: refreshed.access_token, refreshToken: refreshed.refresh_token ?? data.claudeAiOauth.refreshToken, expiresAt: Date.now() + refreshed.expires_in * 1000 } };
        save(data);
        await writeFile(file, JSON.stringify(data), { mode: 0o600 });
      };
      if (data.claudeAiOauth.expiresAt < Date.now() + 120_000) await refresh();
      if (action === 'open') {
        const output = await runProcess('claude', ['-p', 'Hello. Reply with hello only.', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence', '--max-turns', '1', ...(process.env.CLAUDE_MODEL ? ['--model', process.env.CLAUDE_MODEL] : [])], cleanEnvironment(home), cwd);
        const result = JSON.parse(output);
        if (result.is_error || result.type !== 'result' || result.subtype !== 'success') throw new ProviderError('unavailable');
        return null;
      }
      const usage = () => fetch('https://api.anthropic.com/api/oauth/usage', {
        headers: { Authorization: `Bearer ${data.claudeAiOauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'acadence/0.1.0' },
        redirect: 'error', signal: AbortSignal.timeout(30_000)
      });
      let response = await usage();
      if (response.status === 401) { await refresh(); response = await usage(); }
      if (!response.ok) throw new ProviderError([401, 403].includes(response.status) ? 'auth' : response.status === 429 ? 'rate_limit' : 'unavailable');
      return parseClaudeUsage(await response.json());
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (error instanceof z.ZodError) throw new ProviderError('quota_schema');
      throw new ProviderError('unavailable');
    } finally {
      await rpc?.finish();
      try { save(parseCredentials(provider, JSON.parse(await readFile(file, 'utf8')))); }
      finally { await rm(home, { recursive: true, force: true }); }
    }
  }
}
