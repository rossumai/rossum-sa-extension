import { describe, it, expect, vi } from 'vitest';
import { runChecks } from '../src/fabry/architect/run.js';

const reqs = (n: any) =>
  Array.from({ length: n }, (_, i) => ({ id: 'r' + i, text: 'req ' + i, order: i }));

describe('runChecks', () => {
  it('runs every requirement and streams results via onResult', async () => {
    const seen = {};
    const out = await runChecks(reqs(3), {
      runOne: async (req) => ({ verdict: 'pass', evidence: 'ok ' + req.id, chatId: 'c_' + req.id }),
      onResult: (id, r) => {
        (seen as any)[id] = r.verdict;
      },
    });
    expect(out.map((r) => r.verdict)).toEqual(['pass', 'pass', 'pass']);
    expect(seen).toEqual({ r0: 'pass', r1: 'pass', r2: 'pass' });
  });

  it('turns a runOne throw into an uncertain result and keeps going', async () => {
    const out = await runChecks(reqs(3), {
      runOne: async (req) => {
        if (req.id === 'r1') throw new Error('boom');
        return { verdict: 'fail', evidence: 'x', chatId: 'c' };
      },
      onResult: () => {},
    });
    expect(out[0].verdict).toBe('fail');
    expect(out[1].verdict).toBe('uncertain');
    expect(out[1].error).toBe(true);
    expect(out[1].evidence).toMatch(/could not complete/i);
    expect(out[2].verdict).toBe('fail');
  });

  it('never exceeds the concurrency cap', async () => {
    let inFlight = 0,
      max = 0;
    await runChecks(reqs(8), {
      concurrency: 3,
      runOne: async () => {
        inFlight += 1;
        max = Math.max(max, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return { verdict: 'pass', evidence: '', chatId: 'c' };
      },
      onResult: () => {},
    });
    expect(max).toBeLessThanOrEqual(3);
    expect(max).toBeGreaterThan(1);
  });

  it('stops launching new checks once the signal aborts', async () => {
    const ctrl = new AbortController();
    const calls = [];
    const p = runChecks(reqs(6), {
      concurrency: 2,
      signal: ctrl.signal,
      runOne: async (req) => {
        calls.push(req.id);
        if (req.id === 'r1') ctrl.abort();
        await new Promise((r) => setTimeout(r, 1));
        return { verdict: 'pass', evidence: '', chatId: 'c' };
      },
      onResult: () => {},
    });
    await p;
    expect(calls.length).toBeLessThan(6);
  });
});
