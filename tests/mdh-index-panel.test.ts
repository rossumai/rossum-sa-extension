// @vitest-environment jsdom
//
// End-to-end behaviour of the regular Indexes panel: Copy emits a create-ready
// { indexName, keys, options } definition, diagnostics badges (type, redundant)
// render, and per-index size + collection totals come from $collStats.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render, Fragment } from 'preact';

vi.mock('../src/mdh/api.js');
vi.mock('../src/mdh/cache.js', () => ({ get: () => null, set: () => {}, invalidate: () => {} }));
// Stub CodeMirror. When used as the create-modal editor it gets an editorRef —
// expose a valid parsed index so the create flow can run; the read-only card
// body passes no editorRef and just renders the stub.
vi.mock('../src/mdh/components/JsonEditor.jsx', () => ({
  default: ({ editorRef }: any) => {
    if (editorRef) {
      editorRef.current = {
        isValid: () => true,
        getParsed: () => ({ indexName: 'new_idx', keys: { a: 1 } }),
        getValue: () => '', setValue: () => {}, getError: () => '', focus: () => {}, refresh: () => {},
      };
    }
    return h('div', { class: 'json-editor-stub' });
  },
}));

import * as api from '../src/mdh/api.js';
import IndexPanel from '../src/mdh/components/IndexPanel.jsx';
import Modal from '../src/mdh/components/Modal.jsx';
import { selectedCollection, activePanel, loading, error, opNotice } from '../src/mdh/store.js';

const writeText = vi.fn().mockResolvedValue(undefined);

function mount() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(IndexPanel, null), root);
  return root;
}

// Mounts the panel + Modal (signal-driven) so the Create Index flow is drivable.
function mountWithModal() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(Fragment, null, h(IndexPanel, null), h(Modal, null)), root);
  return root;
}
function buttonByText(root: any, text: any) {
  return [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
}

function cardByName(root: any, name: any) {
  return [...root.querySelectorAll('.record-card')]
    .find((c) => c.querySelector('.record-summary strong')?.textContent === name);
}
function badgeTexts(el: any) {
  return [...el.querySelectorAll('.index-badge')].map((b) => b.textContent.toLowerCase());
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  writeText.mockClear();
  selectedCollection.value = 'PRODUCTS';
  activePanel.value = 'indexes';
  loading.value = false;
  error.value = null;
  opNotice.value = null;
  // Stats are best-effort; default to a benign resolved value, overridden per test.
  vi.mocked(api.collectionStats).mockResolvedValue({ result: [] });
});

describe('IndexPanel — copy is create-ready', () => {
  it('Copy emits a clean { indexName, keys, options } definition', async () => {
    vi.mocked(api.listIndexes).mockResolvedValue({ result: [
      { v: 2, key: { email: 1 }, name: 'email_1', unique: true },
    ] });
    const root = mount();

    await vi.waitFor(() => expect(root.querySelector('.action-copy')).not.toBeNull());
    root.querySelector<HTMLElement>('.action-copy')!.click();

    expect(writeText).toHaveBeenCalledWith(JSON.stringify(
      { indexName: 'email_1', keys: { email: 1 }, options: { unique: true } }, null, 2,
    ));
  });

  it('copied JSON drops the internal v and is not the raw listed object', async () => {
    vi.mocked(api.listIndexes).mockResolvedValue({ result: [{ v: 2, key: { a: 1 }, name: 'a_1' }] });
    const root = mount();
    await vi.waitFor(() => expect(root.querySelector('.action-copy')).not.toBeNull());
    root.querySelector<HTMLElement>('.action-copy')!.click();
    const parsed = JSON.parse(writeText.mock.calls[0][0]);
    expect(parsed).toEqual({ indexName: 'a_1', keys: { a: 1 } });
    expect(parsed).not.toHaveProperty('v');
  });
});

describe('IndexPanel — diagnostics badges', () => {
  it('shows a type badge for compound but not for single-field indexes', async () => {
    vi.mocked(api.listIndexes).mockResolvedValue({ result: [
      { v: 2, key: { a: 1 }, name: 'a_1' },
      { v: 2, key: { x: 1, y: -1 }, name: 'x_1_y_-1' },
    ] });
    const root = mount();
    await vi.waitFor(() => expect(cardByName(root, 'x_1_y_-1')).toBeTruthy());

    expect(badgeTexts(cardByName(root, 'x_1_y_-1'))).toContain('compound');
    expect(badgeTexts(cardByName(root, 'a_1'))).not.toContain('single');
    expect(badgeTexts(cardByName(root, 'a_1'))).not.toContain('compound');
  });

  it('flags a plain prefix index as redundant', async () => {
    vi.mocked(api.listIndexes).mockResolvedValue({ result: [
      { v: 2, key: { a: 1 }, name: 'a_1' },
      { v: 2, key: { a: 1, b: 1 }, name: 'a_1_b_1' },
    ] });
    const root = mount();
    await vi.waitFor(() => expect(cardByName(root, 'a_1')).toBeTruthy());

    expect(badgeTexts(cardByName(root, 'a_1')).some((t) => t.includes('redundant'))).toBe(true);
    expect(badgeTexts(cardByName(root, 'a_1_b_1')).some((t) => t.includes('redundant'))).toBe(false);
  });
});

