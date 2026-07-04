// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { h } from 'preact';
import { render } from 'preact';
import ImportConfirm from '../src/mdh/components/ImportConfirm.jsx';
import { deriveShape } from '../src/mdh/shape.js';

function mount(vnode) { const el = document.createElement('div'); document.body.appendChild(el); render(vnode, el); return el; }
const docs = [{ sku: 'A1', price: 10 }, { sku: 'B2', price: 20 }];
const base = { fileMeta: { name: 'f.json' }, docs, mode: 'insert', setMode() {}, keys: [], setKeys() {}, validateShape: false, setValidateShape() {}, shape: null, shapeLoading: false, onImport() {}, onCancel() {} };

describe('ImportConfirm', () => {
  it('insert step list explains verified insert behavior and enables Go', () => {
    const root = mount(h(ImportConfirm, { ...base, mode: 'insert' }));
    const t = root.querySelector('[data-testid="import-plan"]').textContent;
    expect(root.querySelector('[data-testid="import-go"]').disabled).toBe(false);
    expect(t).toMatch(/What will happen/i);
    expect(t).toMatch(/added as a new record/i);
    expect(t).toMatch(/never modified/i);
    expect(t).toMatch(/already exists in the collection is rejected/i);
    expect(t).toMatch(/cancelling keeps the rows already inserted/i);
  });

  it('update requires match keys (Go disabled until a key is chosen)', () => {
    const noKeys = mount(h(ImportConfirm, { ...base, mode: 'update', keys: [] }));
    expect(noKeys.querySelector('[data-testid="import-go"]').disabled).toBe(true);
    const withKeys = mount(h(ImportConfirm, { ...base, mode: 'update', keys: ['sku'] }));
    expect(withKeys.querySelector('[data-testid="import-go"]').disabled).toBe(false);
    expect(withKeys.querySelector('[data-testid="import-plan"]').textContent).toMatch(/matched to existing records by sku/i);
  });

  it('update step list explains verified upsert behavior including the _id gotcha', () => {
    const root = mount(h(ImportConfirm, { ...base, mode: 'update', keys: ['sku'] }));
    const t = root.querySelector('[data-testid="import-plan"]').textContent;
    expect(t).toMatch(/matched to existing records by sku/i);
    expect(t).toMatch(/replaced by the row entirely/i);
    expect(t).toMatch(/only one of them is updated/i);
    expect(t).toMatch(/match nothing are inserted/i);
    expect(t).toMatch(/_id.*ignored/i);
    expect(t).toMatch(/can.t be recalled or undone/i); // apostrophe is curly (U+2019) in the copy
  });

  it('multi-key update copy states AND semantics; single-key copy does not', () => {
    const multi = mount(h(ImportConfirm, { ...base, docs: [{ sku: 'A', region: 'EU' }], mode: 'update', keys: ['sku', 'region'] }));
    const t = multi.querySelector('[data-testid="import-plan"]').textContent;
    expect(t).toMatch(/matched to existing records by sku, region/i);
    expect(t).toMatch(/all of them must match at once \(AND, not OR\)/i);
    expect(t).toMatch(/equal in only some of these fields is not a match/i);
    const single = mount(h(ImportConfirm, { ...base, docs: [{ sku: 'A' }], mode: 'update', keys: ['sku'] }));
    expect(single.querySelector('[data-testid="import-plan"]').textContent).not.toMatch(/AND, not OR/);
  });

  it('update step list prompts for keys when none chosen', () => {
    const root = mount(h(ImportConfirm, { ...base, mode: 'update', keys: [] }));
    expect(root.querySelector('[data-testid="import-plan"]').textContent).toMatch(/Choose one or more fields/i);
  });

  it('replace step list explains wipe-and-load including the _id gotcha', () => {
    const root = mount(h(ImportConfirm, { ...base, mode: 'replace' }));
    const t = root.querySelector('[data-testid="import-plan"]').textContent;
    expect(t).toMatch(/Deletes every existing record/i);
    expect(t).toMatch(/Custom indexes are kept/i);
    expect(t).toMatch(/ids from an export are not preserved/i);
  });

  it('blocks Update with the exact missing-key row count', () => {
    const mixed = [{ sku: 'A' }, { name: 'no-key' }, { name: 'also-none' }];
    const root = mount(h(ImportConfirm, { ...base, docs: mixed, mode: 'update', keys: ['sku'] }));
    const guard = root.querySelector('[data-testid="import-key-guard"]');
    expect(guard.textContent).toMatch(/2 rows are missing/);
    expect(guard.textContent).toMatch(/sku/);
    expect(root.querySelector('[data-testid="import-go"]').disabled).toBe(true);
  });

  it('renders a Back button only when onBack is provided, and calls it', () => {
    const onBack = vi.fn();
    const withBack = mount(h(ImportConfirm, { ...base, onBack }));
    const btn = withBack.querySelector('[data-testid="import-back"]');
    expect(btn).toBeTruthy();
    btn.click();
    expect(onBack).toHaveBeenCalledTimes(1);
    const without = mount(h(ImportConfirm, { ...base }));
    expect(without.querySelector('[data-testid="import-back"]')).toBe(null);
  });

  it('shows a clearly-green success panel with the sample size inside it', () => {
    const shape = deriveShape([{ sku: 'A1', price: 10 }]);
    const root = mount(h(ImportConfirm, { ...base, validateShape: true, shape, shapeCount: 137, docs: [{ sku: 'B2', price: 20 }] }));
    const ok = root.querySelector('[data-testid="import-shape-ok"]');
    expect(ok).toBeTruthy();
    expect(ok.classList.contains('import-ok')).toBe(true); // success palette, not a red hint
    expect(ok.textContent).toMatch(/Shape matches/);
    expect(ok.textContent).toMatch(/a random sample of 137 existing records/i);
    // No stray red .input-hint line outside the panel
    expect(root.querySelector('[data-testid="import-shape"] .input-hint')).toBe(null);
  });

  it('says "all N existing records" when the sample covered the whole collection', () => {
    const shape = deriveShape([{ sku: 'A1', price: 10 }]);
    const root = mount(h(ImportConfirm, { ...base, validateShape: true, shape, shapeCount: 150, shapeCoversAll: true, docs: [{ sku: 'B2', price: 20 }] }));
    const ok = root.querySelector('[data-testid="import-shape-ok"]');
    expect(ok.textContent).toMatch(/all 150 existing records/i);
    expect(ok.textContent).not.toMatch(/random sample/i);
  });

  it('shows the sample note inside the red panel on mismatch, and neutral (not red) empty-collection text', () => {
    const shape = deriveShape([{ sku: 'A1', price: 10, region: 'EU' }]);
    const bad = mount(h(ImportConfirm, { ...base, validateShape: true, shape, shapeCount: 42, docs: [{ sku: 'B2', price: 20 }] }));
    expect(bad.querySelector('[data-testid="import-shape-error"]').textContent).toMatch(/a random sample of 42 existing records/i);
    const empty = mount(h(ImportConfirm, { ...base, validateShape: true, shape: null }));
    const neutral = empty.querySelector('[data-testid="import-shape"] .import-shape-neutral');
    expect(neutral).toBeTruthy();
    expect(neutral.textContent).toMatch(/nothing to validate against/i);
    expect(empty.querySelector('[data-testid="import-shape"] .input-hint')).toBe(null);
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

  it('reports a whitespace-only column difference explicitly and visibly', () => {
    const shape = deriveShape([{ sku: 'A1', price: 10 }]);
    const root = mount(h(ImportConfirm, {
      ...base, validateShape: true, shape, shapeCount: 1,
      docs: [{ 'sku ': 'B2', price: 20 }],
    }));
    const err = root.querySelector('[data-testid="import-shape-error"]');
    expect(err.textContent).toMatch(/only by leading\/trailing whitespace/i);
    expect(err.textContent).toMatch(/"sku·"/);      // file side, marked
    expect(err.textContent).toMatch(/"sku"/);            // existing side
    expect(err.querySelector('.mdh-special-space')).toBeTruthy();
    expect(root.querySelector('[data-testid="import-go"]').disabled).toBe(true);
  });

  it('renders Missing/Unexpected names through the whitespace-revealing renderer', () => {
    const shape = deriveShape([{ 'region\u00A0': 'EU' }]); // NBSP (U+00A0) lives in the DB field name
    const root = mount(h(ImportConfirm, {
      ...base, validateShape: true, shape, shapeCount: 1,
      docs: [{ zone: 'EU' }],
    }));
    const err = root.querySelector('[data-testid="import-shape-error"]');
    expect(err.textContent).toContain('NBSP'); // DB-side NBSP made visible in the Missing list
  });

});
