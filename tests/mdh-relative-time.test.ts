import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatTime, parseUtcTimestamp } from '../src/mdh/relativeTime.js';

const NOW = Date.UTC(2026, 7, 28, 12, 0, 0);

afterEach(() => {
  vi.useRealTimers();
});

function at(now: number) {
  vi.useFakeTimers();
  vi.setSystemTime(now);
}

describe('formatTime', () => {
  it('says "just now" under a minute', () => {
    at(NOW);
    expect(formatTime(NOW - 30_000)).toBe('just now');
  });

  it('counts whole minutes under an hour', () => {
    at(NOW);
    expect(formatTime(NOW - 5 * 60_000)).toBe('5m ago');
  });

  it('counts whole hours under a day', () => {
    at(NOW);
    expect(formatTime(NOW - 3 * 3_600_000)).toBe('3h ago');
  });

  it('falls back to a locale date beyond a day', () => {
    at(NOW);
    const ts = NOW - 3 * 86_400_000;
    expect(formatTime(ts)).toBe(new Date(ts).toLocaleDateString());
  });
});

describe('parseUtcTimestamp', () => {
  it('treats an offset-less MDH timestamp as UTC, not local', () => {
    // V2 returns created_at with no timezone marker; verified live that the value
    // is UTC. Date.parse would read it as local time and be hours out.
    expect(parseUtcTimestamp('2026-08-28T11:16:21.756000')).toBe(
      Date.parse('2026-08-28T11:16:21.756Z'),
    );
  });

  it('respects an explicit Z or numeric offset', () => {
    expect(parseUtcTimestamp('2026-08-28T11:16:21.756Z')).toBe(
      Date.parse('2026-08-28T11:16:21.756Z'),
    );
    expect(parseUtcTimestamp('2026-08-28T13:16:21.756+02:00')).toBe(
      Date.parse('2026-08-28T11:16:21.756Z'),
    );
  });

  it('returns null for anything unparseable', () => {
    expect(parseUtcTimestamp(null)).toBeNull();
    expect(parseUtcTimestamp('')).toBeNull();
    expect(parseUtcTimestamp('not a date')).toBeNull();
    expect(parseUtcTimestamp(12345)).toBeNull();
  });
});
