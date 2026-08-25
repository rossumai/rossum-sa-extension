// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';
vi.mock('../src/inspector/api.js');
vi.mock('../src/inspector/orchestrate.js', () => ({
  orchestrateAttributions: vi.fn(async () => {}),
}));
vi.mock('../src/agent/agentApi.js', () => ({
  init: vi.fn(),
  probeAgent: vi.fn(() => Promise.resolve(false)),
  createChat: vi.fn(async () => 'c1'),
  streamMessage: vi.fn(async (_id, content, { onEvent } = {}) => {
    if (content === '/persona cautious') return;
    onEvent?.({ type: 'text-delta', delta: 'diagnosis text' });
    onEvent?.({ type: 'finish' });
  }),
}));
import * as api from '../src/inspector/api.js';
import * as store from '../src/inspector/store.js';
import * as agentApi from '../src/agent/agentApi.js';
import { orchestrateAttributions } from '../src/inspector/orchestrate.js';
import {
  initInspector,
  loadAnnotation,
  loadQueueRules,
  askFabry,
  closeAnnotation,
} from '../src/inspector/index.jsx';

function waitFor(fn: any, { timeout = 1000, step = 5 } = {}) {
  return new Promise<void>((res, rej) => {
    const t0 = Date.now();
    (function p() {
      let ok = false;
      try {
        ok = fn();
      } catch {
        /* ignore */
      }
      if (ok) return res();
      if (Date.now() - t0 > timeout) return rej(new Error('timeout'));
      setTimeout(p, step);
    })();
  });
}

beforeEach(() => {
  store.reset();
  vi.clearAllMocks();
});

describe('inspector orchestrator', () => {
  it('initInspector flips connected false on whoami failure', async () => {
    vi.mocked(api.whoami).mockRejectedValue(
      Object.assign(new Error('Session expired'), { status: 401 }),
    );
    await initInspector();
    expect(store.connected.value).toBe(false);
  });

  it('loadAnnotation populates data from core GETs (blocker followed from URL)', async () => {
    vi.mocked(api.getAnnotation).mockResolvedValue({
      id: 5,
      status: 'to_review',
      messages: [],
      automation_blocker: 'https://h/api/v1/automation_blockers/9',
      queue: 'https://h/api/v1/queues/3',
      schema: 'https://h/api/v1/schemas/7',
    });
    vi.mocked(api.getAutomationBlocker).mockResolvedValue({ content: [{ type: 'low_score' }] });
    vi.mocked(api.getContent).mockResolvedValue({ content: [] });
    vi.mocked(api.getQueue).mockResolvedValue({ id: 3, automation_level: 'never' });
    vi.mocked(api.getSchema).mockResolvedValue({ content: [] });
    store.setAnnotationId('5');
    await loadAnnotation('5');
    expect(store.data.value.annotation.id).toBe(5);
    expect(store.data.value.blocker.content[0].type).toBe('low_score');
    expect(api.getAutomationBlocker).toHaveBeenCalledWith('https://h/api/v1/automation_blockers/9');
    expect(store.loading.value).toBe(false);
  });

  it('a successful load prefetches queue rules and runs the attribution orchestrator', async () => {
    vi.mocked(api.getAnnotation).mockResolvedValue({
      id: 6,
      status: 'to_review',
      messages: [],
      queue: 'https://h/api/v1/queues/3',
    });
    vi.mocked(api.getContent).mockResolvedValue({ content: [] });
    vi.mocked(api.getQueue).mockResolvedValue({ id: 3 });
    vi.mocked(api.listRules).mockResolvedValue([{ id: 11, name: 'R', actions: [] }]);
    vi.mocked(api.listHooks).mockResolvedValue([]);
    vi.mocked(api.listLabels).mockResolvedValue([]);
    vi.mocked(api.listWorkflowActivities).mockResolvedValue([]);
    vi.mocked(api.listNotes).mockResolvedValue([]);
    vi.mocked(api.listHookLogs).mockResolvedValue([]);
    vi.mocked(api.listRuleExecutionLogs).mockResolvedValue([]);
    store.setAnnotationId('6');
    await loadAnnotation('6');
    await waitFor(() => vi.mocked(orchestrateAttributions).mock.calls.length > 0); // wiring fires (fire-and-forget)
    expect(store.data.value.resolved.rules).toEqual([{ id: 11, name: 'R', actions: [] }]); // loadQueueRules populated resolved.rules
    expect(store.data.value.resolved._rulesLoaded).toBe(true);
  });

  it('a stale queue-rules load does not contaminate a newer annotation (loadId guard)', async () => {
    store.data.value = { annotation: { id: 1, queue: 'https://h/api/v1/queues/3' }, resolved: {} };
    let resolveRules: any;
    vi.mocked(api.listRules).mockReturnValue(
      new Promise((r) => {
        resolveRules = r;
      }),
    ); // A's rules are slow
    const stale = loadQueueRules(); // captures the current loadId
    vi.mocked(api.getAnnotation).mockReturnValue(new Promise(() => {})); // never resolves — we only need the synchronous ++loadId
    loadAnnotation('2'); // navigate away → bumps loadId synchronously at entry
    resolveRules([{ id: 11, name: 'R', actions: [] }]); // A's rules resolve LATE
    await stale;
    expect(store.data.value.resolved.rules).toBeUndefined(); // stale rules NOT written onto the newer annotation
  });
});

