import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store, type Account, type User } from './db.js';
import { HOUR, nextScheduled, scheduleSchema, timezoneSchema } from './domain.js';
import { accountEmail, parseCredentials, type Credentials } from './providers.js';
import { hash, secret, Vault } from './security.js';
import { Engine } from './engine.js';

export async function createApi(store: Store, vault: Vault, engine: Engine, botUsername: string, telegramHealthy = () => true) {
  const app = Fastify({ logger: false, bodyLimit: 128 * 1024, trustProxy: (_address, hop) => hop < Number(process.env.TRUST_PROXY_HOPS ?? 0) });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute', keyGenerator: request => request.headers.authorization ? hash(request.headers.authorization) : request.ip });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
  });
  app.setErrorHandler((error: any, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid request data' });
    const code = error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    return reply.code(code).send({ error: code === 500 ? 'Internal service error' : error.message });
  });
  const fail = (statusCode: number, message: string): never => { throw Object.assign(new Error(message), { statusCode }); };
  function authenticate(header: string | undefined): User {
    if (!header?.startsWith('Bearer ') || header.length > 100) return fail(401, 'Sign in with acadence login');
    const user = store.get<User>('SELECT u.* FROM users u JOIN tokens t ON t.user_id=u.id WHERE t.hash=? AND t.expires>?', hash(header.slice(7)), Date.now());
    return user ?? fail(401, 'Sign in with acadence login');
  }
  const owned = (user: User, id: string) => store.get<Account>('SELECT * FROM accounts WHERE id=? AND user_id=?', id, user.id) ?? fail(404, 'Account not found');
  const idle = (account: Account) => { if (engine.busy.has(account.id)) fail(409, 'Account operation in progress; retry shortly'); };
  app.get('/health', async (_request, reply) => {
    store.get('SELECT 1');
    const healthy = Date.now() - engine.lastTick < 300_000 && telegramHealthy();
    return reply.code(healthy ? 200 : 503).send({ status: healthy ? 'ok' : 'degraded' });
  });
  app.post('/v1/auth/device', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async request => {
    const { timezone } = z.object({ timezone: timezoneSchema }).parse(request.body);
    const device = secret();
    const code = secret();
    store.run('INSERT INTO devices(hash,code_hash,timezone,expires) VALUES(?,?,?,?)', hash(device), hash(code), timezone, Date.now() + 10 * 60_000);
    return { device, url: `https://t.me/${botUsername}?start=${code}`, expiresIn: 600 };
  });
  app.post('/v1/auth/poll', async (request, reply) => {
    const { device } = z.object({ device: z.string().length(43) }).parse(request.body);
    return store.transaction(() => {
      const row = store.get<{ user_id: string | null }>('SELECT user_id FROM devices WHERE hash=? AND expires>?', hash(device), Date.now());
      if (!row) return fail(410, 'Sign-in expired; run acadence login again');
      if (!row.user_id) return reply.code(202).send({ pending: true });
      const token = secret();
      store.run('INSERT INTO tokens(hash,user_id,created,expires) VALUES(?,?,?,?)', hash(token), row.user_id, Date.now(), Date.now() + 365 * 24 * HOUR);
      store.run('DELETE FROM devices WHERE hash=?', hash(device));
      return { token };
    });
  });
  app.delete('/v1/auth', async request => {
    const user = authenticate(request.headers.authorization);
    const { all } = z.object({ all: z.enum(['true','false']).optional() }).parse(request.query);
    if (all === 'true') store.run('DELETE FROM tokens WHERE user_id=?', user.id);
    else store.run('DELETE FROM tokens WHERE hash=?', hash(request.headers.authorization!.slice(7)));
    return { ok: true };
  });
  app.get('/v1/schedule', async request => store.schedule(authenticate(request.headers.authorization)));
  app.put('/v1/schedule', async request => {
    const user = authenticate(request.headers.authorization);
    const schedule = scheduleSchema.parse(request.body);
    store.transaction(() => {
      store.run('UPDATE users SET timezone=?,anchors=?,schedule_version=schedule_version+1 WHERE id=?', schedule.timezone, JSON.stringify(schedule.anchors), user.id);
      store.run("DELETE FROM jobs WHERE account_id IN (SELECT id FROM accounts WHERE user_id=?) AND reason IN ('anchor','scheduled','five_reset')", user.id);
      store.run("UPDATE accounts SET next_session=? WHERE user_id=? AND id IN (SELECT account_id FROM windows WHERE kind='five_hour' AND present=1)", nextScheduled(schedule, Date.now()), user.id);
    });
    return schedule;
  });
  app.get('/v1/accounts', async request => {
    const user = authenticate(request.headers.authorization);
    return store.all<Account>('SELECT * FROM accounts WHERE user_id=? ORDER BY provider,category,id', user.id).map(account => ({
      id: account.id, provider: account.provider, category: account.category, status: account.status, lastError: account.last_error,
      email: accountEmail(vault.open<Credentials>(account.credentials, account.id)),
      nextSession: account.next_session, lastSuccess: account.last_success,
      limits: store.all('SELECT kind,used,resets_at AS resetsAt,sampled_at AS sampledAt FROM windows WHERE account_id=? AND present=1', account.id),
      pending: store.all('SELECT reason,attempts,due FROM jobs WHERE account_id=?', account.id)
    }));
  });
  app.post('/v1/accounts', async request => {
    const user = authenticate(request.headers.authorization);
    const body = z.object({ provider: z.enum(['claude','codex']), category: z.enum(['personal','work']), credentials: z.unknown() }).parse(request.body);
    if (store.get<{ count: number }>('SELECT COUNT(*) AS count FROM accounts WHERE user_id=?', user.id)!.count >= 20) return fail(409, 'Maximum 20 accounts per user');
    const credentials = parseCredentials(body.provider, body.credentials);
    const email = accountEmail(credentials);
    if (!email) return fail(400, 'Could not determine account email; sign in again');
    const existing = store.all<Account>('SELECT * FROM accounts WHERE user_id=? AND provider=? AND category=?', user.id, body.provider, body.category);
    if (existing.some(account => accountEmail(vault.open<Credentials>(account.credentials, account.id))?.toLowerCase() === email.toLowerCase())) {
      return fail(409, 'This service, account type and email are already connected; run acadence reauth');
    }
    const id = randomUUID();
    store.run('INSERT INTO accounts(id,user_id,provider,category,credentials) VALUES(?,?,?,?,?)', id, user.id, body.provider, body.category, vault.seal(credentials, id));
    return { id, status: 'active', message: 'Connected; limits will appear after the first check' };
  });
  app.post<{ Params: { id: string } }>('/v1/accounts/:id/usage', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async request => {
    const account = owned(authenticate(request.headers.authorization), request.params.id);
    if (account.status !== 'active') return { limits: [], refreshError: 'reauthentication required' };
    if (engine.busy.has(account.id) || engine.busy.size >= engine.concurrency) return { limits: [], refreshError: 'account operation in progress; retry shortly' };
    engine.busy.add(account.id);
    try {
      const snapshot = await engine.poll(account, Date.now());
      const current = owned(authenticate(request.headers.authorization), account.id);
      return {
        status: current.status, lastError: current.last_error,
        email: accountEmail(vault.open<Credentials>(current.credentials, current.id)),
        limits: snapshot?.windows ?? [],
        pending: store.all('SELECT reason,attempts,due FROM jobs WHERE account_id=?', account.id),
        refreshError: snapshot ? null : current.last_error ?? 'provider unavailable'
      };
    } finally { engine.busy.delete(account.id); }
  });
  app.put<{ Params: { id: string } }>('/v1/accounts/:id', async request => {
    const account = owned(authenticate(request.headers.authorization), request.params.id);
    idle(account);
    const credentials = parseCredentials(account.provider, z.object({ credentials: z.unknown() }).parse(request.body).credentials);
    const email = accountEmail(credentials);
    if (!email) return fail(400, 'Could not determine account email; sign in again');
    const previousEmail = accountEmail(vault.open<Credentials>(account.credentials, account.id));
    if (previousEmail && previousEmail.toLowerCase() !== email.toLowerCase()) return fail(409, 'Sign in to the same email to reauthenticate; use acadence connect for another account');
    const existing = store.all<Account>('SELECT * FROM accounts WHERE user_id=? AND provider=? AND category=? AND id<>?', account.user_id, account.provider, account.category, account.id);
    if (existing.some(other => accountEmail(vault.open<Credentials>(other.credentials, other.id))?.toLowerCase() === email.toLowerCase())) return fail(409, 'This service, account type and email are already connected');
    store.transaction(() => {
      store.run("UPDATE accounts SET credentials=?,version=version+1,status='active',failures=0,last_error=NULL,next_poll=0 WHERE id=?", vault.seal(credentials, account.id), account.id);
      store.run('DELETE FROM jobs WHERE account_id=?', account.id);
    });
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/v1/accounts/:id', async request => {
    const account = owned(authenticate(request.headers.authorization), request.params.id);
    idle(account);
    store.run('DELETE FROM accounts WHERE id=?', account.id);
    return { ok: true };
  });
  app.post('/v1/trigger', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async request => {
    const user = authenticate(request.headers.authorization);
    const accounts = store.all<Account>("SELECT * FROM accounts WHERE user_id=? AND status='active'", user.id);
    store.transaction(() => {
      for (const account of accounts) engine.enqueue(account, 'manual', `manual:${account.id}`, Date.now());
    });
    return { queued: accounts.length };
  });
  return app;
}
