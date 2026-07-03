import { describe, it, expect, vi } from 'vitest';
import { messageKey, blockerKey, fieldKey, computeFindings, orchestrateAttributions } from '../src/inspector/orchestrate.js';

function storeWith(data, enrichment = {}) {
  return { data: { value: data }, enrichment: { value: { hookLogs: [], ruleLogs: [], notes: [], workflow: [], ...enrichment } }, aiAvailable: { value: true }, attributions: { value: {} }, annotationId: { value: String(data?.annotation?.id) }, setAttribution() {} };
}

// A store whose setAttribution actually mutates, for the orchestrator tests.
function orchStore(data, enrichment = {}, aiAvailable = true) {
  const s = {
    data: { value: data },
    enrichment: { value: { hookLogs: [], ruleLogs: [], notes: [], workflow: [], ...enrichment } },
    aiAvailable: { value: aiAvailable },
    attributions: { value: {} },
    annotationId: { value: String(data?.annotation?.id) },
    setAttribution(k, v) { s.attributions.value = { ...s.attributions.value, [k]: v }; },
  };
  return s;
}

function waitFor(fn, { timeout = 1000, step = 5 } = {}) {
  return new Promise((res, rej) => { const t0 = Date.now(); (function p() { let ok = false; try { ok = fn(); } catch { /* ignore */ } if (ok) return res(); if (Date.now() - t0 > timeout) return rej(new Error('timeout')); setTimeout(p, step); })(); });
}

function fakeAgent(reply = '{"culprit":{"kind":"hook","id":9,"name":"AI"},"confidence":"medium","explanation":"e"}') {
  const calls = { createChat: 0, prompts: [] };
  return {
    calls,
    createChat: vi.fn(async () => { calls.createChat++; return 'c1'; }),
    streamMessage: vi.fn(async (_id, content, { onEvent }) => {
      calls.prompts.push(content);
      if (content === '/persona cautious') return;
      onEvent({ type: 'text-delta', delta: reply });
      onEvent({ type: 'finish' });
    }),
  };
}
const fakeApi = { listHooks: async () => [], getHook: async () => null };
const msgAnn = (messages, resolved = {}) => ({ annotation: { id: 1, status: 'to_review', messages, labels: [] }, blocker: { content: [] }, content: { content: [] }, resolved: { queue: null, hooksById: {}, labelsById: undefined, ...resolved } });

describe('key helpers', () => {
  it('are stable strings', () => {
    expect(messageKey(2)).toBe('message:2');
    expect(blockerKey(0)).toBe('blocker:0');
    expect(fieldKey('iban')).toBe('field:iban');
  });
});

describe('computeFindings', () => {
  it('finds an unattributed message but not a self-attributed one', () => {
    const store = storeWith({
      annotation: { id: 1, status: 'to_review', messages: [
        { type: 'error', content: 'A', detail: { hook_id: 5 } },   // self-attributed → skip
        { type: 'error', content: 'B', detail: { request_id: 'r1' } }, // unattributed → finding
      ], labels: [] },
      blocker: { content: [] }, content: { content: [] }, resolved: { queue: null, hooksById: {}, labelsById: undefined },
    });
    const f = computeFindings(store);
    const msgs = f.filter((x) => x.kind === 'message');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].key).toBe(messageKey(1));
  });
  it('finds a non-standard blocker but not low_score/automation_disabled/error_message', () => {
    const store = storeWith({ annotation: { id: 1, status: 'to_review', messages: [], labels: [] }, blocker: { content: [
      { type: 'low_score', samples: [{ details: { score: 0.1, threshold: 0.9 } }] },
      { type: 'weird_custom_blocker' },
    ] }, content: { content: [] }, resolved: { queue: null, hooksById: {}, labelsById: undefined } });
    const b = computeFindings(store).filter((x) => x.kind === 'blocker');
    expect(b).toHaveLength(1);
    expect(b[0].payload.type).toBe('weird_custom_blocker');
  });
});

