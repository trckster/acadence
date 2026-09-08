import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Provider, Schedule, WindowKind } from './domain.js';

export type User = { id: string; telegram_id: string; timezone: string; anchors: string; schedule_version: number };
export type Account = { id: string; user_id: string; provider: Provider; label: string; credentials: string; status: string; version: number; next_poll: number; next_session: number | null; failures: number; last_error: string | null; last_success: number | null };
export type WindowRow = { account_id: string; kind: WindowKind; used: number; resets_at: number | null; generation: number; sampled_at: number; present: number };
export type Job = { id: number; account_id: string; reason: string; dedupe: string; due: number; attempts: number; account_version: number; schedule_version: number; expires: number | null };

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, telegram_id TEXT NOT NULL UNIQUE, timezone TEXT NOT NULL,
        anchors TEXT NOT NULL DEFAULT '[]', schedule_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS tokens (
        hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created INTEGER NOT NULL, expires INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS devices (
        hash TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, timezone TEXT NOT NULL,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL CHECK(provider IN ('claude','codex')), label TEXT NOT NULL,
        credentials TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', version INTEGER NOT NULL DEFAULT 1,
        next_poll INTEGER NOT NULL DEFAULT 0, next_session INTEGER, failures INTEGER NOT NULL DEFAULT 0,
        last_error TEXT, last_success INTEGER, UNIQUE(user_id,provider,label)
      );
      CREATE TABLE IF NOT EXISTS windows (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, used REAL NOT NULL, resets_at INTEGER, generation INTEGER NOT NULL DEFAULT 0,
        sampled_at INTEGER NOT NULL, present INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(account_id,kind)
      );
      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        sampled_at INTEGER NOT NULL, snapshot TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        reason TEXT NOT NULL, dedupe TEXT NOT NULL UNIQUE, due INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, account_version INTEGER NOT NULL,
        schedule_version INTEGER NOT NULL, expires INTEGER
      );
      CREATE INDEX IF NOT EXISTS jobs_due ON jobs(due);
      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
        dedupe TEXT NOT NULL UNIQUE, body TEXT NOT NULL, due INTEGER NOT NULL, sent INTEGER, attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS notifications_due ON notifications(sent,due);
      CREATE INDEX IF NOT EXISTS observations_time ON observations(sampled_at);
    `);
  }
  run(sql: string, ...args: SQLInputValue[]) { return this.db.prepare(sql).run(...args); }
  get<T>(sql: string, ...args: SQLInputValue[]): T | undefined { return this.db.prepare(sql).get(...args) as T | undefined; }
  all<T>(sql: string, ...args: SQLInputValue[]): T[] { return this.db.prepare(sql).all(...args) as T[]; }
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  schedule(user: User): Schedule { return { anchors: JSON.parse(user.anchors), timezone: user.timezone }; }
  notify(userId: string, accountId: string | null, dedupe: string, body: string, now: number) {
    this.run('INSERT OR IGNORE INTO notifications(user_id,account_id,dedupe,body,due) VALUES(?,?,?,?,?)', userId, accountId, dedupe, body, now);
  }
  close() { this.db.close(); }
}
