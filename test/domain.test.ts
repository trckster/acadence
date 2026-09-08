import test from 'node:test';
import assert from 'node:assert/strict';
import { FIVE, HOUR, anchorsAround, canContinue, nextScheduled, resetDetected } from '../src/domain.js';

const utc = (anchors: string[]) => ({ timezone: 'UTC', anchors });
const date = (time: string) => Date.parse(`2026-09-08T${time}:00Z`);
test('one anchor respects the five-hour gap before tomorrow', () => {
  let cursor = date('05:59');
  const slots: string[] = [];
  for (let i = 0; i < 5; i++) { cursor = nextScheduled(utc(['06:00']), cursor)!; slots.push(new Date(cursor).toISOString()); }
  assert.deepEqual(slots.map(s => s.slice(11, 16)), ['06:00','11:00','16:00','21:00','06:00']);
  assert.equal(slots[4]!.slice(0,10), '2026-09-09');
});
test('multiple anchors suppress interfering continuations across midnight', () => {
  let cursor = date('05:59');
  const slots: string[] = [];
  for (let i = 0; i < 6; i++) { cursor = nextScheduled(utc(['06:00','13:00']), cursor)!; slots.push(new Date(cursor).toISOString().slice(11,16)); }
  assert.deepEqual(slots, ['06:00','13:00','18:00','23:00','06:00','13:00']);
  assert.equal(canContinue(utc(['06:00','13:00']), date('11:00')), false);
  assert.equal(canContinue(utc(['13:00']), date('08:00')), true);
  assert.equal(canContinue(utc([]), date('08:00')), true);
  assert.equal(nextScheduled(utc([]), date('08:00')), null);
});
test('anchors less than five hours apart still each open', () => {
  assert.equal(nextScheduled(utc(['06:00','07:00']), date('06:00')), date('07:00'));
});
test('DST gaps shift forward and repeated anchors run once at the earlier occurrence', () => {
  const schedule = { timezone: 'Europe/Rome', anchors: ['02:30'] };
  const spring = anchorsAround(schedule, Date.parse('2026-03-29T00:00:00Z'));
  assert.ok(spring.includes(Date.parse('2026-03-29T01:30:00Z')));
  const fall = anchorsAround(schedule, Date.parse('2026-10-25T00:00:00Z'));
  assert.ok(fall.includes(Date.parse('2026-10-25T00:30:00Z')));
  assert.ok(!fall.includes(Date.parse('2026-10-25T01:30:00Z')));
});
test('continuations use elapsed hours on a DST day', () => {
  const schedule = { timezone: 'Europe/Rome', anchors: ['00:00'] };
  const start = Date.parse('2026-03-28T23:00:00Z');
  assert.equal(nextScheduled(schedule, start), start + FIVE);
});
test('reset detection requires observed evidence, not just a clock passing', () => {
  const now = Date.now();
  const old = { kind: 'five_hour' as const, used: 60, resetsAt: now - HOUR };
  assert.equal(resetDetected(old, old, now), false);
  assert.equal(resetDetected(old, { ...old, used: 65, resetsAt: now + FIVE }, now), true);
  assert.equal(resetDetected(old, { ...old, used: 0, resetsAt: null }, now), true);
  assert.equal(resetDetected({ ...old, resetsAt: null }, { ...old, used: 20, resetsAt: null }, now), true);
  assert.equal(resetDetected(old, { ...old, used: 59.8 }, now), false);
});