describe('IndexPanel — size from $collStats', () => {
  it('shows per-index size and collection totals', async () => {
    vi.mocked(api.listIndexes).mockResolvedValue({ result: [{ v: 2, key: { ALT1: 1 }, name: 'products_alt1_idx' }] });
    vi.mocked(api.collectionStats).mockResolvedValue({ result: [{
      count: 20581, totalIndexSize: 1216512, indexSizes: { _id_: 913408, products_alt1_idx: 303104 },
    }] });
    const root = mount();

    await vi.waitFor(() => expect(cardByName(root, 'products_alt1_idx')).toBeTruthy());
    await vi.waitFor(() => expect(cardByName(root, 'products_alt1_idx').textContent).toContain('296 KB'));
    expect(root.querySelector('.toolbar')!.textContent).toContain('20,581');
  });

  it('degrades silently when $collStats fails', async () => {
    vi.mocked(api.listIndexes).mockResolvedValue({ result: [{ v: 2, key: { a: 1 }, name: 'a_1' }] });
    vi.mocked(api.collectionStats).mockRejectedValue(new Error('not authorized'));
    const root = mount();

    await vi.waitFor(() => expect(cardByName(root, 'a_1')).toBeTruthy());
    expect(error.value).toBeNull();
    expect(cardByName(root, 'a_1').querySelector('.index-card-meta')).toBeNull();
  });
});

describe('IndexPanel — async create surfaces operation outcome', () => {
  // api.post() surfaces the op id from the content-location header as res.operationId.
  const OP_ACCEPT = { code: 'accept', message: '', operationId: 'bb7001c1-89f3-4c61-b29b-a074e5e6f026' };

  async function openAndSubmitCreate(root: any) {
    await vi.waitFor(() => expect(buttonByText(root, '+ Create')).toBeTruthy());
    buttonByText(root, '+ Create').click();
    await vi.waitFor(() => expect(buttonByText(root, 'Create Index')).toBeTruthy());
    buttonByText(root, 'Create Index').click();
  }

  it('sets the red error banner (error.value) when the operation fails', async () => {
    vi.mocked(api.listIndexes).mockResolvedValue({ result: [] });
    vi.mocked(api.createIndex).mockResolvedValue(OP_ACCEPT);
    vi.mocked(api.waitForOperation).mockRejectedValue(new Error('E11000 duplicate key on a:1'));
    const root = mountWithModal();

    await openAndSubmitCreate(root);

    await vi.waitFor(() => expect(error.value).not.toBeNull());
    expect(error.value!.message).toContain('E11000 duplicate key on a:1');
    expect(error.value!.message).toContain('Creating index "new_idx"'); // labelled with context
    expect(opNotice.value).toBeNull(); // in-progress notice cleared
  });

  it('shows an info opNotice while running, then clears it and re-lists on finish', async () => {
    vi.mocked(api.listIndexes).mockResolvedValue({ result: [] });
    vi.mocked(api.createIndex).mockResolvedValue(OP_ACCEPT);
    let resolveOp: any;
    vi.mocked(api.waitForOperation).mockReturnValue(new Promise((r) => { resolveOp = r; }));
    const root = mountWithModal();

    await vi.waitFor(() => expect(buttonByText(root, '+ Create')).toBeTruthy());
    const listCallsBefore = vi.mocked(api.listIndexes).mock.calls.length;
    await openAndSubmitCreate(root);

    await vi.waitFor(() => expect(opNotice.value).toMatchObject({ kind: 'info' }));
    resolveOp({ status: 'FINISHED' });
    await vi.waitFor(() => expect(opNotice.value).toBeNull());
    expect(vi.mocked(api.listIndexes).mock.calls.length).toBeGreaterThan(listCallsBefore); // re-list on finish
  });

  it('clears the in-progress opNotice when the collection changes mid-operation', async () => {
    vi.mocked(api.listIndexes).mockResolvedValue({ result: [] });
    vi.mocked(api.createIndex).mockResolvedValue(OP_ACCEPT);
    vi.mocked(api.waitForOperation).mockReturnValue(new Promise(() => {})); // never resolves → stays RUNNING
    const root = mountWithModal();

    await openAndSubmitCreate(root);
    await vi.waitFor(() => expect(opNotice.value).not.toBeNull());

    selectedCollection.value = 'OTHER_COLLECTION'; // switch collection while the op is in flight
    await vi.waitFor(() => expect(opNotice.value).toBeNull());
  });
});