function mockAllSources() {
  vi.mocked(api.getAnnotation).mockResolvedValue({
    id: 1,
    status: 'to_review',
    messages: [],
    queue: 'https://h/api/v1/queues/3',
  });
  vi.mocked(api.getContent).mockResolvedValue({ content: [] });
  vi.mocked(api.getQueue).mockResolvedValue({ id: 3 });
  vi.mocked(api.listRules).mockResolvedValue([]);
  vi.mocked(api.listHooks).mockResolvedValue([]);
  vi.mocked(api.listLabels).mockResolvedValue([]);
  vi.mocked(api.listWorkflowActivities).mockResolvedValue([]);
  vi.mocked(api.listNotes).mockResolvedValue([]);
  vi.mocked(api.listHookLogs).mockResolvedValue([]);
  vi.mocked(api.listRuleExecutionLogs).mockResolvedValue([]);
  vi.mocked(api.listWorkflowRuns).mockResolvedValue([]);
  vi.mocked(api.listWorkflowSteps).mockResolvedValue([]);
  vi.mocked(api.listPages).mockResolvedValue([]);
  vi.mocked(api.getBlob).mockResolvedValue({ size: 1 } as any);
}

// orchestrateAttributions is mocked (module-level) for the rest of the suite, so the
// staged lifecycle here only exercises the loaders + synthesis wiring around it.
describe('staged lifecycle', () => {
  it('walks gathering → attributing → synthesizing → complete and stores synthesis text', async () => {
    store.aiAvailable.value = true;
    mockAllSources();
    store.setAnnotationId('1');
    await loadAnnotation('1');
    await waitFor(() => store.investigation.value.stage === 'complete');
    expect(store.synthesis.value.status).toBe('done');
    expect(store.synthesis.value.text).toBe('diagnosis text');
    expect(store.evidence.value).toBeTruthy();
    expect(store.investigation.value.sourcesDone).toBe(store.investigation.value.sourcesTotal);
  });

  it('agent offline → stage ends agent-offline, synthesis marked offline', async () => {
    store.aiAvailable.value = false;
    mockAllSources();
    store.setAnnotationId('1');
    await loadAnnotation('1');
    await waitFor(() => store.investigation.value.stage === 'agent-offline');
    expect(store.synthesis.value.status).toBe('offline');
  });

  it('a load superseded mid-synthesis never writes a stale "done" (abort guard)', async () => {
    store.aiAvailable.value = true;
    mockAllSources();
    // Control the synthesis stream: persona returns; the diagnosis turn emits a partial
    // then HANGS until released, so we can supersede the load while it is mid-stream.
    const saved = vi.mocked(agentApi.streamMessage).getMockImplementation();
    let release: any;
    vi.mocked(agentApi.streamMessage).mockImplementation(async (_id, content, { onEvent } = {}) => {
      if (content === '/persona cautious') return;
      onEvent?.({ type: 'text-delta', delta: 'partial…' });
      await new Promise((r) => {
        release = r;
      });
      onEvent?.({ type: 'text-delta', delta: 'FINAL — must not appear' });
      onEvent?.({ type: 'finish' });
    });
    try {
      store.setAnnotationId('1');
      loadAnnotation('1'); // not awaited — synthesis runs in the background
      await waitFor(
        () =>
          store.synthesis.value?.status === 'streaming' &&
          store.synthesis.value.text === 'partial…',
      );
      // Supersede: navigating to another annotation aborts the in-flight synthesis.
      vi.mocked(api.getAnnotation).mockReturnValue(new Promise(() => {})); // '2' never resolves
      loadAnnotation('2');
      release(); // let the now-stale synthesis stream finish AFTER the abort
      await new Promise((r) => setTimeout(r, 20));
      expect(store.synthesis.value.status).not.toBe('done'); // stale 'done' never written
      expect(store.synthesis.value.text).toBe('partial…'); // late delta was dropped by the guard
    } finally {
      vi.mocked(agentApi.streamMessage).mockImplementation(saved!); // restore so sibling tests keep the default stream
    }
  });
});

