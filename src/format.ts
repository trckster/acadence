import type { Window, WindowKind } from './domain.js';
import type { AccountView } from './account-view.js';
import { providerErrorMessage } from './errors.js';

export const windowLabels: Record<WindowKind, string> = { five_hour: '5h', weekly: 'Week', weekly_fable: 'Week (Fable)' };

export function formatTimestamp(timestamp: number, timezone?: string): string {
  const date = new Date(timestamp);
  if (timezone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(date);
    const part = (type: string) => parts.find(item => item.type === type)!.value;
    return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
  }
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatReset(timestamp: number | null, now: number, timezone?: string): string {
  if (timestamp === null) return 'not active';
  const remaining = timestamp - now;
  if (remaining > 0 && remaining < 24 * 60 * 60_000) {
    const minutes = Math.floor(remaining / 60_000);
    if (minutes === 0) return 'in less than 1m';
    const hours = Math.floor(minutes / 60);
    return `in ${hours ? `${hours}h ` : ''}${minutes % 60}m`;
  }
  return formatTimestamp(timestamp, timezone);
}

export function formatAccount(provider: string, email: string | null | undefined): string {
  return `${provider}: ${email ?? 'email unavailable'}`;
}

export function formatUsage(window: Window, now: number, timezone?: string): string {
  if (window.used === 0 && window.resetsAt === null) return `${windowLabels[window.kind]}: 0% used; not active`;
  return `${windowLabels[window.kind]}: ${window.used}% used; resets ${formatReset(window.resetsAt, now, timezone)}`;
}

export function formatAccounts(rows: AccountView[], now: number, timezone?: string): string {
  if (!rows.length) return 'No accounts connected';
  return rows.map(row => {
    const lines = [`${row.provider} / ${row.category} / ${row.email ?? 'email unavailable'}`];
    if (row.status === 'monitoring_paused') {
      return [...lines, '    inactive', '    subscription unavailable; run acadence reauth'].join('\n');
    }
    lines.push(`    ${row.status.replaceAll('_', ' ')}${row.lastError ? ` (${providerErrorMessage(row.lastError)})` : ''}`);
    if (row.refreshError) lines.push(`    Usage unavailable: ${providerErrorMessage(row.refreshError)}`);
    for (const [kind, label] of Object.entries(windowLabels)) {
      const limit = row.limits.find(item => item.kind === kind);
      if (kind === 'weekly_fable' && !limit) continue;
      lines.push(limit
        ? `    ${formatUsage(limit, now, timezone)}${row.stale ? ` (last known; checked ${formatTimestamp(limit.sampledAt!, timezone)})` : ''}`
        : `    ${label}: usage unavailable`);
    }
    if (row.pending.length) lines.push(`    ${row.pending.length} pending operation(s)`);
    return lines.join('\n');
  }).join('\n\n');
}
