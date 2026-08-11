// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';
import { mintReceipt } from '../src/academy/mint.js';
import TrainerPanel from '../src/academy/components/TrainerPanel.jsx';
import * as store from '../src/academy/store.js';
import { TRACK } from '../src/training/track.js';
import { emptyProgress, markStep } from '../src/training/progress.js';
import { verifyReceipt } from '../src/training/receipt.js';
import { hmacSha256 } from '../src/training/hmac.js';
import { RECEIPT_KEY } from '../src/training/receiptKey.js';

async function waitFor(cond, timeout = 2000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const sign = (msg) => hmacSha256(RECEIPT_KEY, msg);

function completeProgress() {
  let p = emptyProgress(TRACK, 1);
  for (const m of TRACK.missions) {
    p = { ...p, missions: { ...p.missions, [m.id]: { startedAt: 1, baseline: {}, steps: {} } } };
    for (const s of m.steps) p = markStep(p, m.id, s.id, s.kind === 'self' ? 'self' : 'passed', 2);
  }
  return p;
}

let state;
beforeEach(() => {
  state = {};
  render(null, document.body);
  document.body.innerHTML = '';
  globalThis.chrome = { storage: {
    local: {
      get: vi.fn(async (keys) => {
        const out = {};
        for (const k of (Array.isArray(keys) ? keys : [keys])) if (k in state) out[k] = state[k];
        return out;
      }),
      set: vi.fn(async (obj) => Object.assign(state, obj)),
    },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  } };
  store.setOrigin('https://partner-sandbox.rossum.app');
  store.progress.value = completeProgress();
});

const whoami = async () => ({ id: 42, username: 'j.doe', url: '/api/v1/users/42' });

// A response set that beats the "nothing" baselines below on every check.
// `result` (singular) is the live Data Storage key — see the note in the
// re-verification test.
const passingGet = () => vi.fn(async (path) => {
  if (path.includes('hooks')) return { results: [{ url: '/api/v1/hooks/7', queues: ['/api/v1/queues/1'] }] };
  if (path.includes('rules')) return { results: [{ id: 5 }] };
  if (path.includes('queues')) return { results: [{ url: '/api/v1/queues/4', default_score_threshold: 0.9 }] };
  if (path.includes('collections')) return { result: ['a', 'b'] };
  return { results: [{ content: [{ children: [{ id: 'x' }, { id: 'y' }] }] }] }; // schemas
});

function givePassingBaselines() {
  for (const m of TRACK.missions) {
    store.progress.value.missions[m.id].baseline = {
      hookAttachedToQueue: [], ruleCreated: [], thresholdChanged: { 4: 0.5 },
      collectionAdded: 0, schemaFieldAdded: 0,
    };
  }
}

describe('mintReceipt', () => {
  it('re-verifies every api check before issuing', async () => {
    const get = vi.fn(async () => ({ results: [] }));
    await mintReceipt({ get, whoami, now: () => new Date('2026-08-07T10:00:00Z') });
    expect(get).toHaveBeenCalled(); // the checks really were re-run
  });

  it('refuses to issue when a check no longer passes, and names the step', async () => {
    const get = vi.fn(async () => ({ results: [] })); // nothing changed vs an empty baseline
    const res = await mintReceipt({ get, whoami, now: () => new Date('2026-08-07T10:00:00Z') });
    expect(res.ok).toBe(false);
    expect(res.failedStep).toMatch(/^m\d\.s\d$/);
  });

  it('issues a receipt that verifies with the real key when every check passes', async () => {
    // A baseline of "nothing" plus a response containing something = a delta.
    const get = vi.fn(async (path) => {
      if (path.includes('hooks')) return { results: [{ url: '/api/v1/hooks/7', queues: ['/api/v1/queues/1'] }] };
      if (path.includes('rules')) return { results: [{ id: 5 }] };
      if (path.includes('queues')) return { results: [{ url: '/api/v1/queues/4', default_score_threshold: 0.9 }] };
      // `result` — SINGULAR — is the live Data Storage contract. This mock used
      // the `collections` FALLBACK key, so it would have passed just as happily
      // with the primary key wrong, which is exactly the defect the comments in
      // baseline.js warn about.
      if (path.includes('data-storage')) return { result: ['a', 'b'] };
      return { results: [{ content: [{ children: [{ id: 'x' }, { id: 'y' }] }] }] }; // schemas
    });
    const p = store.progress.value;
    // Give every mission a baseline that the responses above beat.
    for (const m of TRACK.missions) {
      p.missions[m.id].baseline = {
        hookAttachedToQueue: [], ruleCreated: [], thresholdChanged: { 4: 0.5 },
        collectionAdded: 0, schemaFieldAdded: 0,
      };
    }
    const res = await mintReceipt({ get, whoami, now: () => new Date('2026-08-07T10:00:00Z') });
    expect(res.ok).toBe(true);
    expect((await verifyReceipt(res.text, sign)).valid).toBe(true);
  });

  it('records the org host and the self-attested count on the receipt', async () => {
    const get = vi.fn(async (path) => {
      if (path.includes('hooks')) return { results: [{ url: '/api/v1/hooks/7', queues: ['/api/v1/queues/1'] }] };
      if (path.includes('rules')) return { results: [{ id: 5 }] };
      if (path.includes('queues')) return { results: [{ url: '/api/v1/queues/4', default_score_threshold: 0.9 }] };
      if (path.includes('collections')) return { result: ['a', 'b'] };
      return { results: [{ content: [{ children: [{ id: 'x' }, { id: 'y' }] }] }] }; // schemas
    });
    const p = store.progress.value;
    for (const m of TRACK.missions) {
      p.missions[m.id].baseline = {
        hookAttachedToQueue: [], ruleCreated: [], thresholdChanged: { 4: 0.5 },
        collectionAdded: 0, schemaFieldAdded: 0,
      };
    }
    const res = await mintReceipt({ get, whoami, now: () => new Date('2026-08-07T10:00:00Z') });
    expect(res.ok).toBe(true);                        // no `if` — the mint must succeed
    expect(res.text).toContain('partner-sandbox.rossum.app');
    expect(res.text).toContain('self-attested');
  });

  // I1. A 401 is the ordinary case — tokens expire — and this is the final
  // action of the whole track. Rejecting out of the handler leaves the button
  // disabled on "Checking…" forever.
  it('returns a failure result instead of rejecting when whoami throws', async () => {
    const get = passingGet();
    givePassingBaselines();
    const res = await mintReceipt({
      get, whoami: async () => { throw new Error('API 401'); },
      now: () => new Date('2026-08-07T10:00:00Z'),
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('error');
    expect(res.message).toContain('401');
  });

  it('returns a failure result instead of rejecting when a progress write throws', async () => {
    const get = passingGet();
    givePassingBaselines();
    globalThis.chrome.storage.local.set = vi.fn(async () => { throw new Error('QuotaExceededError'); });
    const res = await mintReceipt({ get, whoami, now: () => new Date('2026-08-07T10:00:00Z') });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('error');
  });

  it('distinguishes an unreachable org from work that no longer holds', async () => {
    givePassingBaselines();
    const res = await mintReceipt({
      get: async () => { throw new Error('NetworkError'); }, whoami,
      now: () => new Date('2026-08-07T10:00:00Z'),
    });
    expect(res.reason).toBe('unreachable');
    // Nothing may be revoked on a network blip — the work is fine.
    expect(store.progress.value.missions.m2.steps['m2.s2'].state).toBe('passed');
  });

  // I7. Both of these render a receipt that parseReceipt cannot read back, so
  // mint would report ok:true, the trainee would send it, and the trainer's
  // checker would say "Not valid" on a receipt we issued ourselves.
  it('refuses to issue when the user id cannot be resolved', async () => {
    const get = passingGet();
    givePassingBaselines();
    const res = await mintReceipt({
      get, whoami: async () => ({ username: 'j.doe', url: '/api/v1/users/not-a-number' }),
      now: () => new Date('2026-08-07T10:00:00Z'),
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('identity');
  });

  // canonicalString pipe-joins its fields and does not escape them, so a
  // username containing `|` makes the signed string ambiguous — a crafted
  // username and a crafted missions list can produce the same canonical string.
  // Not producible from a Rossum username, but one clause is cheaper than an
  // escaping scheme.
  it('refuses a username containing the canonical-string delimiter', async () => {
    const get = passingGet();
    givePassingBaselines();
    for (const username of ['a|b', 'a\nb']) {
      const res = await mintReceipt({
        get, whoami: async () => ({ id: 42, username, url: '/api/v1/users/42' }),
        now: () => new Date('2026-08-07T10:00:00Z'),
      });
      expect(res.ok, `username ${JSON.stringify(username)} must not mint`).toBe(false);
      expect(res.reason).toBe('identity');
    }
  });

  it('refuses to issue when the username is empty', async () => {
    const get = passingGet();
    givePassingBaselines();
    const res = await mintReceipt({
      get, whoami: async () => ({ id: 42, username: '   ', url: '/api/v1/users/42' }),
      now: () => new Date('2026-08-07T10:00:00Z'),
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('identity');
  });

  it('every receipt it does issue parses back and verifies', async () => {
    const get = passingGet();
    givePassingBaselines();
    const res = await mintReceipt({
      get, whoami: async () => ({ id: 42, username: 'j.doe ', url: '/api/v1/users/42' }),
      now: () => new Date('2026-08-07T10:00:00Z'),
    });
    expect(res.ok).toBe(true);
    expect((await verifyReceipt(res.text, sign)).valid).toBe(true);
  });
});

describe('TrainerPanel', () => {
  it('accepts a genuine receipt', async () => {
    const { renderReceipt, mintCode } = await import('../src/training/receipt.js');
    const fields = {
      trackId: TRACK.id, trackVersion: TRACK.version, host: 'partner-sandbox.rossum.app',
      userId: 42, username: 'j.doe', missionsPassed: TRACK.missions.map((m) => m.id),
      selfCount: 6, dateUtc: '2026-08-07',
    };
    const text = renderReceipt(fields, await mintCode(fields, sign));
    render(h(TrainerPanel, {}), document.body);
    const ta = document.querySelector('textarea');
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('button').click();
    await waitFor(() => /valid/i.test(document.body.textContent));
    expect(document.body.textContent).toContain('partner-sandbox.rossum.app');
  });

  it('rejects a tampered receipt', async () => {
    const { renderReceipt, mintCode } = await import('../src/training/receipt.js');
    const fields = {
      trackId: TRACK.id, trackVersion: TRACK.version, host: 'a.rossum.app',
      userId: 1, username: 'a', missionsPassed: ['m1'], selfCount: 0, dateUtc: '2026-08-07',
    };
    const text = renderReceipt(fields, await mintCode(fields, sign)).replace('a.rossum.app', 'b.rossum.app');
    render(h(TrainerPanel, {}), document.body);
    const ta = document.querySelector('textarea');
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('button').click();
    await waitFor(() => /not valid/i.test(document.body.textContent));
  });
});