describe('orchestrateAttributions', () => {
  it('resolves a message programmatically (request_id → hook log) with NO agent call', async () => {
    const store = orchStore(msgAnn([{ type: 'error', content: 'B', detail: { request_id: 'r1' } }], { hooksById: { 5: { id: 5, name: 'Rejector' } } }), { hookLogs: [{ hook_id: 5, request_id: 'r1' }] });
    const agentApi = fakeAgent();
    await orchestrateAttributions({ store, api: fakeApi, agentApi });
    const a = store.attributions.value[messageKey(0)];
    expect(a.source).toBe('programmatic');
    expect(a.verdict.culprit).toEqual({ kind: 'hook', id: 5, name: 'Rejector' });
    expect(agentApi.calls.createChat).toBe(0); // programmatic → no AI
  });

  it('falls back to AI (kind message) when there is no programmatic signal', async () => {
    const store = orchStore(msgAnn([{ type: 'error', content: 'Mystery', detail: {} }]));
    const agentApi = fakeAgent();
    await orchestrateAttributions({ store, api: fakeApi, agentApi });
    await waitFor(() => store.attributions.value[messageKey(0)]?.status === 'done');
    const a = store.attributions.value[messageKey(0)];
    expect(a.source).toBe('ai');
    expect(a.verdict.culprit).toEqual({ kind: 'hook', id: 9, name: 'AI' });
    expect(agentApi.calls.prompts.some((p) => /which extension produced this .*message/i.test(p))).toBe(true);
  });

  it('skips a finding whose key is already attributed (once-per-key guard)', async () => {
    const store = orchStore(msgAnn([{ type: 'error', content: 'M', detail: {} }]));
    store.setAttribution(messageKey(0), { status: 'done', verdict: { culprit: null }, source: 'ai' });
    const agentApi = fakeAgent();
    await orchestrateAttributions({ store, api: fakeApi, agentApi });
    expect(agentApi.calls.createChat).toBe(0);
  });

  it('launches NO AI when the agent is unavailable (no fallback)', async () => {
    const store = orchStore(msgAnn([{ type: 'error', content: 'M', detail: {} }]), {}, false);
    const agentApi = fakeAgent();
    await orchestrateAttributions({ store, api: fakeApi, agentApi });
    expect(agentApi.calls.createChat).toBe(0);
    expect(store.attributions.value[messageKey(0)]).toBeUndefined(); // residual left unattributed
  });

  it('does not write a stale result after the signal aborts mid-flight', async () => {
    const store = orchStore(msgAnn([{ type: 'error', content: 'M', detail: {} }]));
    const ctrl = new AbortController();
    let resolveStream;
    const agentApi = {
      createChat: async () => 'c1',
      streamMessage: async (_id, content) => { if (content === '/persona cautious') return; return new Promise((r) => { resolveStream = r; }); },
    };
    await orchestrateAttributions({ store, api: fakeApi, agentApi, signal: ctrl.signal });
    await waitFor(() => store.attributions.value[messageKey(0)]?.status === 'loading');
    ctrl.abort();
    if (resolveStream) resolveStream();
    await new Promise((r) => setTimeout(r, 20));
    expect(store.attributions.value[messageKey(0)].status).toBe('loading'); // no stale 'done' after abort
  });

  it('does nothing when handed an already-aborted signal (no dangling loading)', async () => {
    const store = orchStore(msgAnn([{ type: 'error', content: 'M', detail: {} }]));
    const ctrl = new AbortController();
    ctrl.abort();
    const agentApi = fakeAgent();
    await orchestrateAttributions({ store, api: fakeApi, agentApi, signal: ctrl.signal });
    expect(agentApi.calls.createChat).toBe(0);
    expect(store.attributions.value).toEqual({});
  });

  it('batches all residual ambiguous fields into ONE agent call', async () => {
    const dp = (schema_id) => ({ category: 'datapoint', schema_id, content: { value: 'v' }, validation_sources: ['connector'] });
    const data = { annotation: { id: 1, status: 'to_review', messages: [], labels: [] }, blocker: { content: [] }, content: { content: [dp('a'), dp('b')] }, resolved: { queue: null, hooksById: {}, labelsById: undefined } };
    const store = orchStore(data);
    const agentApi = fakeAgent('{"fields":[{"schema_id":"a","culprit":{"kind":"connector","id":1,"name":"C"},"confidence":"low","explanation":"e"},{"schema_id":"b","culprit":null,"confidence":"low","explanation":"e2"}]}');
    await orchestrateAttributions({ store, api: fakeApi, agentApi });
    await waitFor(() => store.attributions.value[fieldKey('a')]?.status === 'done' && store.attributions.value[fieldKey('b')]?.status === 'done');
    expect(agentApi.calls.createChat).toBe(1); // one batched call for both fields
    expect(store.attributions.value[fieldKey('a')].verdict.culprit).toEqual({ kind: 'connector', id: 1, name: 'C' });
    expect(store.attributions.value[fieldKey('b')].verdict.culprit).toBeNull();
  });
});
