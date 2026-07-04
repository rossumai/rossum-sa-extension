// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../src/mdh/store.js', () => ({ selectedCollection: { value: 'vendors' } }));
vi.mock('../src/mdh/api.js', () => ({
  find: vi.fn().mockResolvedValue({ result: [] }),
  aggregate: vi.fn().mockResolvedValue({ result: [] }),
  listIndexes: vi.fn().mockResolvedValue({ result: [] }),
  datasetUpdate: vi.fn().mockResolvedValue({ operationId: 'op1' }),
  datasetReplace: vi.fn().mockResolvedValue({ operationId: 'op2' }),
  waitForDatasetOperation: vi.fn().mockResolvedValue({ status: 'finished' }),
}));
vi.mock('../src/mdh/importFile.js', async (orig) => ({ ...(await orig()), runChunkedInsert: vi.fn().mockResolvedValue({ inserted: 2, failedBatches: [], cancelled: false }) }));
// Seed-only textarea stand-in for the CodeMirror editor: the real editable
// JsonEditor treats `value` as a mount-time seed and is read back via
// editorRef.getValue() — this stub mirrors exactly that contract so the
// clipboard flow (typing, submitting, back-navigation restore) is drivable
// under jsdom.
vi.mock('../src/mdh/components/JsonEditor.jsx', async () => {
  const { h } = await import('preact');
  return {
    default: ({ value = '', editorRef, jsonLines }) => h('textarea', {
      'data-testid': 'clipboard-editor',
      'data-jsonlines': jsonLines ? '1' : '0',
      ref: (el) => {
        if (!el) return;
        if (!el._seeded) { el.value = value; el._seeded = true; }
        if (editorRef) editorRef.current = { getValue: () => el.value };
      },
    }),
  };
});

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
    expect(body[0]).not.toHaveProperty('_id');
    expect(body[0].name).toBe('Foo');

    await waitFor(() => api.waitForDatasetOperation.mock.calls.length > 0);
    expect(api.waitForDatasetOperation).toHaveBeenCalledWith('op2', expect.anything());

    expect(runChunkedInsert).not.toHaveBeenCalled();
    expect(api.datasetUpdate).not.toHaveBeenCalled();
  });

  it('Update requires picking a business key and uploads _id-less rows', async () => {
    selectedCollection.value = 'products';
    const docs = [{ _id: '1', __digest_md5: '0'.repeat(32), name: 'Foo' }, { _id: '2', name: 'Bar' }];
    const root = mount(h(ImportWizard, { onSuccess: vi.fn() }));
    await toConfirmViaFile(root, docs);

    const modeUpdate = [...root.querySelectorAll('.csv-seg-opt')].find((b) => b.textContent.trim() === 'Update');
    modeUpdate.click();

    // No auto-default: the go button stays disabled until a key is chosen,
    // and _id is not offered as a suggestion.
    const keyInput = await waitFor(() => root.querySelector('[data-testid="match-key-input"]'));
    expect(root.querySelector('[data-testid="import-go"]').disabled).toBe(true);
    keyInput.focus();
    const items = await waitFor(() => {
      const btns = [...root.querySelectorAll('[data-testid="match-key-suggest"] button')];
      return btns.length ? btns : null;
    });
    expect(items.map((b) => b.textContent.trim())).not.toContain('_id');
    items.find((b) => b.textContent.trim() === 'name').click();

    const goBtn = await waitFor(() => { const b = root.querySelector('[data-testid="import-go"]'); return b && !b.disabled ? b : null; });
    goBtn.click();

    await waitFor(() => api.datasetUpdate.mock.calls.length > 0);
    const [collArg, blobArg, keysArg] = api.datasetUpdate.mock.calls[0];
    expect(collArg).toBe('products');
    expect(keysArg).toEqual(['name']);
    const body = JSON.parse(await blobArg.text());
    expect(body).toHaveLength(docs.length);
    for (const row of body) { expect(row).not.toHaveProperty('_id'); expect(row).not.toHaveProperty('__digest_md5'); }
    expect(body[0].name).toBe('Foo'); // rows otherwise intact

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

});

describe('ImportWizard — shape sampling', () => {
  it('derives the shape from a random $sample aggregation', async () => {
    api.aggregate.mockResolvedValueOnce({ result: [{ sku: 'A', price: 1 }] });
    const root = mount(h(ImportWizard, { onSuccess: vi.fn() }));
    await toConfirmViaFile(root, [{ sku: 'B', price: 2 }]);
    await waitFor(() => api.aggregate.mock.calls.length > 0);
    expect(api.aggregate).toHaveBeenCalledWith('vendors', [{ $sample: { size: 500 } }]);
    expect(api.find).not.toHaveBeenCalled();
  });

  it('falls back to find(limit 500) when $sample fails', async () => {
    api.aggregate.mockRejectedValueOnce(new Error('no $sample'));
    const root = mount(h(ImportWizard, { onSuccess: vi.fn() }));
    await toConfirmViaFile(root, [{ sku: 'B', price: 2 }]);
    await waitFor(() => api.find.mock.calls.length > 0);
    expect(api.find).toHaveBeenCalledWith('vendors', { limit: 500 });
  });
});

