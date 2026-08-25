import { describe, it, expect, vi } from 'vitest';
import { runImplement } from '../src/fabry/architect/implementLoop.js';

// runImplement takes Deliverable[]; its deps are all `(d: any)`, so the loop itself only
// reads `d.id`. The fixture still builds a COMPLETE Deliverable — production callers
// pass real ones, and a partial fixture would quietly let the contract drift.
const del = (id: any, text: any): any =>
  ({ id, text, order: 0, title: text, titleSource: 'heading', createdAt: null, editedAt: null });
const ds = (n: any) => Array.from({ length: n }, (_, i) => del('d' + i, 'Add VAT validation ' + i));
const oneD = () => [del('d0', 'Add VAT validation')];
const collect = () => { const ev: Record<string, any> = {}; return { onEvent: (id: any, p: any) => { ev[id] = { ...(ev[id] || {}), ...p }; }, ev }; };
const taskByText = (tasks: any, text: any) => (tasks || []).find((t: any) => t.text === text);

describe('runImplement (dynamic task-decomposition state machine)', () => {
  it('1. plan -> task -> pass', async () => {
    const planOne = vi.fn().mockResolvedValue([{ text: 't1', acceptance: 'a' }]);
    const implementTaskOne = vi.fn().mockResolvedValue({ writes: [{ tool: 'create_rule' }], summary: 's', discovered: [] });
    const checkTaskOne = vi.fn().mockResolvedValue({ verdict: 'pass' });
    const checkDeliverable = vi.fn().mockResolvedValue({ verdict: 'pass' });
    const { onEvent, ev } = collect();
    await runImplement(oneD(), { planOne, implementTaskOne, checkTaskOne, checkDeliverable, onEvent });
    expect(ev.d0.status).toBe('passing');
    expect(ev.d0.done).toBe(true);
    expect(taskByText(ev.d0.tasks, 't1').status).toBe('done');
  });

  it('2. empty plan (already satisfied) does NOT write — goes straight to the read-only roll-up', async () => {
    const planOne = vi.fn().mockResolvedValue([]);
    const implementTaskOne = vi.fn().mockResolvedValue({ writes: [], summary: 's', discovered: [] });
    const checkTaskOne = vi.fn().mockResolvedValue({ verdict: 'pass' });
    const checkDeliverable = vi.fn().mockResolvedValue({ verdict: 'pass' });
    const { onEvent, ev } = collect();
    await runImplement(oneD(), { planOne, implementTaskOne, checkTaskOne, checkDeliverable, onEvent });
    expect(implementTaskOne).not.toHaveBeenCalled();   // no write-enabled turn for an already-satisfied deliverable
    expect(checkTaskOne).not.toHaveBeenCalled();
    expect(checkDeliverable).toHaveBeenCalledTimes(1); // read-only roll-up confirms it
    expect(ev.d0.tasks).toEqual([]);
    expect(ev.d0.status).toBe('passing');
    expect(ev.d0.done).toBe(true);
  });

  it('3. per-task retry: checkTaskOne fails once then passes', async () => {
    const planOne = vi.fn().mockResolvedValue([{ text: 't1', acceptance: 'a' }]);
    const implementTaskOne = vi.fn().mockResolvedValue({ writes: [], summary: 's', discovered: [] });
    const checkTaskOne = vi.fn()
      .mockResolvedValueOnce({ verdict: 'fail', evidence: 'nope' })
      .mockResolvedValueOnce({ verdict: 'pass', evidence: 'ok' });
    const checkDeliverable = vi.fn().mockResolvedValue({ verdict: 'pass' });
    const { onEvent, ev } = collect();
    await runImplement(oneD(), { planOne, implementTaskOne, checkTaskOne, checkDeliverable, onEvent });
    expect(implementTaskOne).toHaveBeenCalledTimes(2);
    expect(implementTaskOne.mock.calls[1][2].journal).toEqual([{ attempt: 1, summary: 's', verdict: 'fail', learnings: 'nope' }]);
    expect(taskByText(ev.d0.tasks, 't1').status).toBe('done');
    expect(ev.d0.status).toBe('passing');
  });

  it('4. task attempts exhausted -> failed', async () => {
    const planOne = vi.fn().mockResolvedValue([{ text: 't1', acceptance: 'a' }]);
    const implementTaskOne = vi.fn().mockResolvedValue({ writes: [], summary: 's', discovered: [] });
    const checkTaskOne = vi.fn().mockResolvedValue({ verdict: 'fail', evidence: 'no' });
    const checkDeliverable = vi.fn().mockResolvedValue({ verdict: 'pass' });
    const { onEvent, ev } = collect();
    await runImplement(oneD(), { planOne, implementTaskOne, checkTaskOne, checkDeliverable, onEvent, maxAttemptsPerTask: 3 });
    expect(implementTaskOne).toHaveBeenCalledTimes(3);
    expect(taskByText(ev.d0.tasks, 't1').status).toBe('failed');
  });

  it('5. dynamic discovered task is processed; duplicate discovered text is not added', async () => {
    const planOne = vi.fn().mockResolvedValue([{ text: 't1', acceptance: 'a' }]);
    const implementTaskOne = vi.fn().mockImplementation(async (d, task) => {
      if (task.text === 't1') {
        return { writes: [], summary: 's', discovered: [{ text: 'prereq', acceptance: 'p' }, { text: 't1', acceptance: 'dup' }] };
      }
      return { writes: [], summary: 's', discovered: [] };
    });
    const checkTaskOne = vi.fn().mockResolvedValue({ verdict: 'pass' });
    const checkDeliverable = vi.fn().mockResolvedValue({ verdict: 'pass' });
    const { onEvent, ev } = collect();
    await runImplement(oneD(), { planOne, implementTaskOne, checkTaskOne, checkDeliverable, onEvent });
    expect(ev.d0.tasks.length).toBe(2);
    expect(taskByText(ev.d0.tasks, 'prereq')).toBeTruthy();
    expect(taskByText(ev.d0.tasks, 'prereq').status).toBe('done');
    expect(implementTaskOne.mock.calls.some((c) => c[1].text === 'prereq')).toBe(true);
    expect(ev.d0.status).toBe('passing');
  });

  it('6. maxTotalTasks cap drops a discovered task and notes it', async () => {
    const planOne = vi.fn().mockResolvedValue([{ text: 't1', acceptance: 'a' }]);
    const implementTaskOne = vi.fn().mockResolvedValue({ writes: [], summary: 's', discovered: [{ text: 'prereq', acceptance: 'p' }] });
    const checkTaskOne = vi.fn().mockResolvedValue({ verdict: 'pass' });
    const checkDeliverable = vi.fn().mockResolvedValue({ verdict: 'pass' });
    const { onEvent, ev } = collect();
    await runImplement(oneD(), { planOne, implementTaskOne, checkTaskOne, checkDeliverable, onEvent, maxTotalTasks: 1 });
    expect(ev.d0.tasks.length).toBe(1);
    expect(implementTaskOne).toHaveBeenCalledTimes(1);
    expect(ev.d0.note).toMatch(/Task cap/);
  });

  it('7. transient check error fails the task without re-driving implement', async () => {
    const planOne = vi.fn().mockResolvedValue([{ text: 't1', acceptance: 'a' }]);
    const implementTaskOne = vi.fn().mockResolvedValue({ writes: [], summary: 's', discovered: [] });
    const checkTaskOne = vi.fn().mockRejectedValue(new Error('network blip'));
    const checkDeliverable = vi.fn().mockResolvedValue({ verdict: 'pass' });
    const { onEvent, ev } = collect();
    await runImplement(oneD(), { planOne, implementTaskOne, checkTaskOne, checkDeliverable, onEvent, maxAttemptsPerTask: 5 });
    expect(implementTaskOne).toHaveBeenCalledTimes(1);
    expect(taskByText(ev.d0.tasks, 't1').status).toBe('failed');
  });

  it('8. maxTotalWrites is a global circuit-breaker -> blocked', async () => {
    const planOne = vi.fn().mockResolvedValue([{ text: 't1', acceptance: 'a' }]);
    const implementTaskOne = vi.fn().mockResolvedValue({ writes: [{ tool: 'a' }, { tool: 'b' }, { tool: 'c' }], summary: 's', discovered: [] });
    const checkTaskOne = vi.fn().mockResolvedValue({ verdict: 'pass' });
    const checkDeliverable = vi.fn().mockResolvedValue({ verdict: 'pass' });
    const { onEvent, ev } = collect();
    await runImplement(oneD(), { planOne, implementTaskOne, checkTaskOne, checkDeliverable, onEvent, maxTotalWrites: 2 });
    expect(ev.d0.status).toBe('blocked');
    expect(ev.d0.done).toBe(true);
    expect(checkDeliverable).not.toHaveBeenCalled();
  });

  it('9. roll-up remediation: fail round 1, fresh remediation task, pass round 2', async () => {
    const planOne = vi.fn()
      .mockResolvedValueOnce([{ text: 't1', acceptance: 'a' }])
      .mockResolvedValueOnce([{ text: 'fix-it', acceptance: 'f' }]);
    const implementTaskOne = vi.fn().mockResolvedValue({ writes: [], summary: 's', discovered: [] });
    const checkTaskOne = vi.fn().mockResolvedValue({ verdict: 'pass' });
    const checkDeliverable = vi.fn()
      .mockResolvedValueOnce({ verdict: 'fail', evidence: 'missing bit' })
      .mockResolvedValueOnce({ verdict: 'pass' });
    const { onEvent, ev } = collect();
    await runImplement(oneD(), { planOne, implementTaskOne, checkTaskOne, checkDeliverable, onEvent });
    expect(ev.d0.status).toBe('passing');
    expect(taskByText(ev.d0.tasks, 'fix-it').origin).toBe('remediation');
    expect(taskByText(ev.d0.tasks, 'fix-it').status).toBe('done');
    expect(implementTaskOne.mock.calls.some((c) => c[1].text === 'fix-it')).toBe(true);
  });

  it('10. maxRollupRounds cap -> failed after the bounded number of rounds', async () => {
    let n = 0;
    const planOne = vi.fn().mockImplementation(async () => { n += 1; return n === 1 ? [{ text: 't1' }] : [{ text: 'remedy' + n }]; });
    const implementTaskOne = vi.fn().mockResolvedValue({ writes: [], summary: 's', discovered: [] });
    const checkTaskOne = vi.fn().mockResolvedValue({ verdict: 'pass' });
    const checkDeliverable = vi.fn().mockResolvedValue({ verdict: 'fail', evidence: 'still broken' });
    const { onEvent, ev } = collect();
    await runImplement(oneD(), { planOne, implementTaskOne, checkTaskOne, checkDeliverable, onEvent, maxRollupRounds: 2 });
    expect(ev.d0.status).toBe('failed');
    expect(checkDeliverable).toHaveBeenCalledTimes(2);
  });

  it('11. roll-up fail with no fresh tasks stops without looping forever', async () => {
    const planOne = vi.fn()
      .mockResolvedValueOnce([{ text: 't1', acceptance: 'a' }])
      .mockResolvedValueOnce([]);
    const implementTaskOne = vi.fn().mockResolvedValue({ writes: [], summary: 's', discovered: [] });
    const checkTaskOne = vi.fn().mockResolvedValue({ verdict: 'pass' });
    const checkDeliverable = vi.fn().mockResolvedValue({ verdict: 'fail', evidence: 'nope' });
    const { onEvent, ev } = collect();
    await runImplement(oneD(), { planOne, implementTaskOne, checkTaskOne, checkDeliverable, onEvent });
    expect(ev.d0.status).toBe('failed');
    expect(checkDeliverable).toHaveBeenCalledTimes(1);
    expect(planOne).toHaveBeenCalledTimes(2);
  });

  it('12. abort mid-turn stops the whole run', async () => {
    const ctrl = new AbortController();
    const planOne = vi.fn().mockResolvedValue([{ text: 't1', acceptance: 'a' }]);
    const implementTaskOne = vi.fn().mockImplementation(async () => { ctrl.abort(); return { writes: [], summary: '', discovered: [] }; });
    const checkTaskOne = vi.fn().mockResolvedValue({ verdict: 'pass' });
    const checkDeliverable = vi.fn().mockResolvedValue({ verdict: 'pass' });
    const { onEvent } = collect();
    await runImplement(ds(3), { planOne, implementTaskOne, checkTaskOne, checkDeliverable, onEvent, signal: ctrl.signal });
    expect(implementTaskOne).toHaveBeenCalledTimes(1);
    expect(checkTaskOne).not.toHaveBeenCalled();
    expect(checkDeliverable).not.toHaveBeenCalled();
    expect(planOne).toHaveBeenCalledTimes(1);
  });

  it('13. sequential across 2 deliverables, processed in order', async () => {
    const order: any = [];
    const planOne = vi.fn().mockImplementation(async (d) => { order.push(d.id); return [{ text: 't1', acceptance: 'a' }]; });
    const implementTaskOne = vi.fn().mockResolvedValue({ writes: [], summary: 's', discovered: [] });
    const checkTaskOne = vi.fn().mockResolvedValue({ verdict: 'pass' });
    const checkDeliverable = vi.fn().mockResolvedValue({ verdict: 'pass' });
    const { onEvent, ev } = collect();
    await runImplement(ds(2), { planOne, implementTaskOne, checkTaskOne, checkDeliverable, onEvent });
    expect(order).toEqual(['d0', 'd1']);
    expect(ev.d0.status).toBe('passing');
    expect(ev.d1.status).toBe('passing');
    expect(ev.d0.done).toBe(true);
    expect(ev.d1.done).toBe(true);
  });

  it('14. planOne initial throw fails only this deliverable + the run continues', async () => {
    const planOne = vi.fn()
      .mockRejectedValueOnce(new Error('planner exploded'))
      .mockResolvedValueOnce([{ text: 't1', acceptance: 'a' }]);
    const implementTaskOne = vi.fn().mockResolvedValue({ writes: [], summary: 's', discovered: [] });
    const checkTaskOne = vi.fn().mockResolvedValue({ verdict: 'pass' });
    const checkDeliverable = vi.fn().mockResolvedValue({ verdict: 'pass' });
    const { onEvent, ev } = collect();
    await runImplement(ds(2), { planOne, implementTaskOne, checkTaskOne, checkDeliverable, onEvent });
    expect(ev.d0.status).toBe('failed');
    expect(ev.d0.done).toBe(true);
    expect(ev.d0.error).toMatch(/Planning failed/);
    expect(ev.d1.status).toBe('passing');
    expect(ev.d1.done).toBe(true);
  });

  it('15. checkDeliverable transport error -> uncertain, no extra write round', async () => {
    const planOne = vi.fn().mockResolvedValue([{ text: 't1', acceptance: 'a' }]);
    const implementTaskOne = vi.fn().mockResolvedValue({ writes: [], summary: 's', discovered: [] });
    const checkTaskOne = vi.fn().mockResolvedValue({ verdict: 'pass' });
    const checkDeliverable = vi.fn().mockRejectedValue(new Error('gate down'));
    const { onEvent, ev } = collect();
    await runImplement(oneD(), { planOne, implementTaskOne, checkTaskOne, checkDeliverable, onEvent });
    expect(ev.d0.status).toBe('uncertain');
    expect(planOne).toHaveBeenCalledTimes(1);
    expect(implementTaskOne).toHaveBeenCalledTimes(1);
  });

  it('16. remediation-cap note when a fresh remediation task would exceed maxTotalTasks', async () => {
    const planOne = vi.fn()
      .mockResolvedValueOnce([{ text: 't1', acceptance: 'a' }])
      .mockResolvedValueOnce([{ text: 'fix-it', acceptance: 'f' }]);
    const implementTaskOne = vi.fn().mockResolvedValue({ writes: [], summary: 's', discovered: [] });
    const checkTaskOne = vi.fn().mockResolvedValue({ verdict: 'pass' });
    const checkDeliverable = vi.fn()
      .mockResolvedValueOnce({ verdict: 'fail', evidence: 'missing bit' })
      .mockResolvedValueOnce({ verdict: 'pass' });
    const { onEvent, ev } = collect();
    await runImplement(oneD(), { planOne, implementTaskOne, checkTaskOne, checkDeliverable, onEvent, maxTotalTasks: 1 });
    expect(ev.d0.note).toMatch(/dropped remediation task/);
    expect(taskByText(ev.d0.tasks, 'fix-it')).toBeFalsy();
  });

  it('17. maxTotalWrites cross-deliverable budget blocks a later deliverable', async () => {
    // 3 writes per implement call; budget of 5 lets d0 finish (3) and d1 tip it over (6 >= 5),
    // so d2's short-circuit check (top of the outer loop) fires before planOne/implementTaskOne
    // are ever called for it.
    const planOne = vi.fn().mockResolvedValue([{ text: 't1', acceptance: 'a' }]);
    const implementTaskOne = vi.fn().mockResolvedValue({ writes: [{ tool: 'a' }, { tool: 'b' }, { tool: 'c' }], summary: 's', discovered: [] });
    const checkTaskOne = vi.fn().mockResolvedValue({ verdict: 'pass' });
    const checkDeliverable = vi.fn().mockResolvedValue({ verdict: 'pass' });
    const { onEvent, ev } = collect();
    await runImplement(ds(3), { planOne, implementTaskOne, checkTaskOne, checkDeliverable, onEvent, maxTotalWrites: 5 });
    expect(ev.d0.status).toBe('passing');
    expect(ev.d2.status).toBe('blocked');
    expect(ev.d2.done).toBe(true);
    expect(implementTaskOne).toHaveBeenCalledTimes(2); // d0 + d1; d2 never reaches implement
  });

  it('19. abort mid-task emits a terminal "stopped" patch (so the glue can persist the audit)', async () => {
    const ctrl = new AbortController();
    const planOne = vi.fn().mockResolvedValue([{ text: 't1', acceptance: 'a' }]);
    // The write turn executes a write, THEN the run is aborted before the turn returns.
    const implementTaskOne = vi.fn().mockImplementation(async () => { ctrl.abort(); return { writes: [{ tool: 'create_rule' }], summary: 's', discovered: [] }; });
    const checkTaskOne = vi.fn().mockResolvedValue({ verdict: 'pass' });
    const checkDeliverable = vi.fn().mockResolvedValue({ verdict: 'pass' });
    const { onEvent, ev } = collect();
    await runImplement(oneD(), { planOne, implementTaskOne, checkTaskOne, checkDeliverable, onEvent, signal: ctrl.signal });
    expect(ev.d0.status).toBe('stopped');   // honest terminal, not stuck at 'running'
    expect(ev.d0.done).toBe(true);          // done:true → the glue persists the audit
    expect(ev.d0.writes).toEqual([{ tool: 'create_rule' }]); // the interrupted turn's write is still recorded
  });

  it('20. a write executed in an interrupted (throwing) turn is still counted + audited', async () => {
    const ctrl = new AbortController();
    const planOne = vi.fn().mockResolvedValue([{ text: 't1', acceptance: 'a' }]);
    // The turn throws AFTER a write — the error carries the audited writes (as actions.js attaches).
    const implementTaskOne = vi.fn().mockImplementation(async () => {
      ctrl.abort();
      const err: any = new Error('aborted'); err.writes = [{ tool: 'create_hook' }]; throw err;
    });
    const checkTaskOne = vi.fn().mockResolvedValue({ verdict: 'pass' });
    const checkDeliverable = vi.fn().mockResolvedValue({ verdict: 'pass' });
    const { onEvent, ev } = collect();
    await runImplement(oneD(), { planOne, implementTaskOne, checkTaskOne, checkDeliverable, onEvent, signal: ctrl.signal });
    expect(ev.d0.status).toBe('stopped');
    expect(ev.d0.writes).toEqual([{ tool: 'create_hook' }]); // not lost despite the throw
  });

  it('21. terminal patch carries the accumulated learnings journal (so it can be persisted)', async () => {
    const planOne = vi.fn().mockResolvedValue([{ text: 't1', acceptance: 'a' }]);
    const implementTaskOne = vi.fn().mockResolvedValue({ writes: [], summary: 's', discovered: [] });
    const checkTaskOne = vi.fn()
      .mockResolvedValueOnce({ verdict: 'fail', evidence: 'nope' })
      .mockResolvedValueOnce({ verdict: 'pass', evidence: 'ok' });
    const checkDeliverable = vi.fn().mockResolvedValue({ verdict: 'pass' });
    const { onEvent, ev } = collect();
    await runImplement(oneD(), { planOne, implementTaskOne, checkTaskOne, checkDeliverable, onEvent });
    expect(ev.d0.journal).toEqual([{ attempt: 1, summary: 's', verdict: 'fail', learnings: 'nope' }]);
  });

  it('18. maxPlanTasks slices an oversized plan', async () => {
    const planOne = vi.fn().mockResolvedValue([
      { text: 't1', acceptance: 'a' },
      { text: 't2', acceptance: 'a' },
      { text: 't3', acceptance: 'a' },
      { text: 't4', acceptance: 'a' },
    ]);
    const implementTaskOne = vi.fn().mockResolvedValue({ writes: [], summary: 's', discovered: [] });
    const checkTaskOne = vi.fn().mockResolvedValue({ verdict: 'pass' });
    const checkDeliverable = vi.fn().mockResolvedValue({ verdict: 'pass' });
    const { onEvent, ev } = collect();
    await runImplement(oneD(), { planOne, implementTaskOne, checkTaskOne, checkDeliverable, onEvent, maxPlanTasks: 2 });
    expect(ev.d0.tasks.length).toBe(2);
    expect(implementTaskOne).toHaveBeenCalledTimes(2);
  });
});
