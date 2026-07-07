// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { h } from 'preact';
import { render } from 'preact';
import ImportConfirm from '../src/mdh/components/ImportConfirm.jsx';
import { deriveShape } from '../src/mdh/shape.js';

function mount(vnode) { const el = document.createElement('div'); document.body.appendChild(el); render(vnode, el); return el; }
async function waitFor(fn, ms = 2000) { const t0 = Date.now(); for (;;) { try { const v = fn(); if (v) return v; } catch {} if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 5)); } }
async function openPlan(root) {
  (await waitFor(() => root.querySelector('[data-testid="import-summary-toggle"]'))).click();
  return waitFor(() => root.querySelector('[data-testid="import-plan"]'));
}
const docs = [{ sku: 'A1', price: 10 }, { sku: 'B2', price: 20 }];
const base = { docs, mode: 'insert', setMode() {}, keys: [], setKeys() {}, shapeOverride: false, setShapeOverride() {}, shapeError: false, shape: null, shapeLoading: false, onImport() {}, onCancel() {} };

describe('ImportConfirm', () => {
  it('insert step list explains verified insert behavior and enables Go', async () => {
    const root = mount(h(ImportConfirm, { ...base, mode: 'insert' }));
    expect(root.querySelector('[data-testid="import-go"]').disabled).toBe(false);
    await openPlan(root);
    const t = root.querySelector('[data-testid="import-plan"]').textContent;
    expect(t).toMatch(/added as a new record/i);
    expect(t).toMatch(/never modified/i);
    expect(t).toMatch(/already exists in the collection is rejected/i);
    expect(t).toMatch(/cancelling keeps the rows already inserted/i);
  });

  it('update requires match keys (Go disabled until a key is chosen)', async () => {
    const noKeys = mount(h(ImportConfirm, { ...base, mode: 'update', keys: [] }));
    expect(noKeys.querySelector('[data-testid="import-go"]').disabled).toBe(true);
    const withKeys = mount(h(ImportConfirm, { ...base, mode: 'update', keys: ['sku'] }));
    expect(withKeys.querySelector('[data-testid="import-go"]').disabled).toBe(false);
    await openPlan(withKeys);
    expect(withKeys.querySelector('[data-testid="import-plan"]').textContent).toMatch(/matched to existing records by sku/i);
  });

  it('update step list explains verified upsert behavior including the _id gotcha', async () => {
    const root = mount(h(ImportConfirm, { ...base, mode: 'update', keys: ['sku'] }));
    await openPlan(root);
    const t = root.querySelector('[data-testid="import-plan"]').textContent;
    expect(t).toMatch(/matched to existing records by sku/i);
    expect(t).toMatch(/replaced by the row entirely/i);
    expect(t).toMatch(/only one of them is updated/i);
    expect(t).toMatch(/match nothing are inserted/i);
    expect(t).toMatch(/_id.*ignored/i);
    expect(t).toMatch(/can.t be recalled or undone/i); // apostrophe is curly (U+2019) in the copy
  });

  it('multi-key update copy states AND semantics; single-key copy does not', async () => {
    const multi = mount(h(ImportConfirm, { ...base, docs: [{ sku: 'A', region: 'EU' }], mode: 'update', keys: ['sku', 'region'] }));
    await openPlan(multi);
    const t = multi.querySelector('[data-testid="import-plan"]').textContent;
    expect(t).toMatch(/matched to existing records by sku, region/i);
    expect(t).toMatch(/all of them must match at once \(AND, not OR\)/i);
    expect(t).toMatch(/equal in only some of these fields is not a match/i);
    const single = mount(h(ImportConfirm, { ...base, docs: [{ sku: 'A' }], mode: 'update', keys: ['sku'] }));
    await openPlan(single);
    expect(single.querySelector('[data-testid="import-plan"]').textContent).not.toMatch(/AND, not OR/);
  });

  it('update step list prompts for keys when none chosen', async () => {
    const root = mount(h(ImportConfirm, { ...base, mode: 'update', keys: [] }));
    await openPlan(root);
    expect(root.querySelector('[data-testid="import-plan"]').textContent).toMatch(/Choose one or more fields/i);
    expect(root.querySelector('[data-testid="import-summary"]').textContent).toMatch(/Pick one or more fields above/i);
  });

  it('replace step list explains wipe-and-load including the _id gotcha', async () => {
    const root = mount(h(ImportConfirm, { ...base, mode: 'replace' }));
    await openPlan(root);
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

  it('summary sentence: insert states count and never-modified', () => {
    const root = mount(h(ImportConfirm, { ...base, mode: 'insert' }));
    expect(root.querySelector('[data-testid="import-summary"]').textContent)
      .toBe('Adds 2 new records — existing records are never modified.');
  });

  it('summary sentence: insert mentions dropped duplicate _id rows only when true', () => {
    const dup = [{ _id: 1, a: 1 }, { _id: 1, a: 2 }, { _id: 2, a: 3 }];
    const root = mount(h(ImportConfirm, { ...base, docs: dup, mode: 'insert' }));
    expect(root.querySelector('[data-testid="import-summary"]').textContent)
      .toBe('Adds 2 new records — existing records are never modified. (1 duplicate _id row dropped.)');
    const clean = mount(h(ImportConfirm, { ...base, mode: 'insert' }));
    expect(clean.querySelector('[data-testid="import-summary"]').textContent).not.toContain('duplicate');
  });

  it('summary sentence: update states keys, whole-row replace, server, no undo', () => {
    const root = mount(h(ImportConfirm, { ...base, mode: 'update', keys: ['sku'] }));
    expect(root.querySelector('[data-testid="import-summary"]').textContent)
      .toBe('Upserts 2 rows matched by sku — matched records are replaced whole, unmatched rows are inserted. Runs on the server; can’t be undone.');
  });

  it('summary sentence: multi-key update appends (all must match)', () => {
    const root = mount(h(ImportConfirm, { ...base, docs: [{ sku: 'A', region: 'EU' }], mode: 'update', keys: ['sku', 'region'] }));
    expect(root.querySelector('[data-testid="import-summary"]').textContent).toContain('matched by sku + region (all must match)');
  });

  it('summary sentence: replace states wipe-and-load and no undo', () => {
    const root = mount(h(ImportConfirm, { ...base, mode: 'replace' }));
    expect(root.querySelector('[data-testid="import-summary"]').textContent)
      .toBe('Deletes every existing record, then loads these 2 rows as the collection’s new contents. Can’t be undone.');
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

  it('shows a muted one-line pass state with the sample size', () => {
    const shape = deriveShape([{ sku: 'A1', price: 10 }]);
    const root = mount(h(ImportConfirm, { ...base, shape, shapeCount: 137, docs: [{ sku: 'B2', price: 20 }] }));
    const ok = root.querySelector('[data-testid="import-shape-ok"]');
    expect(ok.textContent).toMatch(/Shape matches/);
    expect(ok.textContent).toMatch(/checked against a 137-record random sample/i);
    expect(root.querySelector('[data-testid="import-shape-error"]')).toBe(null);
  });

  it('says "all N existing records" when the sample covered the whole collection', () => {
    const shape = deriveShape([{ sku: 'A1', price: 10 }]);
    const root = mount(h(ImportConfirm, { ...base, shape, shapeCount: 150, shapeCoversAll: true, docs: [{ sku: 'B2', price: 20 }] }));
    expect(root.querySelector('[data-testid="import-shape-ok"]').textContent).toMatch(/checked against all 150 existing records/i);
  });

  it('empty collection: no shape UI on screen, a skip note inside Details', async () => {
    const root = mount(h(ImportConfirm, { ...base, shape: null }));
    expect(root.querySelector('[data-testid="import-shape-ok"]')).toBe(null);
    expect(root.querySelector('[data-testid="import-shape-error"]')).toBe(null);
    await openPlan(root);
    expect(root.querySelector('[data-testid="import-plan"]').textContent).toMatch(/shape check skipped/i);
  });

  it('shape fetch failure: unavailable note inside Details', async () => {
    const root = mount(h(ImportConfirm, { ...base, shape: null, shapeError: true }));
    await openPlan(root);
    expect(root.querySelector('[data-testid="import-plan"]').textContent).toMatch(/Shape check unavailable/i);
  });

  it('shows the sample note inside the red panel on mismatch', () => {
    const shape = deriveShape([{ sku: 'A1', price: 10, region: 'EU' }]);
    const bad = mount(h(ImportConfirm, { ...base, shape, shapeCount: 42, docs: [{ sku: 'B2', price: 20 }] }));
    expect(bad.querySelector('[data-testid="import-shape-error"]').textContent).toMatch(/a random sample of 42 existing records/i);
  });

  it('blocks Go with an error-styled panel when docs do not match the shape', () => {
    const shape = deriveShape([{ sku: 'A1', price: 10, region: 'EU' }]); // requires region
    const root = mount(h(ImportConfirm, { ...base, mode: 'insert', shape }));
    expect(root.querySelector('[data-testid="import-go"]').disabled).toBe(true);
    const err = root.querySelector('[data-testid="import-shape-error"]');
    expect(err).toBeTruthy();
    expect(err.classList.contains('import-error')).toBe(true); // danger-styled, not the info box
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.textContent).toMatch(/blocked/i);
    expect(err.textContent).toMatch(/region/); // the missing field is named
  });

  it('non-uniform + mismatching docs: the error card warns about over-rejection', () => {
    const shape = deriveShape([{ sku: 'A1', price: 10 }, { sku: 'B2', price: 20, note: 'x' }]); // note optional -> non-uniform
    const root = mount(h(ImportConfirm, { ...base, mode: 'insert', shape }));
    const err = root.querySelector('[data-testid="import-shape-error"]');
    expect(err).toBeTruthy();
    expect(err.textContent).toMatch(/may over-reject/i);
  });

  it('non-uniform + matching docs: only the pass line renders, no uniform warning', () => {
    const shape = deriveShape([{ sku: 'A1', price: 10 }, { sku: 'B2', note: 'y' }]); // price/note optional -> non-uniform
    const root = mount(h(ImportConfirm, { ...base, mode: 'insert', shape, docs: [{ sku: 'C3', price: 5, note: 'w' }] }));
    expect(root.querySelector('[data-testid="import-shape-ok"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="import-shape-error"]')).toBe(null);
    expect(root.textContent).not.toMatch(/uniform/i);
  });

  it('reports a whitespace-only column difference explicitly and visibly', () => {
    const shape = deriveShape([{ sku: 'A1', price: 10 }]);
    const root = mount(h(ImportConfirm, {
      ...base, shape, shapeCount: 1,
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
    const shape = deriveShape([{ 'region ': 'EU' }]); // NBSP (U+00A0) lives in the DB field name
    const root = mount(h(ImportConfirm, {
      ...base, shape, shapeCount: 1,
      docs: [{ zone: 'EU' }],
    }));
    const err = root.querySelector('[data-testid="import-shape-error"]');
    expect(err.textContent).toContain('NBSP'); // DB-side NBSP made visible in the Missing list
  });

  it('the acknowledgement checkbox overrides the mismatch and keeps the error visible', () => {
    const shape = deriveShape([{ sku: 'A1', price: 10, region: 'EU' }]);
    let override = false;
    const setShapeOverride = (v) => { override = v; };
    const root = mount(h(ImportConfirm, { ...base, mode: 'insert', shape, setShapeOverride }));
    const box = root.querySelector('[data-testid="shape-override"]');
    expect(box.getAttribute('type')).toBe('checkbox');
    expect(box.checked).toBe(false);
    expect(root.querySelector('[data-testid="import-go"]').disabled).toBe(true);
    box.click(); // ticking the box acknowledges the mismatch
    expect(override).toBe(true);
    // With the box checked, the FULL error card stays visible and Go is enabled —
    // it is not collapsed to a one-line "overridden" note.
    const over = mount(h(ImportConfirm, { ...base, mode: 'insert', shape, shapeOverride: true }));
    const err = over.querySelector('[data-testid="import-shape-error"]');
    expect(err).toBeTruthy();
    expect(err.textContent).toMatch(/blocked/i);
    expect(over.querySelector('[data-testid="shape-override"]').checked).toBe(true);
    expect(over.querySelector('[data-testid="import-go"]').disabled).toBe(false);
    expect(over.querySelector('[data-testid="shape-overridden"]')).toBe(null);
  });

});
