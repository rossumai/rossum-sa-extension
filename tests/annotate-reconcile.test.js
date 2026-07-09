import { describe, it, expect } from 'vitest';
import { dateCandidates, parseNumberLoose, sameValueLoose, enumCanonical, reconcileReading } from '../src/rossum/annotate/reconcile.js';

describe('parseNumberLoose', () => {
  it('understands grouping and decimal separators', () => {
    expect(parseNumberLoose('1,000.50')).toBe(1000.5);
    expect(parseNumberLoose('1.000,50')).toBe(1000.5);
    expect(parseNumberLoose('1000.50')).toBe(1000.5);
    expect(parseNumberLoose('1000,5')).toBe(1000.5);
    expect(parseNumberLoose('750')).toBe(750);
  });
  it('never digits-only guesses', () => {
    expect(parseNumberLoose('(1000)')).toBeNull();
    expect(parseNumberLoose('1000CR')).toBeNull();
  });
});

describe('dateCandidates / sameValueLoose', () => {
  it('treats format-only date differences as equal (the probe cases)', () => {
    expect(sameValueLoose('2025-01-06', '1/6/2025')).toBe(true);
    expect(sameValueLoose('2025-02-06', '2/6/2025')).toBe(true);
    expect(sameValueLoose('2025-01-06', 'Jan 6, 2025')).toBe(true);
    expect(sameValueLoose('2025-01-06', '6.1.2025')).toBe(true); // D/M/Y reading
  });
  it('distinct dates stay material', () => {
    expect(sameValueLoose('2025-01-06', '2/7/2025')).toBe(false);
  });
  it('numbers: format-tolerant but value-exact', () => {
    expect(sameValueLoose('5060.00', '5060,00')).toBe(true);
    expect(sameValueLoose('1.5', '15')).toBe(false); // the digits-only trap
    expect(sameValueLoose('10', '10%')).toBe(false); // % is not a number format — material? no:
  });
  it('case-insensitive strings; empty vs non-empty is material', () => {
    expect(sameValueLoose('USD', 'usd')).toBe(true);
    expect(sameValueLoose('x', '')).toBe(false);
  });
  it('dateCandidates covers ISO, both slash orders, month names', () => {
    expect([...dateCandidates('1/6/2025')].sort()).toEqual(['2025-01-06', '2025-06-01']);
    expect([...dateCandidates('Jan 6, 2025')]).toEqual(['2025-01-06']);
    expect([...dateCandidates('6 Jan 2025')]).toEqual(['2025-01-06']);
  });
});

describe('enumCanonical', () => {
  const sf = { options: [{ value: 'tax_invoice', label: 'Tax invoice' }, { value: 'credit_note', label: 'Credit note' }] };
  it('maps exact value or label, case-insensitively', () => {
    expect(enumCanonical('TAX_INVOICE', sf)).toBe('tax_invoice');
    expect(enumCanonical('credit note', sf)).toBe('credit_note');
  });
  it('returns null for unmappable reads (never fuzzy)', () => {
    expect(enumCanonical('invoice', sf)).toBeNull();
  });
  it('returns undefined for non-enum fields', () => {
    expect(enumCanonical('x', { options: null })).toBeUndefined();
  });
});

// --- reconcileReading ---
const W = (text, x, y, w = 30, h = 20) => ({ text, position: [x, y, x + w, y + h] });
const page = { page: 1, width: 500, height: 400, words: [
  W('INV-1', 100, 20), W('750', 145, 100), W('hours', 218, 100), W('750', 145, 130), W('hours', 218, 130),
] };
const hdr = (over = {}) => ({ datapointId: 1, schemaId: 'document_id', value: '', position: null, page: 1, inLineItem: false, ...over });
const cell = (dp, row, sid, over = {}) => ({ datapointId: dp, schemaId: sid, value: '', position: null, page: 1, inLineItem: true, mvSchemaId: 'line_items', rowIndex: row, ...over });

