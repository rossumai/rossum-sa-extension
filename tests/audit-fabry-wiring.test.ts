// tests/audit-fabry-wiring.test.js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/agent/agentApi.js', () => ({ init: vi.fn(), probeAgent: vi.fn() }));
vi.mock('../src/audit/fabry.js', () => ({
  DEFAULT_QUESTION: 'DEFAULT_Q',
  runAuditQuery: vi.fn(),
  continueAuditQuery: vi.fn(),
  refreshAuditSummary: vi.fn(),
  buildRefreshPrompt: vi.fn(),
}));
vi.mock('../src/audit/api.js', () => ({
  init: vi.fn(),
  whoami: vi.fn(),
  get: vi.fn(),
  buildQuery: vi.fn(() => ''),
  normalizePage: vi.fn(() => ({
    total: null,
    totalPages: null,
    hasNext: false,
    hasPrev: false,
    nextCursor: null,
    prevCursor: null,
  })),
  extractParam: vi.fn(),
}));

import {
  runDefaultSummary,
  askAuditFabry,
  refreshSummary,
  viewSignature,
  initAudit,
} from '../src/audit/index.jsx';
import {
  runAuditQuery,
  continueAuditQuery,
  refreshAuditSummary,
  DEFAULT_QUESTION,
} from '../src/audit/fabry.js';
import * as agentApi from '../src/agent/agentApi.js';
import * as api from '../src/audit/api.js';
import * as store from '../src/audit/store.js';

beforeEach(() => {
  vi.clearAllMocks();
  store.resetFabry();
  store.aiAvailable.value = false;
});

// Condition-based polling helper (avoids flaky fixed-timeout sleeps racing
// the probe's .then microtask / runDefaultSummary's internal await).
async function waitFor(cond: any, desc = 'condition', timeoutMs = 2000) {
  const start = Date.now();
  for (;;) {
    let ok = false;
    try {
      ok = cond();
    } catch {
      ok = false;
    }
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
    vi.mocked(runAuditQuery).mockResolvedValue({
      text: 'Latest.',
      reasoning: 'r',
      tools: ['search'],
      chatId: 'c1',
    });
    await runDefaultSummary();
    expect(runAuditQuery).toHaveBeenCalledWith(
      expect.objectContaining({ question: 'DEFAULT_Q', mode: 'seeded' }),
    );
    expect(store.fabry.value.status).toBe('done');
    expect(store.fabry.value.chatId).toBe('c1');
    expect(store.fabry.value.turns[0]).toMatchObject({
      question: null,
      text: 'Latest.',
      state: 'done',
    });
    await runDefaultSummary(); // not idle anymore → no second run
    expect(runAuditQuery).toHaveBeenCalledTimes(1);
  });
  it('stores forView as the view signature captured at run time', async () => {
    store.aiAvailable.value = true;
    vi.mocked(runAuditQuery).mockResolvedValue({
      text: 'Latest.',
      reasoning: '',
      tools: [],
      chatId: 'c1',
    });
    const sig = viewSignature();
    await runDefaultSummary();
    expect(store.fabry.value.forView).toBe(sig);
  });
  it('records a turn error when the run rejects', async () => {
    store.aiAvailable.value = true;
    vi.mocked(runAuditQuery).mockRejectedValue(new Error('boom'));
    await runDefaultSummary();
    expect(store.fabry.value.status).toBe('error');
    expect(store.fabry.value.turns[0].state).toBe('error');
    expect(store.fabry.value.forView).toBeNull(); // a failed summary isn't "for" any view
  });
});

