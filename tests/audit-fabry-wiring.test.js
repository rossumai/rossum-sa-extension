// tests/audit-fabry-wiring.test.js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/mdh/agent/agentApi.js', () => ({ init: vi.fn(), probeAgent: vi.fn() }));
vi.mock('../src/audit/fabry.js', () => ({
  DEFAULT_QUESTION: 'DEFAULT_Q',
  runAuditQuery: vi.fn(),
  continueAuditQuery: vi.fn(),
}));
vi.mock('../src/audit/api.js', () => ({
  init: vi.fn(),
  whoami: vi.fn(),
  get: vi.fn(),
  buildQuery: vi.fn(() => ''),
  normalizePage: vi.fn(() => ({ total: null, totalPages: null, hasNext: false, hasPrev: false, nextCursor: null, prevCursor: null })),
  extractParam: vi.fn(),
}));

import { runDefaultSummary, askAuditFabry, initAudit } from '../src/audit/index.jsx';
import { runAuditQuery, continueAuditQuery, DEFAULT_QUESTION } from '../src/audit/fabry.js';
import * as agentApi from '../src/mdh/agent/agentApi.js';
import * as api from '../src/audit/api.js';
import * as store from '../src/audit/store.js';

beforeEach(() => {
  vi.clearAllMocks();
  store.resetFabry();
  store.aiAvailable.value = false;
});

