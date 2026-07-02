// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h } from 'preact';
import { render } from 'preact';
import ImportConfirm from '../src/mdh/components/ImportConfirm.jsx';
import { deriveShape } from '../src/mdh/shape.js';

function mount(vnode) { const el = document.createElement('div'); document.body.appendChild(el); render(vnode, el); return el; }
const docs = [{ sku: 'A1', price: 10 }, { sku: 'B2', price: 20 }];
const base = { fileMeta: { name: 'f.json' }, docs, mode: 'insert', setMode() {}, keys: [], setKeys() {}, validateShape: false, setValidateShape() {}, shape: null, shapeLoading: false, estimate: null, estimateLoading: false, onImport() {}, onCancel() {} };

describe('ImportConfirm', () => {
  it('insert summary counts new documents and enables Go', () => {
    const root = mount(h(ImportConfirm, { ...base, mode: 'insert' }));
    expect(root.querySelector('[data-testid="import-plan"]').textContent).toMatch(/new document/i);
    expect(root.querySelector('[data-testid="import-go"]').disabled).toBe(false);
  });

  it('update requires match keys (Go disabled until a key is chosen)', () => {
    const noKeys = mount(h(ImportConfirm, { ...base, mode: 'update', keys: [] }));
    expect(noKeys.querySelector('[data-testid="import-go"]').disabled).toBe(true);
    const withKeys = mount(h(ImportConfirm, { ...base, mode: 'update', keys: ['sku'] }));
    expect(withKeys.querySelector('[data-testid="import-go"]').disabled).toBe(false);
    expect(withKeys.querySelector('[data-testid="import-plan"]').textContent).toMatch(/upsert|match/i);
  });

  it('replace summary warns it replaces the whole collection', () => {
    const root = mount(h(ImportConfirm, { ...base, mode: 'replace' }));
    expect(root.querySelector('[data-testid="import-plan"]').textContent).toMatch(/entire collection|whole collection/i);
  });

  it('blocks Go with an error-styled panel when shape validation is on and docs do not match', () => {
    const shape = deriveShape([{ sku: 'A1', price: 10, region: 'EU' }]); // requires region
    const root = mount(h(ImportConfirm, { ...base, mode: 'insert', validateShape: true, shape }));
    expect(root.querySelector('[data-testid="import-go"]').disabled).toBe(true);
    const err = root.querySelector('[data-testid="import-shape-error"]');
    expect(err).toBeTruthy();
    expect(err.classList.contains('import-error')).toBe(true); // danger-styled, not the info box
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.textContent).toMatch(/blocked/i);
    expect(err.textContent).toMatch(/region/); // the missing field is named
  });

  it('warns (does not hard-block beyond validation) when existing data is non-uniform', () => {
    const shape = deriveShape([{ sku: 'A1', price: 10 }, { sku: 'B2', price: 20, note: 'x' }]); // note optional -> non-uniform
    const root = mount(h(ImportConfirm, { ...base, mode: 'insert', validateShape: true, shape }));
    expect(root.querySelector('[data-testid="import-shape"]').textContent).toMatch(/uniform/i);
  });

  it('shows the Update matched-vs-insert estimate when available', () => {
    const root = mount(h(ImportConfirm, { ...base, mode: 'update', keys: ['sku'], estimate: { supported: true, matched: 180, willInsert: 20, total: 200 } }));
    const est = root.querySelector('[data-testid="import-estimate"]');
    expect(est.textContent).toMatch(/~180/);
    expect(est.textContent).toMatch(/update/i);
    expect(est.textContent).toMatch(/~20/);
    expect(est.textContent).toMatch(/insert/i);
  });

  it('shows an Estimating placeholder while the estimate loads', () => {
    const loading = mount(h(ImportConfirm, { ...base, mode: 'update', keys: ['sku'], estimateLoading: true }));
    expect(loading.querySelector('[data-testid="import-estimate"]').textContent).toMatch(/estimating/i);
  });

  it('shows a composite estimate naming all match keys', () => {
    const root = mount(h(ImportConfirm, { ...base, mode: 'update', keys: ['sku', 'region'], estimate: { supported: true, matched: 5, willInsert: 2, total: 7 } }));
    const est = root.querySelector('[data-testid="import-estimate"]').textContent;
    expect(est).toMatch(/~5/);
    expect(est).toMatch(/~2/);
    expect(est).toMatch(/sku, region/);
  });
});
