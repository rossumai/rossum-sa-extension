// @vitest-environment jsdom
//
// useOperationStatus auto-polls api.waitForOperation and drives the GLOBAL top
// stripes: an info `opNotice` while running, the red `error` banner on failure,
// a warning `opNotice` when the outcome is inconclusive (timeout / poll error).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';

vi.mock('../src/mdh/api.js');
import * as api from '../src/mdh/api.js';
import { error, opNotice } from '../src/mdh/store.js';
import useOperationStatus from '../src/mdh/hooks/useOperationStatus.js';

function deferred() {
  let resolve: any, reject: any;
  // The promise stands in for a typed API return (waitForOperation -> Promise<Operation>),
  // so it is the deferred that is generic here, not the assertion that is loosened.
  const promise = new Promise<any>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  let latest: any;
  const container = document.createElement('div');
  render(h(() => { latest = useOperationStatus(); return null; }, null), container);
  return { get: () => latest, unmount: () => render(null, container) };
}

beforeEach(() => { vi.clearAllMocks(); error.value = null; opNotice.value = null; });

describe('useOperationStatus', () => {
  it('shows an info opNotice while running, clears it and calls onFinished on success', async () => {
    const d = deferred();
    vi.mocked(api.waitForOperation).mockReturnValueOnce(d.promise);
    const onFinished = vi.fn();
    const { get } = setup();

    get().track('op1', { label: 'Creating index "x"', onFinished });
    await tick();
    expect(opNotice.value).toMatchObject({ kind: 'info' });
    expect(opNotice.value!.message).toContain('Creating index "x"');

    d.resolve({ status: 'FINISHED' });
    await tick();
    expect(opNotice.value).toBeNull();
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(error.value).toBeNull();
  });

  it('sets the red error banner (with label + server message) and clears the notice on failure', async () => {
    const d = deferred();
    vi.mocked(api.waitForOperation).mockReturnValueOnce(d.promise);
    const { get } = setup();

    get().track('op2', { label: 'Creating search index "my_search_index"' });
    await tick();
    d.reject(new Error('An index named "my_search_index" is already defined'));
    await tick();

    expect(opNotice.value).toBeNull();
    expect(error.value!.message).toContain('Creating search index "my_search_index"');
    expect(error.value!.message).toContain('already defined');
  });

  it('shows a warning opNotice (not a red error) when the outcome is inconclusive', async () => {
    for (const tag of ['timedOut', 'pollUnavailable']) {
      error.value = null; opNotice.value = null;
      const d = deferred();
      vi.mocked(api.waitForOperation).mockReturnValueOnce(d.promise);
      const { get } = setup();
      get().track('op', { label: 'Creating index "x"' });
      await tick();
      const e = new Error('inconclusive');
      (e as any)[tag] = true;
      d.reject(e);
      await tick();
      expect(opNotice.value, tag).toMatchObject({ kind: 'warning' });
      expect(error.value, tag).toBeNull();
    }
  });

  it('a superseding track aborts the prior poll — a late resolve cannot clobber', async () => {
    const d1 = deferred();
    const d2 = deferred();
    vi.mocked(api.waitForOperation).mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise);
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    const { get } = setup();

    get().track('op1', { label: 'A', onFinished: fn1 });
    await tick();
    get().track('op2', { label: 'B', onFinished: fn2 });
    await tick();
    expect(opNotice.value!.message).toContain('B');

    d2.resolve({ status: 'FINISHED' });
    await tick();
    expect(opNotice.value).toBeNull();
    expect(fn2).toHaveBeenCalledTimes(1);

    d1.resolve({ status: 'FINISHED' }); // late resolve of the aborted first poll
    await tick();
    expect(opNotice.value).toBeNull();
    expect(fn1).not.toHaveBeenCalled();
  });

  it('clears its opNotice on unmount (no lingering stripe after leaving the panel)', async () => {
    const d = deferred();
    vi.mocked(api.waitForOperation).mockReturnValueOnce(d.promise);
    // act() flushes preact's mount effect so its unmount cleanup is registered.
    const container = document.createElement('div');
    let api2: any;
    act(() => { render(h(() => { api2 = useOperationStatus(); return null; }, null), container); });
    act(() => { api2.track('op1', { label: 'Creating index "x"' }); });
    expect(opNotice.value).not.toBeNull();
    act(() => { render(null, container); }); // unmount → cleanup runs
    expect(opNotice.value).toBeNull();
  });

  it('clear() aborts the poll and clears the notice', async () => {
    const d = deferred();
    vi.mocked(api.waitForOperation).mockReturnValueOnce(d.promise);
    const onFinished = vi.fn();
    const { get } = setup();
    get().track('op1', { label: 'Creating index "x"', onFinished });
    await tick();
    get().clear();
    expect(opNotice.value).toBeNull();
    d.resolve({ status: 'FINISHED' });
    await tick();
    expect(onFinished).not.toHaveBeenCalled(); // aborted
  });
});