describe('reconcileReading — headers', () => {
  it('fills an empty header with value + located box', () => {
    const { changes } = reconcileReading(
      { headers: [{ schemaId: 'document_id', value: 'INV-1', printed: 'INV-1', page: 1 }], tables: [] },
      { fields: [hdr()], ocrPages: [page], schemaFields: [] },
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ datapointId: 1, newValue: 'INV-1', valueChanged: true, boxChanged: true, boxSource: 'ocr' });
  });
  it('does NOT write format-only differences (dates)', () => {
    const { changes } = reconcileReading(
      { headers: [{ schemaId: 'document_id', value: '2025-01-06', printed: 'Jan 6, 2025', page: 1 }], tables: [] },
      { fields: [hdr({ value: '1/6/2025', position: [1, 1, 2, 2] })], ocrPages: [page], schemaFields: [] },
    );
    expect(changes).toEqual([]);
  });
  it('writes a MATERIAL disagreement even on an unflagged valued field', () => {
    const { changes } = reconcileReading(
      { headers: [{ schemaId: 'document_id', value: 'INV-1', printed: 'INV-1', page: 1 }], tables: [] },
      { fields: [hdr({ value: 'INV-9', position: [1, 1, 2, 2] })], ocrPages: [page], schemaFields: [] },
    );
    expect(changes[0]).toMatchObject({ newValue: 'INV-1', valueChanged: true });
  });
  it('adds a box-only change for a valued boxless field whose quote locates', () => {
    const { changes } = reconcileReading(
      { headers: [{ schemaId: 'document_id', value: 'INV-1', printed: 'INV-1', page: 1 }], tables: [] },
      { fields: [hdr({ value: 'INV-1' })], ocrPages: [page], schemaFields: [] },
    );
    expect(changes[0]).toMatchObject({ valueChanged: false, boxChanged: true });
  });
  it('enum conservatism: unmappable read → untouched; exact option → written', () => {
    const sfs = [{ schemaId: 'document_type', options: [{ value: 'tax_invoice', label: 'Tax invoice' }] }];
    const f = { ...hdr({ schemaId: 'document_type' }) };
    const r1 = reconcileReading({ headers: [{ schemaId: 'document_type', value: 'invoice', printed: null, page: 1 }], tables: [] },
      { fields: [f], ocrPages: [page], schemaFields: sfs });
    expect(r1.changes).toEqual([]);
    const r2 = reconcileReading({ headers: [{ schemaId: 'document_type', value: 'Tax invoice', printed: null, page: 1 }], tables: [] },
      { fields: [f], ocrPages: [page], schemaFields: sfs });
    expect(r2.changes[0]).toMatchObject({ newValue: 'tax_invoice' });
  });
  it('skips unknown or ambiguous header schema ids', () => {
    const { changes } = reconcileReading(
      { headers: [{ schemaId: 'nope', value: 'x', printed: null, page: 1 }], tables: [] },
      { fields: [hdr()], ocrPages: [page], schemaFields: [] },
    );
    expect(changes).toEqual([]);
  });
});

describe('reconcileReading — refined values outrank the reading', () => {
  it('never writes the page value back over a validation-driven correction', () => {
    // Page prints INV-1 but master data demanded INV-2 (a refine turn set it).
    const { changes } = reconcileReading(
      { headers: [{ schemaId: 'document_id', value: 'INV-1', printed: 'INV-1', page: 1 }], tables: [] },
      { fields: [hdr({ value: 'INV-2', position: [1, 1, 2, 2] })], ocrPages: [page], schemaFields: [], skipValueIds: new Set([1]) },
    );
    expect(changes).toEqual([]); // no oscillation
  });
});

describe('reconcileReading — tables', () => {
  const reading = { headers: [], tables: [{ table: 'line_items', rows: [
    { row: 1, cells: [{ schemaId: 'item_quantity', value: '750', printed: '750' }, { schemaId: 'item_uom', value: 'hours', printed: 'hours' }] },
    { row: 2, cells: [{ schemaId: 'item_quantity', value: '750', printed: '750' }, { schemaId: 'item_uom', value: 'hours', printed: 'hours' }] },
  ] }] };
  it('fills empty cells with per-row DISTINCT located boxes (repeated values)', () => {
    const fields = [cell(11, 1, 'item_quantity'), cell(12, 1, 'item_uom'), cell(21, 2, 'item_quantity'), cell(22, 2, 'item_uom')];
    const { changes, addRows } = reconcileReading(reading, { fields, ocrPages: [page], schemaFields: [] });
    expect(addRows).toEqual([]);
    const qty = changes.filter((c) => c.schemaId === 'item_quantity');
    expect(qty).toHaveLength(2);
    expect(qty[0].newBox[1]).not.toBe(qty[1].newBox[1]); // different rows → different lines
  });
  it('rows beyond the annotation become addRows (values only)', () => {
    const fields = [cell(11, 1, 'item_quantity', { value: '750' }), cell(12, 1, 'item_uom', { value: 'hours' })];
    const { addRows } = reconcileReading(reading, { fields, ocrPages: [page], schemaFields: [] });
    expect(addRows).toEqual([{ table: 'line_items', cells: [{ schemaId: 'item_quantity', value: '750' }, { schemaId: 'item_uom', value: 'hours' }] }]);
  });
  it('is idempotent: agreeing values with existing boxes produce no changes', () => {
    const fields = [
      cell(11, 1, 'item_quantity', { value: '750', position: [144, 99, 176, 121] }),
      cell(12, 1, 'item_uom', { value: 'hours', position: [217, 99, 249, 121] }),
      cell(21, 2, 'item_quantity', { value: '750', position: [144, 129, 176, 151] }),
      cell(22, 2, 'item_uom', { value: 'hours', position: [217, 129, 249, 151] }),
    ];
    const { changes, addRows } = reconcileReading(reading, { fields, ocrPages: [page], schemaFields: [] });
    expect(changes).toEqual([]);
    expect(addRows).toEqual([]);
  });
  it('never deletes: fewer read rows than annotation rows leaves extras alone', () => {
    const one = { headers: [], tables: [{ table: 'line_items', rows: [reading.tables[0].rows[0]] }] };
    const fields = [cell(11, 1, 'item_quantity', { value: '750', position: [1, 1, 2, 2] }), cell(21, 2, 'item_quantity', { value: '99', position: [3, 3, 4, 4] })];
    const { changes } = reconcileReading(one, { fields, ocrPages: [page], schemaFields: [] });
    expect(changes.filter((c) => c.datapointId === 21)).toEqual([]);
  });
});
