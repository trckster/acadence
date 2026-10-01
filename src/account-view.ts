import type { Window } from './domain.js';
import { formatError } from './errors.js';

export type AccountView = {
  id: string; provider: string; category: string; email?: string | null;
  status: string; lastError: string | null;
  limits: (Window & { sampledAt?: number })[];
  pending: { reason: string; attempts: number; due: number }[];
  refreshError?: string | null; stale?: boolean;
};

export async function refreshAccountViews(rows: AccountView[], refresh: (row: AccountView) => Promise<Partial<AccountView>>) {
  for (let i = 0; i < rows.length; i += 4) {
    await Promise.all(rows.slice(i, i + 4).map(async row => {
      const savedLimits = row.limits ?? [];
      row.limits = [];
      try { Object.assign(row, await refresh(row)); }
      catch (error) { row.refreshError = formatError(error); }
      if (row.refreshError && row.status === 'active' && !['auth', 'reauthentication required'].includes(row.refreshError)) {
        row.limits = savedLimits;
        row.stale = true;
      }
    }));
  }
  return rows;
}
