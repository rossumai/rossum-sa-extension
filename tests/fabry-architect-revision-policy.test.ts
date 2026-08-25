import { describe, it, expect } from 'vitest';
import { shouldSnapshot, openSession, touchSession, prunePlan, IDLE_MS, CAP } from '../src/fabry/architect/revisionPolicy.js';

describe('shouldSnapshot', () => {
  const base = { deliverableId: 'd1', source: 'edit', now: 1_000_000 };

  it('snapshots when no session is open', () => {
    expect(shouldSnapshot({ ...base, session: null })).toBe(true);
  });

  it('does NOT snapshot again inside the same session — the autosave case', () => {
    const session = openSession({ deliverableId: 'd1', source: 'edit', now: 1_000_000 });
    // 600ms later, and 600ms after that: the whole point is that these write nothing
    expect(shouldSnapshot({ ...base, session, now: 1_000_600 })).toBe(false);
    expect(shouldSnapshot({ ...base, session: touchSession(session, 1_000_600), now: 1_001_200 })).toBe(false);
  });

  it('snapshots after an idle gap longer than IDLE_MS', () => {
    const session = openSession({ deliverableId: 'd1', source: 'edit', now: 0 });
    expect(shouldSnapshot({ ...base, session, now: IDLE_MS })).toBe(false);        // exactly at the edge
    expect(shouldSnapshot({ ...base, session, now: IDLE_MS + 1 })).toBe(true);
  });

  it('snapshots when the deliverable changes', () => {
    const session = openSession({ deliverableId: 'd1', source: 'edit', now: 1_000_000 });
    expect(shouldSnapshot({ ...base, deliverableId: 'd2', session, now: 1_000_100 })).toBe(true);
  });

  it('snapshots when the source changes — a human edit after an accepted Refine is its own act', () => {
    const session = openSession({ deliverableId: 'd1', source: 'refine', now: 1_000_000 });
    expect(shouldSnapshot({ ...base, session, now: 1_000_100 })).toBe(true);
  });

  it('defaults source to edit and tolerates no arguments', () => {
    expect(shouldSnapshot()).toBe(true);
  });
});

describe('prunePlan', () => {
  const revs = (n: any, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `r${from + i}`, at: 1000 + from + i }));

  it('keeps everything up to the cap', () => {
    expect(prunePlan(revs(CAP))).toEqual([]);
    expect(prunePlan(revs(3), 5)).toEqual([]);
  });

  it('drops the oldest but ALWAYS keeps the earliest revision', () => {
    // 5 revisions (r0 oldest .. r4 newest), cap 3 -> keep r0 (earliest) + r4, r3 (newest two)
    const plan = prunePlan(revs(5), 3);
    expect(plan.sort()).toEqual(['r1', 'r2']);
  });

  it('is deterministic when timestamps tie', () => {
    const tied = [{ id: 'b', at: 5 }, { id: 'a', at: 5 }, { id: 'c', at: 5 }, { id: 'd', at: 5 }];
    expect(prunePlan(tied, 2)).toEqual(prunePlan([...tied].reverse(), 2));
  });

  it('ignores junk entries and degenerate caps', () => {
    expect(prunePlan(null)).toEqual([]);
    expect(prunePlan([{ at: 1 }, null], 1)).toEqual([]);
    expect(prunePlan(revs(3), 0)).toEqual([]);
  });

  it('keeps the cap meaningful: exactly `cap` survive', () => {
    const kept = revs(60).length - prunePlan(revs(60), CAP).length;
    expect(kept).toBe(CAP);
  });
});
