// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';
vi.mock('../src/inspector/api.js');
vi.mock('../src/inspector/orchestrate.js', () => ({ orchestrateAttributions: vi.fn(async () => {}) }));
import * as api from '../src/inspector/api.js';
import * as store from '../src/inspector/store.js';
import { orchestrateAttributions } from '../src/inspector/orchestrate.js';
import { initInspector, loadAnnotation, loadQueueRules } from '../src/inspector/index.jsx';

function waitFor(fn, { timeout = 1000, step = 5 } = {}) {
  return new Promise((res, rej) => { const t0 = Date.now(); (function p() { let ok = false; try { ok = fn(); } catch { /* ignore */ } if (ok) return res(); if (Date.now() - t0 > timeout) return rej(new Error('timeout')); setTimeout(p, step); })(); });
}

beforeEach(() => { store.reset(); vi.clearAllMocks(); });

describe('inspector orchestrator', () => {
  it('initInspector flips connected false on whoami failure', async () => {
    api.whoami.mockRejectedValue(Object.assign(new Error('Session expired'), { status: 401 }));
    await initInspector();
    expect(store.connected.value).toBe(false);
  });

  it('loadAnnotation populates data from core GETs (blocker followed from URL)', async () => {
    api.getAnnotation.mockResolvedValue({ id: 5, status: 'to_review', messages: [], automation_blocker: 'https://h/api/v1/automation_blockers/9', queue: 'https://h/api/v1/queues/3', schema: 'https://h/api/v1/schemas/7' });
    api.getAutomationBlocker.mockResolvedValue({ content: [{ type: 'low_score' }] });
    api.getContent.mockResolvedValue({ content: [] });
    api.getQueue.mockResolvedValue({ id: 3, automation_level: 'never' });
    api.getSchema.mockResolvedValue({ content: [] });
    store.setAnnotationId('5');
    await loadAnnotation('5');
    expect(store.data.value.annotation.id).toBe(5);
    expect(store.data.value.blocker.content[0].type).toBe('low_score');
    expect(api.getAutomationBlocker).toHaveBeenCalledWith('https://h/api/v1/automation_blockers/9');
    expect(store.loading.value).toBe(false);
  });

  it('a successful load prefetches queue rules and runs the attribution orchestrator', async () => {
    api.getAnnotation.mockResolvedValue({ id: 6, status: 'to_review', messages: [], queue: 'https://h/api/v1/queues/3' });
    api.getContent.mockResolvedValue({ content: [] });
    api.getQueue.mockResolvedValue({ id: 3 });
    api.listRules.mockResolvedValue([{ id: 11, name: 'R', actions: [] }]);
    api.listHooks.mockResolvedValue([]);
    api.listLabels.mockResolvedValue([]);
    api.listWorkflowActivities.mockResolvedValue([]);
    api.listNotes.mockResolvedValue([]);
    api.listHookLogs.mockResolvedValue([]);
    api.listRuleExecutionLogs.mockResolvedValue([]);
    store.setAnnotationId('6');
    await loadAnnotation('6');
    await waitFor(() => orchestrateAttributions.mock.calls.length > 0); // wiring fires (fire-and-forget)
    expect(store.data.value.resolved.rules).toEqual([{ id: 11, name: 'R', actions: [] }]); // loadQueueRules populated resolved.rules
    expect(store.data.value.resolved._rulesLoaded).toBe(true);
  });

  it('a stale queue-rules load does not contaminate a newer annotation (loadId guard)', async () => {
    store.data.value = { annotation: { id: 1, queue: 'https://h/api/v1/queues/3' }, resolved: {} };
    let resolveRules;
    api.listRules.mockReturnValue(new Promise((r) => { resolveRules = r; })); // A's rules are slow
    const stale = loadQueueRules(); // captures the current loadId
    api.getAnnotation.mockReturnValue(new Promise(() => {})); // never resolves — we only need the synchronous ++loadId
    loadAnnotation('2'); // navigate away → bumps loadId synchronously at entry
    resolveRules([{ id: 11, name: 'R', actions: [] }]); // A's rules resolve LATE
    await stale;
    expect(store.data.value.resolved.rules).toBeUndefined(); // stale rules NOT written onto the newer annotation
  });
});
