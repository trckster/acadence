export function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatReset(timestamp: number | null, now: number): string {
  if (timestamp === null) return 'not active';
  const remaining = timestamp - now;
  if (remaining > 0 && remaining < 24 * 60 * 60_000) {
    const minutes = Math.floor(remaining / 60_000);
    if (minutes === 0) return 'in less than 1m';
    const hours = Math.floor(minutes / 60);
    return `in ${hours ? `${hours}h ` : ''}${minutes % 60}m`;
  }
  return formatTimestamp(timestamp);
}
