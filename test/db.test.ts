import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.js';

test('legacy account migration preserves accounts and dependencies and removes label uniqueness', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acadence-migration-'));
  const path = join(dir, 'db.sqlite');
  try {
    const initial = new Store(path);
    initial.run("INSERT INTO users(id,telegram_id,timezone,anchors) VALUES('u','1','UTC','[\"06:00\"]')");
    for (const id of ['a','b','c']) {
      initial.run("INSERT INTO accounts(id,user_id,provider,category,credentials,next_session) VALUES(?,'u','codex','personal',?,123)", id, `encrypted-${id}`);
    }
    initial.run("INSERT INTO windows(account_id,kind,used,sampled_at) VALUES('a','weekly',12,1)");
    initial.run("INSERT INTO observations(account_id,sampled_at,snapshot) VALUES('a',1,'{}')");
    initial.run("INSERT INTO jobs(account_id,reason,dedupe,due,account_version,schedule_version) VALUES('a','manual','job',1,1,1)");
    initial.notify('u', 'a', 'notice', 'Existing notification', 1);
    initial.close();
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      ALTER TABLE accounts RENAME COLUMN category TO label;
      PRAGMA ignore_check_constraints=ON;
      UPDATE accounts SET label=CASE id WHEN 'a' THEN 'default' WHEN 'b' THEN 'work' ELSE 'custom' END;
      CREATE UNIQUE INDEX legacy_labels ON accounts(user_id,provider,label);
    `);
    legacy.close();
    for (let attempt = 0; attempt < 2; attempt++) {
      const migrated = new Store(path);
      try {
        assert.deepEqual(migrated.all<{ category: string }>('SELECT category FROM accounts ORDER BY id').map(row => row.category), ['personal','work','personal']);
        assert.equal(migrated.get<{ credentials: string }>("SELECT credentials FROM accounts WHERE id='a'")!.credentials, 'encrypted-a');
        assert.equal(migrated.get<{ next_session: number }>("SELECT next_session FROM accounts WHERE id='a'")!.next_session, 123);
        for (const table of ['windows','observations','jobs','notifications']) assert.equal(migrated.all(`SELECT * FROM ${table}`).length, 1);
        assert.deepEqual(migrated.all('PRAGMA foreign_key_check'), []);
        assert.equal(migrated.all<{ name: string }>('PRAGMA table_info(accounts)').some(column => column.name === 'label'), false);
        if (attempt === 1) {
          migrated.run("DELETE FROM accounts WHERE id='a'");
          for (const table of ['windows','observations','jobs','notifications']) assert.equal(migrated.all(`SELECT * FROM ${table}`).length, 0);
        }
      } finally { migrated.close(); }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
