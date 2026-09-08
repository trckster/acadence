import { RequestError } from './errors.js';
import { resolve } from 'node:path';
import { lock } from 'proper-lockfile';
import { z } from 'zod';
import { Store } from './db.js';
import { Vault } from './security.js';
import { Engine } from './engine.js';
import { Providers } from './providers.js';
import { Telegram, telegramApi } from './telegram.js';
import { createApi } from './api.js';

process.umask(0o077);
const env = z.object({
  ENCRYPTION_KEY: z.string(), TELEGRAM_BOT_TOKEN: z.string().regex(/^\d+:[A-Za-z0-9_-]+$/),
  DATABASE_PATH: z.string().default('/data/acadence.sqlite'), PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4)
}).safeParse(process.env);
if (!env.success) { console.error('Invalid environment: set ENCRYPTION_KEY and TELEGRAM_BOT_TOKEN; check numeric settings.'); process.exit(1); }

async function main() {
  const config = env.data!;
  const vault = new Vault(config.ENCRYPTION_KEY);
  const store = new Store(resolve(config.DATABASE_PATH));
  const release = await lock(resolve(config.DATABASE_PATH), { stale: 30_000, update: 10_000, retries: 0 });
  const keyCheck = store.get<{ value: string }>("SELECT value FROM metadata WHERE key='key_check'");
  if (keyCheck) vault.open(keyCheck.value, 'key_check');
  else store.run("INSERT INTO metadata(key,value) VALUES('key_check',?)", vault.seal('acadence', 'key_check'));
  const api = telegramApi(config.TELEGRAM_BOT_TOKEN);
  const bot = await api('getMe', {});
  const webhook = await api('getWebhookInfo', {});
  if (webhook.url) throw new Error('Telegram bot must be dedicated to Acadence and have no webhook');
  const telegram = new Telegram(store, api);
  const engine = new Engine(store, vault, new Providers(), config.WORKER_CONCURRENCY);
  const app = await createApi(store, vault, engine, bot.username, () => Date.now() - telegram.lastSuccess < 300_000);
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  console.info(`Acadence listening on port ${config.PORT}`);
  const tick = () => { void engine.tick().catch(() => console.error('Worker tick failed; check database availability')); };
  const send = () => { void telegram.send().catch(() => console.error('Notification dispatch failed')); };
  const workerTimer = setInterval(tick, 5000);
  const telegramTimer = setInterval(send, 1000);
  const poll = telegram.poll();
  tick();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(workerTimer);
    clearInterval(telegramTimer);
    telegram.stop();
    await app.close();
    await engine.drain();
    await poll;
    await telegram.send();
    await release();
    store.close();
  };
  process.once('SIGTERM', () => { void stop().then(() => process.exit(0)); });
  process.once('SIGINT', () => { void stop().then(() => process.exit(0)); });
}
main().catch(error => { console.error(error instanceof RequestError ? `Startup failed: ${error.message}` : 'Startup failed: check configuration, encryption key, database lock, and Telegram connectivity.'); process.exit(1); });