describe('ImportWizard — back navigation', () => {
  it('Confirm -> Back returns to Configure with user-tweaked options preserved (CSV)', async () => {
    const root = mount(h(ImportWizard, { onSuccess: vi.fn() }));
    pick(root, file('a;b\n1;2\n', 'rows.csv'));
    await waitFor(() => root.querySelector('[data-testid="csv-options"]'));
    // Detection picked semicolon; the user overrides to comma (their tweak).
    root.querySelector('[data-testid="csv-delim-comma"]').click();
    await waitFor(() => root.querySelector('[data-testid="csv-delim-comma"]').getAttribute('aria-pressed') === 'true');
    const next = await waitFor(() => { const b = root.querySelector('[data-testid="import-next"]'); return b && !b.disabled ? b : null; });
    next.click();
    const back = await waitFor(() => root.querySelector('[data-testid="import-back"]'));
    back.click();
    await waitFor(() => root.querySelector('[data-testid="csv-options"]'));
    // The user's override survived — no re-detection back to semicolon.
    expect(root.querySelector('[data-testid="csv-delim-comma"]').getAttribute('aria-pressed')).toBe('true');
  });

  it('Confirm -> Back returns to Pick for a JSON file (nothing to configure)', async () => {
    const root = mount(h(ImportWizard, { onSuccess: vi.fn() }));
    await toConfirmViaFile(root, [{ sku: 'A' }]);
    const back = await waitFor(() => root.querySelector('[data-testid="import-back"]'));
    back.click();
    await waitFor(() => root.querySelector('.file-input-area'));
    expect(root.querySelector('[data-testid="import-go"]')).toBe(null);
  });

  it('Configure -> Back returns to Pick', async () => {
    const root = mount(h(ImportWizard, { onSuccess: vi.fn() }));
    pick(root, file('a,b\n1,2\n', 'rows.csv'));
    const back = await waitFor(() => root.querySelector('[data-testid="configure-back"]'));
    back.click();
    await waitFor(() => root.querySelector('.file-input-area'));
    expect(root.querySelector('[data-testid="csv-options"]')).toBe(null);
  });

  it('clipboard round-trip: submitted text is restored after Back', async () => {
    const root = mount(h(ImportWizard, { onSuccess: vi.fn() }));
    [...root.querySelectorAll('.csv-seg-opt')].find((b) => b.textContent.trim() === 'Clipboard').click();
    const editor = await waitFor(() => root.querySelector('[data-testid="clipboard-editor"]'));
    expect(editor.getAttribute('data-jsonlines')).toBe('1'); // clipboard editor accepts JSON-lines
    editor.value = '{"a":1}\n{"b":1}';
    root.querySelector('[data-testid="clipboard-next"]').click();
    await waitFor(() => root.querySelector('[data-testid="import-go"]'));
    const back = await waitFor(() => root.querySelector('[data-testid="import-back"]'));
    back.click();
    const restored = await waitFor(() => root.querySelector('[data-testid="clipboard-editor"]'));
    expect(restored.value).toBe('{"a":1}\n{"b":1}');
    // Forward again still works.
    root.querySelector('[data-testid="clipboard-next"]').click();
    await waitFor(() => root.querySelector('[data-testid="import-go"]'));
  });

  it('the chosen import mode survives a Configure round-trip', async () => {
    const root = mount(h(ImportWizard, { onSuccess: vi.fn() }));
    pick(root, file('a,b\n1,2\n', 'rows.csv'));
    const next = await waitFor(() => { const b = root.querySelector('[data-testid="import-next"]'); return b && !b.disabled ? b : null; });
    next.click();
    await waitFor(() => root.querySelector('[data-testid="import-go"]'));
    [...root.querySelectorAll('[data-testid="import-mode"] button, .csv-seg-opt')].find((b) => b.textContent.trim() === 'Replace').click();
    const back = await waitFor(() => root.querySelector('[data-testid="import-back"]'));
    back.click();
    const next2 = await waitFor(() => { const b = root.querySelector('[data-testid="import-next"]'); return b && !b.disabled ? b : null; });
    next2.click();
    await waitFor(() => root.querySelector('[data-testid="import-go"]'));
    const replaceBtn = [...root.querySelectorAll('[data-testid="import-mode"] button, .csv-seg-opt')].find((b) => b.textContent.trim() === 'Replace');
    expect(replaceBtn.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('ImportWizard — shape validation default', () => {
  it('is always ON for a fresh wizard, even after being toggled off in a previous one (no persistence)', async () => {
    const first = mount(h(ImportWizard, { onSuccess: vi.fn() }));
    await toConfirmViaFile(first, [{ sku: 'A' }]);
    const toggle = first.querySelector('[data-testid="shape-toggle"]');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    toggle.click(); // user turns it off for this import
    await waitFor(() => toggle.getAttribute('aria-checked') === 'false');

    // A brand-new wizard (next modal open) must start with validation ON again.
    const second = mount(h(ImportWizard, { onSuccess: vi.fn() }));
    await toConfirmViaFile(second, [{ sku: 'A' }]);
    expect(second.querySelector('[data-testid="shape-toggle"]').getAttribute('aria-checked')).toBe('true');
  });
});
