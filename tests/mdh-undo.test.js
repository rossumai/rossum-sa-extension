// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

globalThis.chrome = globalThis.chrome || {
  storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve() } },
  runtime: { onMessage: { addListener: () => {} } },
};

import { showUndo, triggerUndo, dismissUndo, _reset } from '../src/mdh/undo.js';
import { undoToast } from '../src/mdh/store.js';

beforeEach(() => {
  _reset();
  vi.useRealTimers();
});

describe('undo', () => {
  it('showUndo populates the signal and auto-dismisses after ttl', () => {
    vi.useFakeTimers();
    showUndo({ message: 'Deleted x', action: () => {}, ttlMs: 5_000 });

    expect(undoToast.value).toMatchObject({ message: 'Deleted x', status: 'pending' });

    vi.advanceTimersByTime(4_999);
    expect(undoToast.value).not.toBeNull();

    vi.advanceTimersByTime(2);
    expect(undoToast.value).toBeNull();
  });

  it('a second showUndo replaces the first and resets the timer', () => {
    vi.useFakeTimers();
    showUndo({ message: 'first', action: () => {}, ttlMs: 5_000 });
    vi.advanceTimersByTime(3_000);
    showUndo({ message: 'second', action: () => {}, ttlMs: 5_000 });

    expect(undoToast.value.message).toBe('second');
    // First toast's expiry would have fired at t=5000, but we're at t=3000 with
    // a fresh 5s timer — at t=4999 (1999 into second toast) it must still be
    // visible.
    vi.advanceTimersByTime(1_999);
    expect(undoToast.value).not.toBeNull();
    expect(undoToast.value.message).toBe('second');
  });

  it('triggerUndo runs the action, transitions running -> done, then auto-dismisses', async () => {
    vi.useFakeTimers();
    let resolved = false;
    const action = vi.fn(async () => { resolved = true; });
    showUndo({ message: 'm', action, ttlMs: 10_000 });

    const p = triggerUndo();
    expect(undoToast.value.status).toBe('running');
    await p;
    expect(action).toHaveBeenCalledOnce();
    expect(resolved).toBe(true);
    expect(undoToast.value.status).toBe('done');

    vi.advanceTimersByTime(1_500);
    expect(undoToast.value).toBeNull();
  });

  it('triggerUndo error transitions to error status with message', async () => {
    vi.useFakeTimers();
    const action = vi.fn(async () => { throw new Error('boom'); });
    showUndo({ message: 'm', action, ttlMs: 10_000 });

    await triggerUndo();
    expect(undoToast.value.status).toBe('error');
    expect(undoToast.value.error).toBe('boom');

    vi.advanceTimersByTime(6_000);
    expect(undoToast.value).toBeNull();
  });

  it('triggerUndo is a no-op once status leaves pending', async () => {
    const action = vi.fn(async () => {});
    showUndo({ message: 'm', action, ttlMs: 10_000 });

    await triggerUndo();
    await triggerUndo(); // second call should not invoke action again
    expect(action).toHaveBeenCalledOnce();
  });

  it('dismissUndo clears the toast and the dismiss timer', () => {
    vi.useFakeTimers();
    showUndo({ message: 'm', action: () => {}, ttlMs: 5_000 });
    dismissUndo();
    expect(undoToast.value).toBeNull();
    // No leftover timer should resurrect the toast.
    vi.advanceTimersByTime(10_000);
    expect(undoToast.value).toBeNull();
  });
});
