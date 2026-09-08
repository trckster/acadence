import test from 'node:test';
import assert from 'node:assert/strict';
import { formatReset, formatTimestamp } from '../src/format.js';

test('timestamps use local time with YYYY-MM-DD and a 24-hour clock', () => {
  assert.equal(formatTimestamp(new Date(2026, 8, 8, 17, 3).getTime()), '2026-09-08 17:03');
  assert.equal(formatTimestamp(new Date(2026, 0, 2, 0, 5).getTime()), '2026-01-02 00:05');
});

test('only future resets less than 24 elapsed hours away use remaining time', () => {
  const now = new Date(2026, 8, 8, 12, 0).getTime();
  const minute = 60_000;
  assert.equal(formatReset(now + 123 * minute, now), 'in 2h 3m');
  assert.equal(formatReset(now + 60 * minute, now), 'in 1h 0m');
  assert.equal(formatReset(now + 3 * minute, now), 'in 3m');
  assert.equal(formatReset(now + 1, now), 'in less than 1m');
  assert.equal(formatReset(now + 24 * 60 * minute - 1, now), 'in 23h 59m');
  assert.equal(formatReset(now + 24 * 60 * minute, now), formatTimestamp(now + 24 * 60 * minute));
  assert.equal(formatReset(now, now), formatTimestamp(now));
  assert.equal(formatReset(now - minute, now), formatTimestamp(now - minute));
  assert.equal(formatReset(null, now), 'not active');
});
