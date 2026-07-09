import { describe, it, expect } from 'vitest';
import { buildReadPrompt, parseReading } from '../src/rossum/annotate/reading.js';

describe('buildReadPrompt', () => {
  const base = {
    fields: [
      { datapointId: 1, schemaId: 'document_id', value: '', inLineItem: false },
      { datapointId: 2, schemaId: 'item_quantity', value: '750', inLineItem: true, mvSchemaId: 'line_items' },
    ],
    schemaFields: [
      { schemaId: 'document_id', label: 'Doc', type: 'string', options: null },
      { schemaId: 'document_type', label: 'Type', type: 'enum', options: [{ value: 'tax_invoice', label: 'Tax invoice' }, { value: 'credit_note', label: 'Credit note' }] },
    ],
    multivalues: { line_items: 900, tax_details: 901 },
    tableColumns: { line_items: ['item_quantity', 'item_uom'], tax_details: ['tax_detail_rate', 'tax_detail_tax'] },
  };
  it('carries the reading contract: verbatim printed quotes, every row, no geometry fields', () => {
    const p = buildReadPrompt(base);
    expect(p).toContain('printed');
    expect(p).toMatch(/verbatim/i);
    expect(p).toMatch(/EVERY table row/);
    expect(p).not.toMatch(/box_words|box_pixels/);
    expect(p).toMatch(/Do NOT call any tools/);
  });
  it('lists header fields and schema-sourced table columns (even for emptied tables)', () => {
    const p = buildReadPrompt(base);
    expect(p).toContain('document_id');
    expect(p).toContain('line_items: item_quantity, item_uom');
    expect(p).toContain('tax_details: tax_detail_rate, tax_detail_tax'); // no fields exist for it
  });
  it('lists enum options for enum header fields', () => {
    const p = buildReadPrompt({ ...base, fields: [{ datapointId: 3, schemaId: 'document_type', value: '', inLineItem: false }] });
    expect(p).toContain('document_type (one of: tax_invoice | credit_note)');
  });
  it('falls back to observed columns when the schema has none', () => {
    const p = buildReadPrompt({ ...base, tableColumns: {} });
    expect(p).toContain('line_items: item_quantity');
    expect(p).toContain('tax_details: (columns unknown)');
  });
});

describe('parseReading', () => {
  it('parses a fenced reading and numbers rows by order', () => {
    const r = parseReading('```json\n{"headers":[{"schema_id":"document_id","value":"123","printed":"123","page":1}],"tables":[{"table":"line_items","rows":[{"cells":[{"schema_id":"item_quantity","value":"750","printed":"750"}]},{"cells":[{"schema_id":"item_quantity","value":"750","printed":"750"}]}]}]}\n```');
    expect(r.headers[0]).toEqual({ schemaId: 'document_id', value: '123', printed: '123', page: 1 });
    expect(r.tables[0].rows.map((x) => x.row)).toEqual([1, 2]);
  });
  it('tolerates prose around an unfenced object', () => {
    const r = parseReading('Here is the reading: {"headers":[{"schema_id":"a","value":"1","printed":null}],"tables":[]} hope that helps');
    expect(r.headers[0].printed).toBeNull();
  });
  it('normalizes empty-string printed to null and drops malformed entries', () => {
    const r = parseReading('{"headers":[{"schema_id":"a","value":"1","printed":"  "},{"value":"no id"}],"tables":[{"table":"t","rows":[{"cells":[{"schema_id":"c","value":"v"}]},{"nope":true}]}]}');
    expect(r.headers).toHaveLength(1);
    expect(r.headers[0].printed).toBeNull();
    expect(r.tables[0].rows).toHaveLength(1);
  });
  it('returns null for garbage or empty readings', () => {
    expect(parseReading('no json here')).toBeNull();
    expect(parseReading('{"headers":[],"tables":[]}')).toBeNull();
  });
});
