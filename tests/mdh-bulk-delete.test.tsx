// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { h, render } from 'preact';

vi.mock('../src/mdh/api.js');

import * as api from '../src/mdh/api.js';
import Modal from '../src/mdh/components/Modal.jsx';
import { modalContent, selectedCollection } from '../src/mdh/store.js';
import { openBulkDelete } from '../src/mdh/components/BulkDelete.jsx';

// `activeRoot` tracks the currently-mounted modal so afterEach can call
// render(null, root) to actually unmount it. Without that, every test leaks
// a Modal instance — still subscribed to modalContent — and the next test's
// signal write fans out to all of them, double-mounting Body and consuming
// extra mock values (root cause of the historic flake on this file).
let activeRoot: any = null;
function mountModal() {
  if (activeRoot) { render(null, activeRoot); activeRoot = null; }
  document.body.innerHTML = '';
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(<Modal />, root);
  activeRoot = root;
  return root;
}

function rerender(root: any) { render(<Modal />, root); }

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  modalContent.value = null;
  selectedCollection.value = 'vendors';
});

afterEach(() => {
  if (activeRoot) { render(null, activeRoot); activeRoot = null; }
});

// Repeatable mock for preview queries. previewMatch fires two aggregate
// calls in parallel ($count and $limit) and BulkDelete's useLayoutEffect
// may run more than once under concurrent suite load (e.g. when a signal-
// triggered Modal re-render races with the explicit rerender() the test
// helper performs). Using mockImplementation rather than a fixed-length
// queue of mockResolvedValueOnce keeps the test resilient to those extra
// fires without changing what it asserts.
function mockPreview({ count, sample }: any) {
  vi.mocked(api.aggregate).mockImplementation((_coll, pipeline) => {
    if (pipeline.some((s) => s.$count)) {
      return Promise.resolve({ result: [{ total: count }] });
    }
    return Promise.resolve({ result: sample });
  });
}

describe('openBulkDelete — filter mode', () => {
  it('opens with the prefilled filter and runs preview against the API', async () => {
    mockPreview({ count: 3, sample: [{ _id: '1' }, { _id: '2' }, { _id: '3' }] });

    const root = mountModal();
    openBulkDelete({ collection: 'vendors', mode: 'filter', filter: { status: 'draft' }, onSuccess: () => {}, fieldsFn: () => [] });
    rerender(root);
    await flush();
    rerender(root);

    expect(root.querySelector('[data-testid="bulk-preview-count"]')!.textContent).toContain('3');
  });

  it('disables submit while the preview is loading', async () => {
    let resolveCount: any;
    vi.mocked(api.aggregate).mockReturnValueOnce(new Promise((r) => { resolveCount = r; }));
    vi.mocked(api.aggregate).mockResolvedValueOnce({ result: [] });

    const root = mountModal();
    openBulkDelete({ collection: 'vendors', mode: 'filter', filter: {}, onSuccess: () => {}, fieldsFn: () => [] });
    rerender(root);
    await flush();
    rerender(root);

    expect(root.querySelector<HTMLButtonElement>('[data-testid="bulk-submit"]')!.disabled).toBe(true);

    resolveCount({ result: [{ total: 0 }] });
    await flush();
    rerender(root);
    // count = 0 — still disabled, but for a different reason (nothing to delete).
    expect(root.querySelector<HTMLButtonElement>('[data-testid="bulk-submit"]')!.disabled).toBe(true);
  });

  it('forces the name-gate when the filter is exactly {}', async () => {
    mockPreview({ count: 7, sample: [] });

    const root = mountModal();
    openBulkDelete({ collection: 'vendors', mode: 'filter', filter: {}, onSuccess: () => {}, fieldsFn: () => [] });
    rerender(root);
    await flush();
    rerender(root);

    const input = root.querySelector<HTMLInputElement>('[data-testid="bulk-confirm-input"]');
    expect(input!.placeholder).toBe('vendors');
  });
});

describe('openBulkDelete — selection mode', () => {
  it('uses the ids→$in filter and shows the count from ids.length without re-counting', async () => {
    vi.mocked(api.aggregate).mockResolvedValueOnce({ result: [{ _id: 'a' }, { _id: 'b' }] }); // sample only

    const root = mountModal();
    openBulkDelete({ collection: 'vendors', mode: 'selection', ids: ['a', 'b'], onSuccess: () => {}, fieldsFn: () => [] });
    rerender(root);
    await flush();
    rerender(root);

    expect(root.querySelector('[data-testid="bulk-preview-count"]')!.textContent).toContain('2');
    // Selection mode does not call $count — only the sample query.
    expect(api.aggregate).toHaveBeenCalledTimes(1);
  });

  it('runs deleteMany with the $in filter on submit', async () => {
    vi.mocked(api.aggregate)
      .mockResolvedValueOnce({ result: [{ _id: 'a' }, { _id: 'b' }] }) // sample
      .mockResolvedValueOnce({ result: [{ _id: 'a' }, { _id: 'b' }] }); // snapshot
    vi.mocked(api.deleteMany).mockResolvedValueOnce({ result: { deleted_count: 2 } });
    vi.mocked(api.insertMany).mockResolvedValueOnce({ result: {} });
    const onSuccess = vi.fn();

    const root = mountModal();
    openBulkDelete({ collection: 'vendors', mode: 'selection', ids: ['a', 'b'], onSuccess, fieldsFn: () => [] });
    rerender(root);
    await flush();
    rerender(root);

    root.querySelector<HTMLElement>('[data-testid="bulk-submit"]')!.click();
    await flush();

    expect(api.deleteMany).toHaveBeenCalledWith('vendors', { _id: { $in: ['a', 'b'] } });
    expect(onSuccess).toHaveBeenCalled();
  });

  it('preserves $oid wrapper in the $in filter (round-trips through deleteMany)', async () => {
    const oidA = { $oid: '67e8abcd1234567890abcdef' };
    const oidB = { $oid: '67e8abcd1234567890abcdee' };
    vi.mocked(api.aggregate)
      .mockResolvedValueOnce({ result: [{ _id: oidA }, { _id: oidB }] }) // sample
      .mockResolvedValueOnce({ result: [{ _id: oidA }, { _id: oidB }] }); // snapshot
    vi.mocked(api.deleteMany).mockResolvedValueOnce({ result: { deleted_count: 2 } });
    vi.mocked(api.insertMany).mockResolvedValueOnce({ result: {} });

    const root = mountModal();
    openBulkDelete({ collection: 'vendors', mode: 'selection', ids: [oidA, oidB], onSuccess: () => {}, fieldsFn: () => [] });
    rerender(root);
    await flush();
    rerender(root);

    root.querySelector<HTMLElement>('[data-testid="bulk-submit"]')!.click();
    await flush();

    // The $in array must contain the original wrapped objects, not stringified.
    expect(api.deleteMany).toHaveBeenCalledWith('vendors', {
      _id: { $in: [oidA, oidB] },
    });
  });
});
