// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { h, render } from 'preact';

vi.mock('../src/mdh/api.js');

import * as api from '../src/mdh/api.js';
import Modal from '../src/mdh/components/Modal.jsx';
import { modalContent, selectedCollection } from '../src/mdh/store.js';
import { openBulkUpdate, diffJsonContent } from '../src/mdh/components/BulkUpdate.jsx';

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
  render(h(Modal, null), root);
  activeRoot = root;
  return root;
}
function rerender(root: any) { render(h(Modal, null), root); }
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
// calls in parallel ($count and $limit) and BulkUpdate's useLayoutEffect
// may run more than once under concurrent suite load (e.g. when a signal-
// triggered Modal re-render races with the explicit rerender() the test
// helper performs). Using mockImplementation rather than a fixed-length
// queue of mockResolvedValueOnce keeps the test resilient to those extra
// fires without changing what it asserts. The snapshot-fetch case (a
// plain $match-only pipeline, used by runBulkUpdate for undo) falls
// through to the same sample data.
function mockPreviewAndSnapshot({ count, sample }: any) {
  vi.mocked(api.aggregate).mockImplementation((_coll, pipeline) => {
    if (pipeline.some((s) => s.$count)) {
      return Promise.resolve({ result: [{ total: count }] });
    }
    return Promise.resolve({ result: sample });
  });
}

describe('openBulkUpdate — filter mode', () => {
  it('shows preview with count and sample, and submit calls updateMany', async () => {
    mockPreviewAndSnapshot({ count: 2, sample: [{ _id: '1', status: 'old' }, { _id: '2', status: 'old' }] });
    vi.mocked(api.updateMany).mockResolvedValueOnce({ result: { matched_count: 2, modified_count: 2 } });
    const onSuccess = vi.fn();

    const root = mountModal();
    openBulkUpdate({ collection: 'vendors', mode: 'filter', filter: { status: 'old' }, onSuccess, fieldsFn: () => [] });
    rerender(root);
    await flush();
    rerender(root);

    // Default expression is `{ "$set": {}, "$unset": {} }`. Both blocks are empty,
    // so strip-empties drops them and updateMany sees `{}` on the wire.
    const submitBtn = root.querySelector<HTMLElement>('[data-testid="bulk-submit"]');
    submitBtn!.click();
    await flush();

    expect(api.updateMany).toHaveBeenCalledWith('vendors', { status: 'old' }, {});
    expect(onSuccess).toHaveBeenCalled();
  });

  it('prefills the editor with $set and $unset blocks plus a hint comment', async () => {
    mockPreviewAndSnapshot({ count: 1, sample: [{ _id: '1' }] });

    const root = mountModal();
    openBulkUpdate({ collection: 'vendors', mode: 'filter', filter: {}, onSuccess: () => {}, fieldsFn: () => [] });
    rerender(root);
    await flush();
    rerender(root);

    // The update editor is the second .cm-content in the modal (filter editor is first).
    const editors = root.querySelectorAll('.cm-content');
    expect(editors.length).toBeGreaterThanOrEqual(2);
    const updateEditorText = editors[1].textContent;
    expect(updateEditorText).toContain('$set');
    expect(updateEditorText).toContain('$unset');
    // Parallel hint comments inside each block teach the syntax.
    expect(updateEditorText).toContain('Fields to update');
    expect(updateEditorText).toContain('Fields to remove');
    // The non-obvious bit about $unset is that the value is ignored.
    expect(updateEditorText).toContain('value is ignored');
  });

  it('forces the name-gate when the filter is exactly {}', async () => {
    mockPreviewAndSnapshot({ count: 5, sample: [] });

    const root = mountModal();
    openBulkUpdate({ collection: 'vendors', mode: 'filter', filter: {}, onSuccess: () => {}, fieldsFn: () => [] });
    rerender(root);
    await flush();
    rerender(root);

    // The confirm input mounts after the modal body's async render; poll for it
    // (re-rendering each tick) rather than asserting after a fixed flush, which
    // races the render under full-suite CPU load.
    let input: any;
    await vi.waitFor(() => {
      rerender(root);
      input = root.querySelector('[data-testid="bulk-confirm-input"]');
      expect(input).not.toBeNull();
    }, { timeout: 5000, interval: 20 });
    expect(input.placeholder).toBe('vendors');
  });
});

describe('openBulkUpdate — selection mode', () => {
  it('uses ids→$in filter for updateMany', async () => {
    vi.mocked(api.aggregate)
      .mockResolvedValueOnce({ result: [{ _id: 'a' }, { _id: 'b' }] }) // sample
      .mockResolvedValueOnce({ result: [{ _id: 'a' }, { _id: 'b' }] }); // snapshot
    vi.mocked(api.updateMany).mockResolvedValueOnce({ result: { matched_count: 2, modified_count: 2 } });
    const onSuccess = vi.fn();

    const root = mountModal();
    openBulkUpdate({ collection: 'vendors', mode: 'selection', ids: ['a', 'b'], onSuccess, fieldsFn: () => [] });
    rerender(root);
    await flush();
    rerender(root);

    root.querySelector<HTMLElement>('[data-testid="bulk-submit"]')!.click();
    await flush();

    // Default update is empty `$set` + empty `$unset`, both stripped on submit.
    expect(api.updateMany).toHaveBeenCalledWith('vendors', { _id: { $in: ['a', 'b'] } }, {});
    expect(onSuccess).toHaveBeenCalled();
  });
});

describe('diffJsonContent', () => {
  function renderDiff(doc: any, diff: any) {
    const root = document.createElement('div');
    // Wrapper component so preact owns the children diffing — diffJsonContent
    // returns a mixed array of strings and vnodes, and rendering it via a
    // function component is the most reliable way to mount that shape.
    const Wrapper = () => h('pre', null, ...diffJsonContent(doc, diff));
    render(h(Wrapper, null), root);
    return root;
  }

  it('renders $unset entries as struck-through, danger-tinted lines', () => {
    const doc = { name: 'Acme', legacy: true };
    const diff = { legacy: { from: true, removed: true } };
    const root = renderDiff(doc, diff);

    const removed = root.querySelector('.sample-card-line-removed')!;
    expect(removed).toBeTruthy();
    // Original value is shown so the user sees what's being dropped.
    expect(removed.textContent).toContain('legacy');
    expect(removed.textContent).toContain('true');
    // The unchanged field still appears, untouched.
    expect(root.textContent).toContain('"name": "Acme"');
  });

  it('renders mixed $set + $unset diffs in the same document body', () => {
    const doc = { name: 'Acme', legacy: true };
    const diff = {
      name: { from: 'Acme', to: 'Beta' },
      legacy: { from: true, removed: true },
    };
    const root = renderDiff(doc, diff);

    expect(root.querySelector('.sample-card-line-changed')).toBeTruthy();
    expect(root.querySelector('.sample-card-line-removed')).toBeTruthy();
  });
});