describe('askAuditFabry', () => {
  it('continues the existing chat and appends a Q&A turn', async () => {
    store.aiAvailable.value = true;
    store.fabry.value = {
      status: 'done',
      chatId: 'c1',
      error: null,
      forView: null,
      turns: [{ id: 1, question: null, text: 'Latest.', reasoning: '', tools: [], state: 'done' }],
    };
    vi.mocked(continueAuditQuery).mockResolvedValue({
      text: 'Because X.',
      reasoning: '',
      tools: [],
    });
    await askAuditFabry('why?');
    expect(continueAuditQuery).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'c1', question: 'why?' }),
    );
    expect(runAuditQuery).not.toHaveBeenCalled();
    const turns = store.fabry.value.turns;
    expect(turns.length).toBe(2);
    expect(turns[1]).toMatchObject({ question: 'why?', text: 'Because X.', state: 'done' });
  });
  it('starts a fresh chat when none exists yet', async () => {
    store.aiAvailable.value = true;
    vi.mocked(runAuditQuery).mockResolvedValue({
      text: 'A.',
      reasoning: '',
      tools: [],
      chatId: 'c2',
    });
    await askAuditFabry('first question');
    expect(runAuditQuery).toHaveBeenCalledWith(
      expect.objectContaining({ question: 'first question' }),
    );
    expect(store.fabry.value.chatId).toBe('c2');
    expect(store.fabry.value.turns[0]).toMatchObject({ question: 'first question', state: 'done' });
  });
  it('ignores a submit while a turn is streaming (one at a time)', async () => {
    store.fabry.value = {
      status: 'running',
      chatId: 'c1',
      error: null,
      forView: null,
      turns: [{ id: 1, question: null, text: '', reasoning: '', tools: [], state: 'streaming' }],
    };
    await askAuditFabry('while busy');
    expect(continueAuditQuery).not.toHaveBeenCalled();
    expect(runAuditQuery).not.toHaveBeenCalled();
  });
});

describe('refreshSummary', () => {
  it('no-ops when availability is not "available" — never seeds the old page while the refetch is in flight', async () => {
    store.aiAvailable.value = true;
    store.availability.value = 'unknown';
    store.fabry.value = {
      status: 'done',
      chatId: 'c1',
      error: null,
      forView: 'old-sig',
      turns: [{ id: 1, question: null, text: 'Old.', reasoning: '', tools: [], state: 'done' }],
    };
    await refreshSummary();
    expect(refreshAuditSummary).not.toHaveBeenCalled();
    expect(store.fabry.value.turns.length).toBe(1);
  });

  it('no-ops while a turn is already streaming (one at a time)', async () => {
    store.aiAvailable.value = true;
    store.availability.value = 'available';
    store.fabry.value = {
      status: 'running',
      chatId: 'c1',
      error: null,
      forView: 'old-sig',
      turns: [{ id: 1, question: null, text: '', reasoning: '', tools: [], state: 'streaming' }],
    };
    await refreshSummary();
    expect(refreshAuditSummary).not.toHaveBeenCalled();
  });

  it('appends a second summary turn via refreshAuditSummary on the SAME chat and refreshes forView', async () => {
    store.aiAvailable.value = true;
    store.availability.value = 'available';
    store.fabry.value = {
      status: 'done',
      chatId: 'c1',
      error: null,
      forView: 'old-sig',
      turns: [{ id: 1, question: null, text: 'Old.', reasoning: '', tools: [], state: 'done' }],
    };
    vi.mocked(refreshAuditSummary).mockResolvedValue({
      text: 'New summary.',
      reasoning: 'r2',
      tools: ['x'],
    });
    await refreshSummary();
    expect(refreshAuditSummary).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'c1' }));
    expect(runAuditQuery).not.toHaveBeenCalled();
    const turns = store.fabry.value.turns;
    expect(turns.length).toBe(2);
    expect(turns[0]).toMatchObject({ question: null, text: 'Old.', state: 'done' }); // original summary preserved
    expect(turns[1]).toMatchObject({ question: null, text: 'New summary.', state: 'done' });
    expect(store.fabry.value.status).toBe('done');
    expect(store.fabry.value.forView).toBe(viewSignature());
    expect(store.fabry.value.forView).not.toBe('old-sig');
  });

  it('falls back to a fresh chat (runAuditQuery path) when no chatId exists yet', async () => {
    store.aiAvailable.value = true;
    store.availability.value = 'available';
    store.fabry.value = {
      status: 'error',
      chatId: null,
      error: 'boom',
      forView: null,
      turns: [{ id: 1, question: null, text: '', reasoning: '', tools: [], state: 'error' }],
    };
    vi.mocked(runAuditQuery).mockResolvedValue({
      text: 'Fresh.',
      reasoning: '',
      tools: [],
      chatId: 'c2',
    });
    await refreshSummary();
    expect(refreshAuditSummary).not.toHaveBeenCalled();
    expect(runAuditQuery).toHaveBeenCalledTimes(1);
    expect(store.fabry.value.chatId).toBe('c2');
    expect(store.fabry.value.status).toBe('done');
  });
});

