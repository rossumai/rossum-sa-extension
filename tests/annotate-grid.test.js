import { describe, it, expect } from 'vitest';
import { parseGridInfo, remapEmptyColumns, linkGridRows, extendGridRows, deriveCellBoxes, buildGridOp } from '../src/rossum/annotate/grid.js';
import { tightenBox } from '../src/rossum/annotate/geometry.js';

// Mirrors the real doc: first column mapped to "code" (whose cells are all EMPTY),
// while "qty" holds the values but has NO column; rows unlinked (tuple_id null).
const grid = { parts: [{
  page: 1, width: 200, height: 60,
  rows: [
    { type: null, tuple_id: null, top_position: 10 },
    { type: null, tuple_id: null, top_position: 30 },
  ],
  columns: [
    { schema_id: 'code', header_texts: [], left_position: 10 },
    { schema_id: 'desc', header_texts: [], left_position: 60 },
  ],
} ] };
const gridInfo = { mvId: 500, schemaId: 'li', grid, tupleIds: [901, 902] };
const fields = [
  { datapointId: 1, schemaId: 'qty', mvSchemaId: 'li', inLineItem: true, rowIndex: 1, page: 1, value: '7', position: null, rirPosition: [12, 11, 28, 19] },
  { datapointId: 2, schemaId: 'qty', mvSchemaId: 'li', inLineItem: true, rowIndex: 2, page: 1, value: '7', position: null, rirPosition: [12, 11, 28, 19] },
  { datapointId: 21, schemaId: 'code', mvSchemaId: 'li', inLineItem: true, rowIndex: 1, page: 1, value: '', position: null, rirPosition: null },
  { datapointId: 22, schemaId: 'code', mvSchemaId: 'li', inLineItem: true, rowIndex: 2, page: 1, value: '', position: null, rirPosition: null },
  { datapointId: 11, schemaId: 'desc', mvSchemaId: 'li', inLineItem: true, rowIndex: 1, page: 1, value: 'a', position: [62, 11, 90, 19], rirPosition: null },
  { datapointId: 12, schemaId: 'desc', mvSchemaId: 'li', inLineItem: true, rowIndex: 2, page: 1, value: 'b', position: [62, 31, 90, 39], rirPosition: null },
];
const ocrPages = [{ page: 1, words: [
  { text: '7', position: [12, 11, 28, 19] }, { text: 'a', position: [62, 11, 90, 19] },
  { text: '7', position: [12, 31, 28, 39] }, { text: 'b', position: [62, 31, 90, 39] },
] }];

describe('parseGridInfo', () => {
  it('extracts grid-backed multivalues with their tuple ids', () => {
    const tree = [{ category: 'multivalue', id: 500, schema_id: 'li', grid, children: [
      { category: 'tuple', id: 901, children: [] }, { category: 'tuple', id: 902, children: [] },
    ] }];
    expect(parseGridInfo(tree)).toEqual([{ mvId: 500, schemaId: 'li', grid, tupleIds: [901, 902] }]);
  });
  it('skips multivalues without a grid', () => {
    expect(parseGridInfo([{ category: 'multivalue', id: 1, schema_id: 'x', children: [] }])).toEqual([]);
  });
});

describe('remapEmptyColumns', () => {
  it('remaps a column whose schema is all-empty to the unmapped valued schema with matching evidence', () => {
    const g = remapEmptyColumns(gridInfo, fields);
    expect(g.parts[0].columns[0].schema_id).toBe('qty'); // code → qty
    expect(g.parts[0].columns[1].schema_id).toBe('desc'); // untouched
    expect(grid.parts[0].columns[0].schema_id).toBe('code'); // input not mutated
  });
  it('does nothing when the column schema has values or evidence is ambiguous', () => {
    const valuedCode = fields.map((f) => (f.schemaId === 'code' ? { ...f, value: 'X' } : f));
    expect(remapEmptyColumns(gridInfo, valuedCode)).toBeNull();
  });
});

describe('linkGridRows', () => {
  it('links rows to tuples 1:1 by order', () => {
    const g = linkGridRows(gridInfo);
    expect(g.parts[0].rows.map((r) => r.tuple_id)).toEqual([901, 902]);
  });
  it('refuses when counts differ', () => {
    expect(linkGridRows({ ...gridInfo, tupleIds: [901] })).toBeNull();
  });
});

describe('extendGridRows', () => {
  it('grows a 1-row grid to cover 3 tuples when 3 text lines exist', () => {
    const smallGrid = { parts: [{ page: 1, width: 60, height: 12,
      rows: [{ type: null, tuple_id: null, top_position: 10 }],
      columns: [{ schema_id: 'rate', header_texts: [], left_position: 10 }] }] };
    const gi = { mvId: 600, schemaId: 'tax', grid: smallGrid, tupleIds: [71, 72, 73] };
    const ocr = [{ page: 1, words: [
      { text: '0%', position: [12, 11, 28, 19] }, { text: '10%', position: [12, 31, 28, 39] }, { text: '20%', position: [12, 51, 28, 59] },
    ] }];
    const g = extendGridRows(gi, ocr);
    expect(g.parts[0].rows).toHaveLength(3);
    expect(g.parts[0].rows.map((r) => r.tuple_id)).toEqual([71, 72, 73]);
    expect(g.parts[0].rows[1].top_position).toBe(30); // line top - 1
  });
  it('refuses when line count does not match tuple count', () => {
    const smallGrid = { parts: [{ page: 1, width: 60, height: 12,
      rows: [{ type: null, tuple_id: null, top_position: 10 }],
      columns: [{ schema_id: 'rate', header_texts: [], left_position: 10 }] }] };
    const gi = { mvId: 600, schemaId: 'tax', grid: smallGrid, tupleIds: [71, 72, 73] };
    const ocr = [{ page: 1, words: [{ text: '0%', position: [12, 11, 28, 19] }] }]; // only 1 line
    expect(extendGridRows(gi, ocr)).toBeNull();
  });
});

describe('deriveCellBoxes', () => {
  it('derives disjoint per-cell boxes from the repaired grid for VALUED cells only', () => {
    const repaired = linkGridRows({ ...gridInfo, grid: remapEmptyColumns(gridInfo, fields) });
    const out = deriveCellBoxes(gridInfo, repaired, fields, ocrPages, tightenBox);
    const byId = Object.fromEntries(out.map((c) => [c.datapointId, c]));
    expect(byId[1].newBox).toEqual([11, 10, 29, 20]); // qty r1 word, padded
    expect(byId[2].newBox).toEqual([11, 30, 29, 40]); // qty r2 word
    expect(byId[21]).toBeUndefined(); // empty code cells get NO box
    // desc boxes match current → no change emitted... (they differ by pad, so allow either)
    // disjointness of all emitted boxes:
    const inter = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    const boxes = out.map((c) => c.newBox);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(inter(boxes[i], boxes[j])).toBeLessThanOrEqual(0.5);
  });
});

describe('buildGridOp', () => {
  it('targets the multivalue content id with the grid payload', () => {
    expect(buildGridOp(500, grid)).toEqual({ op: 'replace', id: 500, value: { grid } });
  });
});