// Condition-based polling helper (avoids flaky fixed-timeout sleeps racing
// the probe's .then microtask / runDefaultSummary's internal await).
async function waitFor(cond, desc = 'condition', timeoutMs = 2000) {
  const start = Date.now();
  for (;;) {
    let ok = false;
    try { ok = cond(); } catch { ok = false; }
    if (ok) return;
    if (Date.now() - start > timeoutMs) throw new Error(`Timeout: ${desc}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('runDefaultSummary', () => {
  it('no-op when the agent is unavailable', async () => {
    await runDefaultSummary();
    expect(runAuditQuery).not.toHaveBeenCalled();
    expect(store.fabry.value.status).toBe('idle');
  });
  it('runs once, streams the default summary, records chatId', async () => {
    store.aiAvailable.value = true;
    runAuditQuery.mockResolvedValue({ text: 'Latest.', reasoning: 'r', tools: ['search'], chatId: 'c1' });
    await runDefaultSummary();
    expect(runAuditQuery).toHaveBeenCalledWith(expect.objectContaining({ question: 'DEFAULT_Q', mode: 'seeded' }));
    expect(store.fabry.value.status).toBe('done');
    expect(store.fabry.value.chatId).toBe('c1');
    expect(store.fabry.value.turns[0]).toMatchObject({ question: null, text: 'Latest.', state: 'done' });
    await runDefaultSummary(); // not idle anymore → no second run
    expect(runAuditQuery).toHaveBeenCalledTimes(1);
  });
  it('records a turn error when the run rejects', async () => {
    store.aiAvailable.value = true;
    runAuditQuery.mockRejectedValue(new Error('boom'));
    await runDefaultSummary();
    expect(store.fabry.value.status).toBe('error');
    expect(store.fabry.value.turns[0].state).toBe('error');
  });
});

describe('askAuditFabry', () => {
  it('continues the existing chat and appends a Q&A turn', async () => {
    store.aiAvailable.value = true;
    store.fabry.value = { status: 'done', chatId: 'c1', error: null, turns: [{ id: 1, question: null, text: 'Latest.', reasoning: '', tools: [], state: 'done' }] };
    continueAuditQuery.mockResolvedValue({ text: 'Because X.', reasoning: '', tools: [] });
    await askAuditFabry('why?');
    expect(continueAuditQuery).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'c1', question: 'why?' }));
    expect(runAuditQuery).not.toHaveBeenCalled();
    const turns = store.fabry.value.turns;
    expect(turns.length).toBe(2);
    expect(turns[1]).toMatchObject({ question: 'why?', text: 'Because X.', state: 'done' });
  });
  it('starts a fresh chat when none exists yet', async () => {
    store.aiAvailable.value = true;
    runAuditQuery.mockResolvedValue({ text: 'A.', reasoning: '', tools: [], chatId: 'c2' });
    await askAuditFabry('first question');
    expect(runAuditQuery).toHaveBeenCalledWith(expect.objectContaining({ question: 'first question' }));
    expect(store.fabry.value.chatId).toBe('c2');
    expect(store.fabry.value.turns[0]).toMatchObject({ question: 'first question', state: 'done' });
  });
  it('ignores a submit while a turn is streaming (one at a time)', async () => {
    store.fabry.value = { status: 'running', chatId: 'c1', error: null, turns: [{ id: 1, question: null, text: '', reasoning: '', tools: [], state: 'streaming' }] };
    await askAuditFabry('while busy');
    expect(continueAuditQuery).not.toHaveBeenCalled();
    expect(runAuditQuery).not.toHaveBeenCalled();
  });
});

describe('initAudit probe wiring', () => {
  beforeEach(() => {
    store.connected.value = null;
    store.error.value = null;
    store.availability.value = 'unknown';
    // fetchActive (wired via an effect() inside initAudit) only actually
    // queries when console activeApp === 'audit'; either way, give api.get
    // a safe default so a same-tick fetchActive call can't throw/reject.
    api.get.mockResolvedValue({ results: [], pagination: null });
    api.buildQuery.mockReturnValue('');
    globalThis.chrome = {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
        },
      },
    };
  });

  it('connected: probes the agent, then eagerly auto-runs the default summary exactly once rows have loaded', async () => {
    api.whoami.mockResolvedValue({ id: 1 });
    agentApi.probeAgent.mockResolvedValue(true);
    runAuditQuery.mockResolvedValue({ text: 'x', reasoning: '', tools: [], chatId: 'c1' });

    await initAudit();

    expect(store.connected.value).toBe(true);
    await waitFor(() => store.aiAvailable.value === true, 'aiAvailable set true after probe');

    // Before the first audit query has landed, the summary must not have run yet.
    expect(runAuditQuery).not.toHaveBeenCalled();

    // Simulate the first audit query landing (fetchActive would set availability 'available').
    store.availability.value = 'available';
    await waitFor(() => runAuditQuery.mock.calls.length > 0, 'runAuditQuery called once rows landed');

    expect(agentApi.probeAgent).toHaveBeenCalledTimes(1);
    expect(runAuditQuery).toHaveBeenCalledTimes(1);
    expect(runAuditQuery).toHaveBeenCalledWith(expect.objectContaining({ question: DEFAULT_QUESTION, mode: 'seeded' }));
    expect(store.aiAvailable.value).toBe(true);
    // initAudit must not re-init the shared agent transport — that happens
    // once at Console boot, not per-app.
    expect(agentApi.init).not.toHaveBeenCalled();

    // A later availability flicker (e.g. filter change re-querying) must not
    // re-trigger the summary — fabryKicked latches after the first run.
    store.availability.value = 'unknown';
    await Promise.resolve();
    store.availability.value = 'available';
    await new Promise((r) => setTimeout(r, 20));
    expect(runAuditQuery).toHaveBeenCalledTimes(1);
  });

  it('not connected: never probes the agent and never runs the default summary', async () => {
    api.whoami.mockRejectedValue(new Error('nope'));

    await initAudit();

    expect(store.connected.value).toBe(false);
    // Give any (wrongly-fired) probe a couple of microtask turns to show up.
    await Promise.resolve();
    await Promise.resolve();
    expect(agentApi.probeAgent).not.toHaveBeenCalled();
    expect(runAuditQuery).not.toHaveBeenCalled();
    expect(store.aiAvailable.value).toBe(false);
  });
});