describe('page previews', () => {
  it('loads page list + first-batch blobs into pagePreviews with object URLs', async () => {
    store.aiAvailable.value = false;
    mockAllSources();
    vi.mocked(api.listPages).mockResolvedValue([
      { number: 2, width: 800, height: 1100, content: 'https://x/pages/2/content' },
      { number: 1, width: 800, height: 1100, content: 'https://x/pages/1/content' },
    ]);
    const origCreate = URL.createObjectURL;
    URL.createObjectURL = () => 'blob:mock';
    try {
      store.setAnnotationId('1');
      await loadAnnotation('1');
      await waitFor(() => store.pagePreviews.value?.status === 'done');
      const pv = store.pagePreviews.value;
      expect(pv.total).toBe(2);
      expect(pv.pages.map((p: any) => p.number)).toEqual([1, 2]); // sorted by number
      expect(pv.pages[0].objectUrl).toBe('blob:mock');
      expect(pv.rest).toEqual([]);
    } finally {
      URL.createObjectURL = origCreate;
    }
  });

  it('page list failure → error state, report untouched', async () => {
    store.aiAvailable.value = false;
    mockAllSources();
    vi.mocked(api.listPages).mockRejectedValue(new Error('boom'));
    store.setAnnotationId('1');
    await loadAnnotation('1');
    await waitFor(() => store.pagePreviews.value?.status === 'error');
    expect(store.data.value).toBeTruthy();
    expect(store.error.value).toBe(null);
  });
});

describe('askFabry follow-ups', () => {
  it('appends a followup, streams the answer in the same chat, keeps activity honest', async () => {
    store.aiAvailable.value = true;
    mockAllSources();
    store.setAnnotationId('1');
    await loadAnnotation('1');
    await waitFor(() => store.synthesis.value?.status === 'done');
    expect(store.synthesis.value.chatId).toBe('c1');
    await askFabry('why blocked?');
    const f = store.synthesis.value.followups;
    expect(f.length).toBe(1);
    expect(f[0].q).toBe('why blocked?');
    expect(f[0].status).toBe('done');
    expect(f[0].text).toBe('diagnosis text');
    expect(store.investigation.value.activity).toBe('');
  });
  it('no-ops when synthesis is not done or has no chatId', async () => {
    store.synthesis.value = { status: 'offline', text: '', reasoning: '', tools: [], error: null };
    await askFabry('hello?');
    expect(store.synthesis.value.followups).toBeUndefined();
  });
});

describe('closeAnnotation (back to landing)', () => {
  it('clears the annotation and prevents in-flight loaders from writing', async () => {
    store.aiAvailable.value = false;
    mockAllSources();
    let resolveRules: any;
    vi.mocked(api.listRules).mockReturnValue(
      new Promise((r) => {
        resolveRules = r;
      }),
    ); // keep gather in flight
    store.setAnnotationId('1');
    const load = loadAnnotation('1');
    await waitFor(() => store.data.value != null);
    closeAnnotation();
    expect(store.annotationId.value).toBe(null);
    expect(store.data.value).toBe(null);
    resolveRules([{ id: 9, name: 'late', actions: [] }]); // stale gather resolves late
    await load;
    await new Promise((r) => setTimeout(r, 10));
    expect(store.data.value).toBe(null); // nothing contaminated the landing state
  });
});
