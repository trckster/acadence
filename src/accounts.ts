import { Store, type Account } from './db.js';
import { Engine } from './engine.js';
import { accountEmail, type Credentials } from './providers.js';
import { Vault } from './security.js';
import type { AccountView } from './account-view.js';
import { refreshAccountViews } from './account-view.js';

export function listAccounts(store: Store, vault: Vault, userId: string): AccountView[] {
  return store.all<Account>('SELECT * FROM accounts WHERE user_id=? ORDER BY provider,category,id', userId).map(account => ({
    id: account.id, provider: account.provider, category: account.category, status: account.status, lastError: account.last_error,
    email: accountEmail(vault.open<Credentials>(account.credentials, account.id)),
    nextSession: account.next_session, lastSuccess: account.last_success,
    limits: store.all('SELECT kind,used,resets_at AS resetsAt,sampled_at AS sampledAt FROM windows WHERE account_id=? AND present=1', account.id),
    pending: store.all('SELECT reason,attempts,due FROM jobs WHERE account_id=?', account.id)
  }));
}

export async function refreshUsage(store: Store, vault: Vault, engine: Engine, account: Account, currentAccount: () => Account): Promise<Partial<AccountView>> {
  if (account.status !== 'active') return { status: account.status, lastError: account.last_error, pending: [], limits: [], refreshError: account.status === 'monitoring_paused'
    ? 'monitoring paused; run acadence reauth or connect again' : 'reauthentication required' };
  const operation = await engine.runIfIdle(account.id, async () => {
    const snapshot = await engine.poll(account, Date.now());
    const current = currentAccount();
    return {
      status: current.status, lastError: current.last_error,
      email: accountEmail(vault.open<Credentials>(current.credentials, current.id)),
      limits: snapshot?.windows ?? [],
      pending: store.all<AccountView['pending'][number]>('SELECT reason,attempts,due FROM jobs WHERE account_id=?', account.id),
      refreshError: snapshot ? null : current.last_error ?? 'provider unavailable'
    };
  });
  return operation ? operation.result : { limits: [], refreshError: 'account operation in progress; retry shortly' };
}

export async function seeAccounts(store: Store, vault: Vault, engine: Engine, userId: string) {
  return refreshAccountViews(listAccounts(store, vault, userId), async row => {
    const current = () => {
      const account = store.get<Account>('SELECT * FROM accounts WHERE id=? AND user_id=?', row.id, userId);
      if (!account) throw new Error('Account not found');
      return account;
    };
    return refreshUsage(store, vault, engine, current(), current);
  });
}
