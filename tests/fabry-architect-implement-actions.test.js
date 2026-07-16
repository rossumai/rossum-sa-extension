// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../src/agent/agentApi.js', () => ({ createChat: vi.fn(), streamMessage: vi.fn() }));
vi.mock('../src/fabry/architect/api.js', () => ({
  COLLECTION: '__mrfabry_architect',
  ensureCollection: vi.fn().mockResolvedValue(undefined),
  loadDeliverables: vi.fn().mockResolvedValue({ deliverables: [], results: {}, implement: {} }),
  addDeliverable: vi.fn().mockResolvedValue({}), updateDeliverable: vi.fn().mockResolvedValue({}),
  deleteDeliverable: vi.fn().mockResolvedValue({}), saveResult: vi.fn().mockResolvedValue({}),
  setOrder: vi.fn().mockResolvedValue({}),
  saveImplementResult: vi.fn().mockResolvedValue({}),
}));
import * as agentApi from '../src/agent/agentApi.js';
import * as api from '../src/fabry/architect/api.js';
import * as store from '../src/fabry/architect/store.js';
import { reImplement, stopImplement, reRun } from '../src/fabry/architect/actions.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

// Scripted streamMessage: routes on prompt substrings so each turn kind (plan,
// task-implement, task-check, persona-prime, roll-up) can be exercised and
// asserted independently. One task is planned, implemented (with an audited
// write), passes its per-task check, then the deliverable roll-up also passes.
function scriptStreamMessage() {
  return vi.fn().mockImplementation(async (id, content, { onEvent } = {}) => {
    if (content.startsWith('/persona')) { onEvent({ type: 'finish' }); return; }
    if (content.includes('break the requirement into')) {                 // plan turn
      onEvent({ type: 'text-delta', delta: '[{"text":"create VAT rule","acceptance":"rule exists"}]' });
      onEvent({ type: 'finish' }); return;
    }
    if (content.includes('implementing ONE task')) {                     // task-implement turn
      onEvent({ type: 'tool-input-start', toolCallId: 't1', toolName: 'create_rule' });
      onEvent({ type: 'tool-input-available', toolCallId: 't1', input: { name: 'VAT' } });
      onEvent({ type: 'tool-output-available', toolCallId: 't1', output: 'ok' });
      onEvent({ type: 'text-delta', delta: 'Created a VAT rule.' }); onEvent({ type: 'finish' }); return;
    }
    if (content.includes('verifying whether ONE implementation task')) {  // task-check turn
      onEvent({ type: 'text-delta', delta: 'VERDICT: PASS\nThe task is done.' }); onEvent({ type: 'finish' }); return;
    }
    if (content.includes('auditing a Rossum organization')) {             // deliverable roll-up turn
      onEvent({ type: 'text-delta', delta: 'VERDICT: PASS\nThe requirement is met.' }); onEvent({ type: 'finish' }); return;
    }
    onEvent({ type: 'finish' });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  store.deliverables.value = []; store.results.value = {}; store.implement.value = {}; store.implementRunning.value = false;
});

describe('reImplement (task-decomposition loop, audited)', () => {
  beforeEach(() => {
    store.deliverables.value = [{ id: 'a', text: 'Add a VAT rule', order: 1 }];
    let n = 0;
    agentApi.createChat.mockImplementation(async () => 'chat_' + (n++));
    agentApi.streamMessage.mockImplementation(scriptStreamMessage());
  });

  it('write boundary: only the task-implement turn carries mcpMode read-write', async () => {
    await reImplement('a');
    await flush();
    const findCall = (re) => agentApi.streamMessage.mock.calls.find((c) => re.test(c[1]));
    const planCall = findCall(/break the requirement into/);
    const taskCall = findCall(/implementing ONE task/);
    const taskCheckCall = findCall(/verifying whether ONE implementation task/);
    const rollupCall = findCall(/auditing a Rossum organization/);
    const primeCall = agentApi.streamMessage.mock.calls.find((c) => c[1].startsWith('/persona'));
    expect(planCall).toBeTruthy();
    expect(taskCall).toBeTruthy();
    expect(taskCheckCall).toBeTruthy();
    expect(rollupCall).toBeTruthy();
    expect(primeCall).toBeTruthy();
    // the ONLY write-enabled turn is the task-implement turn ...
    expect(taskCall[2].mcpMode).toBe('read-write');
    // ... every other turn (plan, per-task check, persona prime, roll-up) is read-only.
    expect(planCall[2].mcpMode).toBeUndefined();
    expect(taskCheckCall[2].mcpMode).toBeUndefined();
    expect(rollupCall[2].mcpMode).toBeUndefined();
    expect(primeCall[2].mcpMode).toBeUndefined();
  });

  it('end-to-end: plan -> 1 task -> pass -> roll-up pass -> passing, tasks recorded', async () => {
    await reImplement('a');
    await flush();
    expect(store.implement.value.a.status).toBe('passing');
    expect(store.implement.value.a.tasks).toHaveLength(1);
    expect(store.implement.value.a.tasks[0].status).toBe('done');
    expect(store.implement.value.a.writes[0]).toMatchObject({ tool: 'create_rule', ok: true });
    expect(store.results.value.a.verdict).toBe('pass');           // reflected in the shared verdict banner
    // ...and PERSISTED as the Check result so it survives reload (not just in-memory).
    expect(api.saveResult).toHaveBeenCalledWith('a', expect.objectContaining({ verdict: 'pass' }));
    expect(store.results.value.a.stale).toBe(false);
    expect(api.saveImplementResult).toHaveBeenCalled();
    const saved = api.saveImplementResult.mock.calls[0][1];
    expect(Array.isArray(saved.tasks)).toBe(true);
    expect(saved.tasks).toHaveLength(1);
    expect(saved.tasks[0].status).toBe('done');
  });

  it('stopImplement clears a dangling spinner when aborted mid-run', async () => {
    agentApi.createChat.mockReset();
    agentApi.createChat.mockResolvedValue('chat_x');
    agentApi.streamMessage.mockReset();
    // plan turn resolves normally; the task-implement turn hangs until the run is aborted.
    agentApi.streamMessage.mockImplementation((id, content, { signal, onEvent } = {}) => {
      if (content.includes('break the requirement into')) {
        onEvent({ type: 'text-delta', delta: '[{"text":"create VAT rule","acceptance":"rule exists"}]' });
        onEvent({ type: 'finish' });
        return Promise.resolve();
      }
      return new Promise((resolve) => { if (signal) signal.addEventListener('abort', () => resolve()); });
    });
    const p = reImplement('a');            // do NOT await — it is mid-stream
    await flush();
    expect(store.implement.value.a.running).toBe(true);    // spinner is up
    stopImplement();                        // abort the run
    await p;                                // let runImplementList settle
    expect(store.implement.value.a.running).toBe(false);   // spinner cleared
    expect(store.implementRunning.value).toBe(false);
  });

  it('Stop persists a terminal "stopped" result WITH the writes the interrupted turn already executed', async () => {
    agentApi.createChat.mockReset();
    let n = 0; agentApi.createChat.mockImplementation(async () => 'chat_' + (n++));
    agentApi.streamMessage.mockReset();
    agentApi.streamMessage.mockImplementation((id, content, { signal, onEvent } = {}) => {
      if (content.startsWith('/persona')) { onEvent({ type: 'finish' }); return Promise.resolve(); }
      if (content.includes('break the requirement into')) {
        onEvent({ type: 'text-delta', delta: '[{"text":"t1","acceptance":"a"}]' });
        onEvent({ type: 'finish' });
        return Promise.resolve();
      }
      if (content.includes('implementing ONE task')) {
        // The agent executes a write, then the turn hangs until the run is aborted,
        // at which point the transport THROWS AbortError (as agentApi.js does).
        onEvent({ type: 'tool-input-start', toolCallId: 'w1', toolName: 'create_hook' });
        onEvent({ type: 'tool-input-available', toolCallId: 'w1', input: { name: 'H' } });
        onEvent({ type: 'tool-output-available', toolCallId: 'w1', output: 'ok' });
        return new Promise((_, reject) => {
          if (signal) signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
        });
      }
      onEvent({ type: 'finish' }); return Promise.resolve();
    });
    const p = reImplement('a');
    await flush();
    stopImplement();
    await p;
    // The write is not lost, and the run is persisted at a terminal 'stopped' state.
    expect(store.implement.value.a.status).toBe('stopped');
    expect(store.implement.value.a.writes.some((w) => w.tool === 'create_hook')).toBe(true);
    expect(api.saveImplementResult).toHaveBeenCalled();
    const saved = api.saveImplementResult.mock.calls.at(-1)[1];
    expect(saved.status).toBe('stopped');
    expect(saved.writes.some((w) => w.tool === 'create_hook')).toBe(true);
    expect(store.implement.value.a.running).toBe(false);
    expect(store.implementRunning.value).toBe(false);
  });

  it('a write from a turn that RESOLVED just as Stop fired is still audited (no resolve-then-abort loss)', async () => {
    agentApi.createChat.mockReset();
    let n = 0; agentApi.createChat.mockImplementation(async () => 'chat_' + (n++));
    agentApi.streamMessage.mockReset();
    agentApi.streamMessage.mockImplementation((id, content, { onEvent } = {}) => {
      if (content.startsWith('/persona')) { onEvent({ type: 'finish' }); return Promise.resolve(); }
      if (content.includes('break the requirement into')) {
        onEvent({ type: 'text-delta', delta: '[{"text":"t1","acceptance":"a"}]' }); onEvent({ type: 'finish' }); return Promise.resolve();
      }
      if (content.includes('implementing ONE task')) {
        onEvent({ type: 'tool-input-start', toolCallId: 'w1', toolName: 'create_hook' });
        onEvent({ type: 'tool-input-available', toolCallId: 'w1', input: { name: 'H' } });
        onEvent({ type: 'tool-output-available', toolCallId: 'w1', output: 'ok' });
        onEvent({ type: 'text-delta', delta: 'done' });
        stopImplement();            // Stop fires exactly as this turn completes...
        onEvent({ type: 'finish' });
        return Promise.resolve();   // ...and the stream RESOLVES (does not throw)
      }
      onEvent({ type: 'finish' }); return Promise.resolve();
    });
    await reImplement('a');
    await flush();
    expect(store.implement.value.a.status).toBe('stopped');
    expect(store.implement.value.a.writes.some((w) => w.tool === 'create_hook')).toBe(true);
    const saved = api.saveImplementResult.mock.calls.at(-1)[1];
    expect(saved.writes.some((w) => w.tool === 'create_hook')).toBe(true);
  });

  it('an in-flight per-deliverable Re-run blocks Implement from starting (no verdict clobber)', async () => {
    // reRun sets only results[a].running (NOT store.running); Implement must still refuse
    // to start, else the stale check's late persist could clobber the implement roll-up.
    agentApi.streamMessage.mockImplementation((id, content) => {
      if (content.startsWith('/persona')) return Promise.resolve();
      return new Promise(() => {}); // the check turn hangs → reRun stays in-flight
    });
    reRun('a'); // not awaited — starts a read-only check
    await flush();
    expect(store.results.value.a.running).toBe(true);
    await reImplement('a'); // must be blocked
    expect(store.implementRunning.value).toBe(false);
    expect(agentApi.streamMessage.mock.calls.some((c) => c[1].includes('break the requirement into'))).toBe(false); // no plan turn
    expect(api.saveImplementResult).not.toHaveBeenCalled();
  });

  it('a transport-errored roll-up updates the banner but does NOT persist (preserves last-known-good)', async () => {
    // Everything passes up to the roll-up, which throws (e.g. 429/network).
    agentApi.streamMessage.mockImplementation(async (id, content, { onEvent } = {}) => {
      if (content.startsWith('/persona')) { onEvent({ type: 'finish' }); return; }
      if (content.includes('break the requirement into')) {
        onEvent({ type: 'text-delta', delta: '[{"text":"t","acceptance":"a"}]' }); onEvent({ type: 'finish' }); return;
      }
      if (content.includes('implementing ONE task')) { onEvent({ type: 'text-delta', delta: 'done' }); onEvent({ type: 'finish' }); return; }
      if (content.includes('verifying whether ONE implementation task')) { onEvent({ type: 'text-delta', delta: 'VERDICT: PASS' }); onEvent({ type: 'finish' }); return; }
      if (content.includes('auditing a Rossum organization')) { throw new Error('gate down'); }
      onEvent({ type: 'finish' });
    });
    await reImplement('a');
    await flush();
    expect(store.implement.value.a.status).toBe('uncertain');
    expect(store.results.value.a.verdict).toBe('uncertain');   // banner reflects the failed roll-up
    expect(api.saveResult).not.toHaveBeenCalled();             // but nothing persisted
  });
});