describe('filter changes alone never trigger an agent call', () => {
  beforeEach(() => {
    store.connected.value = null;
    store.error.value = null;
    store.availability.value = 'unknown';
    vi.mocked(api.get).mockResolvedValue({ results: [], pagination: null });
    vi.mocked(api.buildQuery).mockReturnValue('');
    globalThis.chrome = {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
        },
      } as any,
    } as any;
  });

  it('after the eager default summary has already landed, changing a filter does not itself call any Fabry function — auto-refresh lives only in the mounted panel, not the wiring', async () => {
    vi.mocked(api.whoami).mockResolvedValue({ id: 1 });
    vi.mocked(agentApi.probeAgent).mockResolvedValue(true);
    vi.mocked(runAuditQuery).mockResolvedValue({
      text: 'x',
      reasoning: '',
      tools: [],
      chatId: 'c1',
    });

    await initAudit();
    await waitFor(() => store.aiAvailable.value === true, 'aiAvailable set true after probe');

    // Simulate the first audit query landing so the eager default summary runs.
    store.availability.value = 'available';
    await waitFor(
      () => vi.mocked(runAuditQuery).mock.calls.length > 0,
      'eager default summary ran once rows landed',
    );
    expect(runAuditQuery).toHaveBeenCalledTimes(1);

    vi.clearAllMocks(); // clears call counts only; mockResolvedValue implementations survive

    store.patchFilters('audit', { username: 'x@y.z', page: 1, cursor: null });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 20));

    expect(runAuditQuery).not.toHaveBeenCalled();
    expect(refreshAuditSummary).not.toHaveBeenCalled();
    expect(continueAuditQuery).not.toHaveBeenCalled();
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
    vi.mocked(api.get).mockResolvedValue({ results: [], pagination: null });
    vi.mocked(api.buildQuery).mockReturnValue('');
    globalThis.chrome = {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
        },
      } as any,
    } as any;
  });

  it('connected: probes the agent, then eagerly auto-runs the default summary exactly once rows have loaded', async () => {
    vi.mocked(api.whoami).mockResolvedValue({ id: 1 });
    vi.mocked(agentApi.probeAgent).mockResolvedValue(true);
    vi.mocked(runAuditQuery).mockResolvedValue({
      text: 'x',
      reasoning: '',
      tools: [],
      chatId: 'c1',
    });

    await initAudit();

    expect(store.connected.value).toBe(true);
    await waitFor(() => store.aiAvailable.value === true, 'aiAvailable set true after probe');

    // Before the first audit query has landed, the summary must not have run yet.
    expect(runAuditQuery).not.toHaveBeenCalled();

    // Simulate the first audit query landing (fetchActive would set availability 'available').
    store.availability.value = 'available';
    await waitFor(
      () => vi.mocked(runAuditQuery).mock.calls.length > 0,
      'runAuditQuery called once rows landed',
    );

    expect(agentApi.probeAgent).toHaveBeenCalledTimes(1);
    expect(runAuditQuery).toHaveBeenCalledTimes(1);
    expect(runAuditQuery).toHaveBeenCalledWith(
      expect.objectContaining({ question: DEFAULT_QUESTION, mode: 'seeded' }),
    );
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
    vi.mocked(api.whoami).mockRejectedValue(new Error('nope'));

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
