// @vitest-environment jsdom
//
// MDH V2 writes return 202 with no operation id, so there is nothing to poll on
// operation_status the way useOperationStatus does. Progress is only visible in
// the resource itself, and this hook is what makes the panel see it move.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';

vi.mock('../src/mdh/api.js');
import * as api from '../src/mdh/api.js';
import * as cache from '../src/mdh/cache.js';
import useIndexReconcile from '../src/mdh/hooks/useIndexReconcile.js';

function setup(onRows: (rows: any[], checkedAt: number) => void) {
  let latest: any;
  const container = document.createElement('div');
  const Probe = () => {
    latest = useIndexReconcile(onRows);
    return null;
  };
  // act() drains Preact's deferred effect queue, so the hook's unmount cleanup is
  // actually registered before a test unmounts. Without it the mount effect never
  // runs under fake timers and "unmounting stops the loop" would pass vacuously.
  act(() => {
    render(<Probe />, container);
  });
  return {
    get: () => latest,
    unmount: () =>
      act(() => {
        render(null, container);
      }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  cache.invalidateAll();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useIndexReconcile', () => {
  it('fetches once immediately and stops when nothing is transitional', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([{ name: 'a', status: 'READY' }] as any);
    const onRows = vi.fn();
    const probe = setup(onRows);

    probe.get().watch('example');
    await vi.advanceTimersByTimeAsync(0);
    expect(onRows).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.listSearchIndexes).toHaveBeenCalledTimes(1);
    probe.unmount();
  });

  it('keeps polling while an index is transitional, then stops once it settles', async () => {
    vi.mocked(api.listSearchIndexes)
      .mockResolvedValueOnce([{ name: 'a', status: 'PENDING_CREATE' }] as any)
      .mockResolvedValueOnce([{ name: 'a', status: 'BUILDING' }] as any)
      .mockResolvedValue([{ name: 'a', status: 'READY' }] as any);
    const probe = setup(() => {});

    probe.get().watch('example');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.listSearchIndexes).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(api.listSearchIndexes).toHaveBeenCalledTimes(3);
    probe.unmount();
  });

  it('stops on an unrecognised status rather than polling forever', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([{ name: 'a', status: 'WAT' }] as any);
    const probe = setup(() => {});

    probe.get().watch('example');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(api.listSearchIndexes).toHaveBeenCalledTimes(1);
    probe.unmount();
  });

  it('writes each result into the cache so panel and cache never disagree', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([{ name: 'a', status: 'READY' }] as any);
    const probe = setup(() => {});

    probe.get().watch('example');
    await vi.advanceTimersByTimeAsync(0);
    expect(cache.get('example', 'searchIndexes')).toEqual([{ name: 'a', status: 'READY' }]);
    probe.unmount();
  });

  it('stop() prevents any further fetch', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([{ name: 'a', status: 'BUILDING' }] as any);
    const probe = setup(() => {});

    probe.get().watch('example');
    await vi.advanceTimersByTimeAsync(0);
    probe.get().stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(api.listSearchIndexes).toHaveBeenCalledTimes(1);
    probe.unmount();
  });

  it('a new watch abandons the previous collection', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([{ name: 'a', status: 'BUILDING' }] as any);
    const probe = setup(() => {});

    probe.get().watch('first');
    await vi.advanceTimersByTimeAsync(0);
    probe.get().watch('second');
    await vi.advanceTimersByTimeAsync(0);

    const collections = vi.mocked(api.listSearchIndexes).mock.calls.map((c) => c[0]);
    expect(collections[collections.length - 1]).toBe('second');
    probe.unmount();
  });

  it('gives up after repeated poll failures instead of hammering', async () => {
    vi.mocked(api.listSearchIndexes).mockRejectedValue(new Error('network'));
    const probe = setup(() => {});

    probe.get().watch('example');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(api.listSearchIndexes).toHaveBeenCalledTimes(3);
    probe.unmount();
  });

  it('unmounting stops the loop', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([{ name: 'a', status: 'BUILDING' }] as any);
    const probe = setup(() => {});

    probe.get().watch('example');
    await vi.advanceTimersByTimeAsync(0);
    probe.unmount();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(api.listSearchIndexes).toHaveBeenCalledTimes(1);
  });
});
