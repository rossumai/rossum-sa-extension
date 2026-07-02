// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../src/mdh/store.js', () => ({ selectedCollection: { value: 'vendors' } }));
vi.mock('../src/mdh/api.js', () => ({
  find: vi.fn().mockResolvedValue({ result: [] }),
  listIndexes: vi.fn().mockResolvedValue({ result: [] }),
  datasetUpdate: vi.fn().mockResolvedValue({ operationId: 'op1' }),
  datasetReplace: vi.fn().mockResolvedValue({ operationId: 'op2' }),
  waitForDatasetOperation: vi.fn().mockResolvedValue({ status: 'finished' }),
}));
vi.mock('../src/mdh/importFile.js', async (orig) => ({ ...(await orig()), runChunkedInsert: vi.fn().mockResolvedValue({ inserted: 2, failedBatches: [], cancelled: false }) }));

import { h, render } from 'preact';
import { selectedCollection } from '../src/mdh/store.js';
import ImportWizard from '../src/mdh/components/ImportWizard.jsx';
import * as api from '../src/mdh/api.js';
import { runChunkedInsert } from '../src/mdh/importFile.js';

function mount(vnode) { const el = document.createElement('div'); document.body.appendChild(el); render(vnode, el); return el; }
async function waitFor(fn, ms = 2000) { const t0 = Date.now(); for (;;) { try { const v = fn(); if (v) return v; } catch {} if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 5)); } }
function file(str, name) { const f = new File([str], name); f.text = async () => str; f.arrayBuffer = async () => new TextEncoder().encode(str).buffer; return f; }
function pick(root, f) {
  const input = root.querySelector('input[type="file"]');
  Object.defineProperty(input, 'files', { value: [f], configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

// Drive the wizard to CONFIRM via file pick with a JSON array, then return root.
async function toConfirmViaFile(root, json) {
  pick(root, file(JSON.stringify(json), 'd.json'));
  await waitFor(() => root.querySelector('[data-testid="import-go"]'));
  return root;
}

beforeEach(() => { vi.clearAllMocks(); selectedCollection.value = 'vendors'; });

describe('ImportWizard — source toggle + detection', () => {
  it('defaults to the File source and shows the source toggle', () => {
    const root = mount(h(ImportWizard, { onSuccess() {} }));
    expect(root.querySelector('[data-testid="import-source"]')).toBeTruthy();
    expect(root.querySelector('.file-input-area')).toBeTruthy();
  });

  it('detects a selected JSON file and reaches confirm', async () => {
    const root = mount(h(ImportWizard, { onSuccess() {} }));
    pick(root, file('[{"_id":"1","a":1}]', 'd.json'));
    await waitFor(() => root.querySelector('[data-testid="import-go"]'));
  });

  it('detects a selected CSV file and reaches the configure stage', async () => {
    const root = mount(h(ImportWizard, { onSuccess() {} }));
    pick(root, file('a,b\n1,2\n', 'rows.csv'));
    await waitFor(() => root.querySelector('[data-testid="csv-options"]'));
  });

  it('rejects an unsupported file type via the click path', async () => {
    const root = mount(h(ImportWizard, { onSuccess() {} }));
    pick(root, file('x', 'notes.txt'));
    await waitFor(() => root.querySelector('.input-hint'));
    expect(root.querySelector('.input-hint').textContent).toMatch(/Unsupported file/i);
  });

  it('switches to Clipboard, shows the JSON editor + Next, and blocks empty input', async () => {
    const root = mount(h(ImportWizard, { onSuccess() {} }));
    const clip = [...root.querySelectorAll('.csv-seg-opt')].find((b) => b.textContent.trim() === 'Clipboard');
    clip.click();
    const next = await waitFor(() => root.querySelector('[data-testid="clipboard-next"]'));
    next.click();
    await waitFor(() => {
      const hint = root.querySelector('.input-hint');
      return hint && /document/i.test(hint.textContent) ? hint : null;
    });
  });

  it('preselects the detected delimiter for a semicolon CSV', async () => {
    const root = mount(h(ImportWizard, { onSuccess() {} }));
    pick(root, file('a;b\n1;2\n', 'rows.csv'));
    const semi = await waitFor(() => root.querySelector('[data-testid="csv-delim-semicolon"]'));
    expect(semi.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('ImportWizard routing', () => {
  it('Insert routes to runChunkedInsert', async () => {
    selectedCollection.value = 'products';
    const docs = [{ _id: '1', name: 'Foo' }, { _id: '2', name: 'Bar' }];
    const root = mount(h(ImportWizard, { onSuccess: vi.fn() }));
    await toConfirmViaFile(root, docs);

    // Mode should default to insert; click go
    const goBtn = root.querySelector('[data-testid="import-go"]');
    expect(goBtn).toBeTruthy();
    goBtn.click();

    await waitFor(() => runChunkedInsert.mock.calls.length > 0);
    expect(runChunkedInsert).toHaveBeenCalledWith('products', expect.any(Array), expect.objectContaining({ signal: expect.anything() }));
    expect(api.datasetUpdate).not.toHaveBeenCalled();
    expect(api.datasetReplace).not.toHaveBeenCalled();
  });

  it('Replace uploads a JSON blob to datasetReplace and polls', async () => {
    selectedCollection.value = 'products';
    const docs = [{ _id: '1', name: 'Foo' }, { _id: '2', name: 'Bar' }];
    const root = mount(h(ImportWizard, { onSuccess: vi.fn() }));
    await toConfirmViaFile(root, docs);

    // Switch to Replace mode
    const modeReplace = [...root.querySelectorAll('[data-testid="import-mode"] button, [aria-label="Import mode"] button, .csv-seg-opt')]
      .find((b) => b.textContent.trim() === 'Replace');
    expect(modeReplace).toBeTruthy();
    modeReplace.click();

    // Wait for the button label to update to replace mode
    await waitFor(() => {
      const btn = root.querySelector('[data-testid="import-go"]');
      return btn && !btn.disabled ? btn : null;
    });

    const goBtn = root.querySelector('[data-testid="import-go"]');
    goBtn.click();

    await waitFor(() => api.datasetReplace.mock.calls.length > 0);
    const [collArg, blobArg] = api.datasetReplace.mock.calls[0];
    expect(collArg).toBe('products');
    expect(blobArg).toBeInstanceOf(Blob);
    const body = JSON.parse(await blobArg.text());
    expect(body).toHaveLength(docs.length);
    expect(body[0]._id).toBe('1');

    await waitFor(() => api.waitForDatasetOperation.mock.calls.length > 0);
    expect(api.waitForDatasetOperation).toHaveBeenCalledWith('op2', expect.anything());

    expect(runChunkedInsert).not.toHaveBeenCalled();
    expect(api.datasetUpdate).not.toHaveBeenCalled();
  });

  it('Update uploads a JSON blob to datasetUpdate with keys and polls', async () => {
    selectedCollection.value = 'products';
    const docs = [{ _id: '1', name: 'Foo' }, { _id: '2', name: 'Bar' }];
    const root = mount(h(ImportWizard, { onSuccess: vi.fn() }));
    await toConfirmViaFile(root, docs);

    // Switch to Update mode
    const modeUpdate = [...root.querySelectorAll('.csv-seg-opt')]
      .find((b) => b.textContent.trim() === 'Update');
    expect(modeUpdate).toBeTruthy();
    modeUpdate.click();

    // Wait for update mode to render (keys should be auto-selected to _id since all docs have _id)
    const goBtn = await waitFor(() => {
      const btn = root.querySelector('[data-testid="import-go"]');
      return btn && !btn.disabled ? btn : null;
    });
    goBtn.click();

    await waitFor(() => api.datasetUpdate.mock.calls.length > 0);
    const [collArg, blobArg, keysArg] = api.datasetUpdate.mock.calls[0];
    expect(collArg).toBe('products');
    expect(blobArg).toBeInstanceOf(Blob);
    const body = JSON.parse(await blobArg.text());
    expect(body).toHaveLength(docs.length);
    expect(keysArg).toContain('_id');

    await waitFor(() => api.waitForDatasetOperation.mock.calls.length > 0);
    expect(api.waitForDatasetOperation).toHaveBeenCalledWith('op1', expect.anything());

    expect(runChunkedInsert).not.toHaveBeenCalled();
    expect(api.datasetReplace).not.toHaveBeenCalled();
  });

  it('cancelling an in-flight Replace shows a cancelled state, not "Import failed"', async () => {
    selectedCollection.value = 'products';
    // The poll rejects when the wizard aborts it (mimics a real user cancel).
    api.waitForDatasetOperation.mockImplementationOnce((id, { signal }) => new Promise((_, reject) => {
      if (signal.aborted) reject(new Error('Operation polling aborted'));
      else signal.addEventListener('abort', () => reject(new Error('Operation polling aborted')));
    }));
    const root = mount(h(ImportWizard, { onSuccess: vi.fn() }));
    await toConfirmViaFile(root, [{ _id: '1', name: 'Foo' }]);

    const modeReplace = [...root.querySelectorAll('[data-testid="import-mode"] button, .csv-seg-opt')]
      .find((b) => b.textContent.trim() === 'Replace');
    modeReplace.click();
    const goBtn = await waitFor(() => { const b = root.querySelector('[data-testid="import-go"]'); return b && !b.disabled ? b : null; });
    goBtn.click();

    // Once the server-processing (indeterminate) stage shows, click "Stop watching".
    const cancelBtn = await waitFor(() => {
      if (!root.querySelector('.import-progress-fill.indeterminate')) return null;
      return [...root.querySelectorAll('.modal-actions button')].find((b) => b.textContent.trim() === 'Stop watching') || null;
    });
    cancelBtn.click();

    await waitFor(() => (/Cancelled/i.test(root.textContent) ? true : null));
    expect(root.textContent).not.toMatch(/Import failed/i);
  });

  it('Update shows a matched-vs-insert estimate from the chosen key', async () => {
    selectedCollection.value = 'products';
    // Branch the shared find mock: shape sample (no key query) → empty (no shape,
    // no block); estimate probe ({_id:{$in}}) → only _id '1' exists.
    api.find.mockImplementation((_coll, opts = {}) => {
      const q = opts.query || {};
      if (q._id && q._id.$in) return Promise.resolve({ result: [{ _id: '1' }] });
      return Promise.resolve({ result: [] });
    });
    const docs = [{ _id: '1', name: 'Foo' }, { _id: '2', name: 'Bar' }];
    const root = mount(h(ImportWizard, { onSuccess: vi.fn() }));
    await toConfirmViaFile(root, docs);

    const modeUpdate = [...root.querySelectorAll('.csv-seg-opt')].find((b) => b.textContent.trim() === 'Update');
    modeUpdate.click();

    const est = await waitFor(() => {
      const el = root.querySelector('[data-testid="import-estimate"]');
      return el && /~1\b/.test(el.textContent) ? el : null;
    }, 3000);
    expect(est.textContent).toMatch(/update/i); // 1 matches _id '1' → update
    expect(est.textContent).toMatch(/insert/i); // 1 new (_id '2') → insert

    api.find.mockReset();
    api.find.mockResolvedValue({ result: [] });
  });
});
