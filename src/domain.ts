import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';

export const HOUR = 3_600_000;
export const FIVE = 5 * HOUR;
export const WEEK = 7 * 24 * HOUR;
export const anchorSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const timezoneSchema = z.string().max(100).refine(value => {
  try { Temporal.Now.zonedDateTimeISO(value); return true; } catch { return false; }
}, 'Invalid IANA timezone');
export const scheduleSchema = z.object({
  anchors: z.array(anchorSchema).max(24).transform(a => [...new Set(a)].sort()),
  timezone: timezoneSchema
});
export type Schedule = z.infer<typeof scheduleSchema>;
export type Provider = 'claude' | 'codex';
export type WindowKind = 'five_hour' | 'weekly';
export type Window = { kind: WindowKind; used: number; resetsAt: number | null };
export type Snapshot = { windows: Window[] };

export function anchorsAround(schedule: Schedule, now: number): number[] {
  const day = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(schedule.timezone).toPlainDate();
  const result: number[] = [];
  for (let offset = -2; offset <= 3; offset++) {
    const date = day.add({ days: offset });
    for (const anchor of schedule.anchors) {
      const time = Temporal.PlainTime.from(anchor);
      result.push(date.toPlainDateTime(time).toZonedDateTime(schedule.timezone, { disambiguation: 'compatible' }).epochMilliseconds);
    }
  }
  return [...new Set(result)].sort((a, b) => a - b);
}

export function nextAnchor(schedule: Schedule, now: number): number | null {
  return anchorsAround(schedule, now).find(time => time > now) ?? null;
}

export function canContinue(schedule: Schedule, now: number): boolean {
  const next = nextAnchor(schedule, now);
  return next === null || next - now >= FIVE;
}

export function nextScheduled(schedule: Schedule, after: number): number | null {
  const anchors = anchorsAround(schedule, after);
  const slots: number[] = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    const start = anchors[i]!;
    const end = anchors[i + 1]!;
    slots.push(start);
    for (let time = start + FIVE; time + FIVE <= end; time += FIVE) slots.push(time);
  }
  return slots.sort((a, b) => a - b).find(time => time > after) ?? null;
}

export function resetDetected(previous: Window, current: Window, now: number): boolean {
  // A provider grant restores quota while the observed window is still active.
  // Allow a minute for provider clock/expiry jitter at the ordinary boundary.
  return previous.kind === current.kind && previous.resetsAt !== null &&
    previous.resetsAt > now + 60_000 && current.used + 0.5 < previous.used;
}

export function windowRolledOver(previous: Window, current: Window, now: number): boolean {
  return previous.kind === current.kind && previous.resetsAt !== null &&
    previous.resetsAt <= now + 60_000 && (
      current.used + 0.5 < previous.used ||
      current.resetsAt === null && current.used === 0 ||
      current.resetsAt !== null && current.resetsAt > previous.resetsAt + 60_000
    );
}
