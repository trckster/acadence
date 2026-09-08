import type { Window } from './domain.js';

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
  return `${window.kind === 'five_hour' ? '5h' : 'Week'}: ${window.used}% used; resets ${formatReset(window.resetsAt, now, timezone)}`;
}
