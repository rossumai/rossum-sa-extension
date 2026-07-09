import { describe, it, expect } from 'vitest';
import { boxArea, intersectionArea, boxesOverlap, tightenBox, overlapsAny, tightenFields, boxMatchesValue, repairMismatchedBoxes } from '../src/rossum/annotate/geometry.js';

describe('overlap primitives', () => {
  it('boxArea / intersectionArea', () => {
    expect(boxArea([0, 0, 10, 5])).toBe(50);
    expect(intersectionArea([0, 0, 10, 10], [5, 5, 15, 15])).toBe(25);
    expect(intersectionArea([0, 0, 10, 10], [20, 20, 30, 30])).toBe(0);
  });
  it('boxesOverlap: intersecting true, edge-touching + disjoint false', () => {
    expect(boxesOverlap([0, 0, 10, 10], [5, 5, 15, 15])).toBe(true);
    expect(boxesOverlap([0, 0, 10, 10], [10, 0, 20, 10])).toBe(false); // shared edge only
    expect(boxesOverlap([0, 0, 10, 10], [20, 0, 30, 10])).toBe(false);
  });
  it('overlapsAny', () => {
    expect(overlapsAny([0, 0, 10, 10], [[100, 100, 110, 110], [5, 5, 8, 8]])).toBe(true);
    expect(overlapsAny([0, 0, 10, 10], [[100, 100, 110, 110]])).toBe(false);
  });
});

describe('tightenBox', () => {
  it('shrinks a loose box to the padded union of contained OCR words', () => {
    const box = [100, 100, 300, 200];
    const words = [
      { text: 'a', position: [120, 130, 160, 150] },
      { text: 'b', position: [170, 132, 210, 152] },
      { text: 'far', position: [500, 500, 520, 520] }, // center outside box → ignored
    ];
    expect(tightenBox(box, words, 1)).toEqual([119, 129, 211, 153]);
  });
  it('returns the box unchanged when no words are inside', () => {
    const box = [100, 100, 120, 120];
    expect(tightenBox(box, [{ text: 'x', position: [500, 500, 520, 520] }], 1)).toBe(box);
  });
});

describe('tightenFields', () => {
  const ocrPages = [{ page: 1, words: [
    { text: 'INV-1', position: [110, 110, 180, 130] }, // inside the loose header box
    { text: 'tight', position: [301, 201, 349, 219] }, // fills the already-tight box
  ] }];
  it('emits a tighten change for a loose box, only shrinking', () => {
    const fields = [{ datapointId: 1, page: 1, position: [100, 100, 300, 200] }]; // very loose
    const out = tightenFields({ fields, ocrPages });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ datapointId: 1, boxSource: 'tighten', newBox: [109, 109, 181, 131] });
    expect(boxArea(out[0].newBox)).toBeLessThan(boxArea(out[0].oldBox)); // only shrinks
  });
  it('skips a box that already tightly hugs its word', () => {
    const fields = [{ datapointId: 2, page: 1, position: [300, 200, 350, 220] }]; // already ~tight around "tight"
    expect(tightenFields({ fields, ocrPages })).toEqual([]);
  });
  it('skips fields with no box', () => {
    expect(tightenFields({ fields: [{ datapointId: 3, page: 1, position: null }], ocrPages })).toEqual([]);
  });
});

import { destackFields, orphanClears, rowBandOf } from '../src/rossum/annotate/geometry.js';

describe('destackFields (identical-box backend artifact)', () => {
  // 3 rows; the "qty" column boxes are byte-identical (stacked at row 1); each row
  // has a clean sibling (desc) box defining its band, and a qty word in each band.
  const fields = [
    { datapointId: 1, schemaId: 'qty', mvSchemaId: 'li', inLineItem: true, rowIndex: 1, page: 1, position: [10, 10, 30, 20], value: '7' },
    { datapointId: 2, schemaId: 'qty', mvSchemaId: 'li', inLineItem: true, rowIndex: 2, page: 1, position: [10, 10, 30, 20], value: '7' },
    { datapointId: 3, schemaId: 'qty', mvSchemaId: 'li', inLineItem: true, rowIndex: 3, page: 1, position: [10, 10, 30, 20], value: '7' },
    { datapointId: 11, schemaId: 'desc', mvSchemaId: 'li', inLineItem: true, rowIndex: 1, page: 1, position: [50, 10, 90, 20], value: 'a' },
    { datapointId: 12, schemaId: 'desc', mvSchemaId: 'li', inLineItem: true, rowIndex: 2, page: 1, position: [50, 30, 90, 40], value: 'b' },
    { datapointId: 13, schemaId: 'desc', mvSchemaId: 'li', inLineItem: true, rowIndex: 3, page: 1, position: [50, 50, 90, 60], value: 'c' },
  ];
  const ocrPages = [{ page: 1, words: [
    { text: '7', position: [12, 11, 18, 19] },
    { text: '7', position: [12, 31, 18, 39] },
    { text: '7', position: [12, 51, 18, 59] },
  ] }];
  it('relocates stacked rows into their own bands, leaving the owning row alone', () => {
    const out = destackFields({ fields, ocrPages });
    const byId = Object.fromEntries(out.map((c) => [c.datapointId, c]));
    expect(byId[1]).toBeUndefined(); // row 1 owns the box (center inside its band)
    expect(byId[2].newBox).toEqual([11, 30, 19, 40]); // row-2 word, padded
    expect(byId[3].newBox).toEqual([11, 50, 19, 60]);
    expect(byId[2].boxSource).toBe('row-align');
  });
  it('rowBandOf excludes stacked boxes from the band computation', () => {
    expect(rowBandOf(fields, 'li', 2, 2)).toEqual([30, 40]); // desc row 2 only, not the stacked qtys
  });
});

describe('orphanClears', () => {
  it('clears an empty-valued field whose box overlaps a non-empty field', () => {
    const fields = [
      { datapointId: 1, schemaId: 'code', page: 1, position: [10, 10, 30, 20], value: '' },
      { datapointId: 2, schemaId: 'qty', page: 1, position: [12, 12, 28, 18], value: '7' },
    ];
    const out = orphanClears({ fields });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ datapointId: 1, clearBox: true, newBox: null, boxChanged: true });
  });
  it('leaves empty fields whose boxes clash with nothing, and non-empty fields, alone', () => {
    const fields = [
      { datapointId: 1, schemaId: 'a', page: 1, position: [10, 10, 30, 20], value: '' },   // no clash
      { datapointId: 2, schemaId: 'b', page: 1, position: [100, 10, 130, 20], value: 'x' },
      { datapointId: 3, schemaId: 'c', page: 1, position: [101, 11, 129, 19], value: 'y' }, // non-empty overlap → not cleared
    ];
    expect(orphanClears({ fields })).toEqual([]);
  });
});

import { shrinkEngulfingBoxes } from '../src/rossum/annotate/geometry.js';
describe('shrinkEngulfingBoxes', () => {
  it('shrinks a box that fully contains another valued field to its own text line', () => {
    const fields = [
      { datapointId: 1, schemaId: 'date_issue', page: 1, position: [299, 268, 415, 290], value: 'd1' },
      { datapointId: 2, schemaId: 'date_due', page: 1, position: [299, 268, 415, 323], value: 'd2' }, // engulfs #1's line
    ];
    const ocrPages = [{ page: 1, words: [
      { text: 'Jan', position: [300, 270, 330, 288] }, { text: '2025', position: [335, 270, 380, 288] },
      { text: 'Feb', position: [300, 296, 330, 320] }, { text: '2025', position: [335, 296, 380, 320] },
    ] }];
    const out = shrinkEngulfingBoxes({ fields, ocrPages });
    expect(out).toHaveLength(1);
    expect(out[0].datapointId).toBe(2);
    expect(out[0].newBox).toEqual([299, 295, 381, 321]); // due line only, padded
  });
  it('does nothing without full containment', () => {
    const fields = [
      { datapointId: 1, schemaId: 'a', page: 1, position: [0, 0, 50, 20], value: 'x' },
      { datapointId: 2, schemaId: 'b', page: 1, position: [40, 0, 90, 20], value: 'y' }, // partial overlap
    ];
    expect(shrinkEngulfingBoxes({ fields, ocrPages: [{ page: 1, words: [] }] })).toEqual([]);
  });
});

import { reseedFromRir } from '../src/rossum/annotate/geometry.js';
describe('reseedFromRir (value-anchored)', () => {
  it('recovers a boxless valued cell by matching its value in the row band', () => {
    const fields = [
      { datapointId: 2, schemaId: 'qty', mvSchemaId: 'li', inLineItem: true, rowIndex: 2, page: 1, value: '7', position: null },
      { datapointId: 12, schemaId: 'desc', mvSchemaId: 'li', inLineItem: true, rowIndex: 2, page: 1, value: 'b', position: [50, 30, 90, 40] },
    ];
    const ocrPages = [{ page: 1, words: [
      { text: '7', position: [12, 11, 18, 19] },  // another row's 7 — outside the band
      { text: '7', position: [12, 31, 18, 39] },  // this row's 7
      { text: 'b', position: [52, 31, 88, 39] },
    ] }];
    const out = reseedFromRir({ fields, ocrPages });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ datapointId: 2, newBox: [11, 30, 19, 40], boxSource: 'row-align' });
  });
  it('recovers a band-less cell via the same-column strip from boxed siblings in other rows', () => {
    const fields = [
      { datapointId: 71, schemaId: 'rate', mvSchemaId: 'tax', inLineItem: true, rowIndex: 1, page: 1, value: '0%', position: [10, 10, 30, 20] },
      { datapointId: 72, schemaId: 'rate', mvSchemaId: 'tax', inLineItem: true, rowIndex: 2, page: 1, value: '10%', position: null }, // no band (row 2 has no boxed siblings)
    ];
    const ocrPages = [{ page: 1, words: [
      { text: '10%', position: [12, 31, 28, 39] },   // in the rate column strip
      { text: '10%', position: [500, 31, 520, 39] }, // elsewhere on the page — outside strip
    ] }];
    const out = reseedFromRir({ fields, ocrPages });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ datapointId: 72, newBox: [11, 30, 29, 40] });
  });
  it('multi-occurrence values: prefers the topmost UNCLAIMED occurrence; claims never veto (guard adjudicates)', () => {
    const ocrPages = [{ page: 1, words: [
      { text: 'x', position: [12, 31, 18, 39] }, { text: 'x', position: [22, 31, 28, 39] },
    ] }];
    // Both 'x' words unclaimed → the topmost(-first) one is picked.
    const fields = [
      { datapointId: 3, schemaId: 'q2', mvSchemaId: 'li', inLineItem: true, rowIndex: 2, page: 1, value: 'x', position: null },
      { datapointId: 12, schemaId: 'desc', mvSchemaId: 'li', inLineItem: true, rowIndex: 2, page: 1, value: 'b', position: [50, 30, 90, 40] },
    ];
    const out = reseedFromRir({ fields, ocrPages });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ datapointId: 3, newBox: [11, 30, 19, 40] });
    // Every occurrence claimed by other fields' boxes → the reseed still FORMS
    // (claims are a preference, not a veto): the downstream overlap guard owns the
    // conflict — it can clear a wrong claimant or drop this box. A veto here would
    // deadlock: a squatting wrong box could never be challenged.
    const claimedFields = [
      ...fields,
      { datapointId: 91, schemaId: 'o1', mvSchemaId: 'li', inLineItem: true, rowIndex: 2, page: 1, value: 'v', position: [10, 29, 20, 40] },
      { datapointId: 92, schemaId: 'o2', mvSchemaId: 'li', inLineItem: true, rowIndex: 2, page: 1, value: 'w', position: [21, 29, 30, 40] },
    ];
    const formed = reseedFromRir({ fields: claimedFields, ocrPages }).filter((c) => c.datapointId === 3);
    expect(formed).toHaveLength(1);
  });
  it('skips empty values, already-boxed cells, and evidence-less cells', () => {
    const ocrPages = [{ page: 1, words: [{ text: 'x', position: [12, 31, 18, 39] }] }];
    const fields = [
      { datapointId: 1, schemaId: 'q', mvSchemaId: 'li', inLineItem: true, rowIndex: 2, page: 1, value: '', position: null },
      { datapointId: 2, schemaId: 'q', mvSchemaId: 'li', inLineItem: true, rowIndex: 2, page: 1, value: 'x', position: [1, 1, 2, 2] },
      { datapointId: 4, schemaId: 'q3', mvSchemaId: 'other_table', inLineItem: true, rowIndex: 1, page: 1, value: 'x', position: null }, // no band, no strip
    ];
    expect(reseedFromRir({ fields, ocrPages })).toEqual([]);
  });
});

describe('reseedFromRir page inference', () => {
  it('recovers a cell whose page was wiped, inferring it from a boxed sibling', () => {
    const fields = [
      { datapointId: 2, schemaId: 'qty', mvSchemaId: 'li', inLineItem: true, rowIndex: 2, page: null, value: '7', position: null },
      { datapointId: 12, schemaId: 'desc', mvSchemaId: 'li', inLineItem: true, rowIndex: 2, page: 1, value: 'b', position: [50, 30, 90, 40] },
    ];
    const ocrPages = [{ page: 1, words: [{ text: '7', position: [12, 31, 18, 39] }, { text: 'b', position: [52, 31, 88, 39] }] }];
    const out = reseedFromRir({ fields, ocrPages });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ datapointId: 2, newBox: [11, 30, 19, 40], page: 1 });
  });
});

import { reseedTableByValues } from '../src/rossum/annotate/geometry.js';
describe('reseedTableByValues (fully wiped table)', () => {
  // Mirrors the wiped VAT table: 3 rows, values normalized ('0','10','20' rates match
  // printed '0%','10%','20%'), amounts '10','20','30'; no cell has a box or page.
  const fields = [1, 2, 3].flatMap((r) => [
    { datapointId: 60 + r, schemaId: 'rate', mvSchemaId: 'tax', inLineItem: true, rowIndex: r, page: null, position: null, value: ['0', '10', '20'][r - 1] },
    { datapointId: 70 + r, schemaId: 'tx', mvSchemaId: 'tax', inLineItem: true, rowIndex: r, page: null, position: null, value: ['10', '20', '30'][r - 1] },
  ]);
  const ocrPages = [{ page: 1, words: [
    { text: '0%', position: [10, 10, 26, 19] }, { text: '10', position: [40, 10, 56, 19] }, { text: 'USD', position: [70, 10, 96, 19] },
    { text: '10%', position: [10, 30, 26, 39] }, { text: '20', position: [40, 30, 56, 39] }, { text: 'USD', position: [70, 30, 96, 39] },
    { text: '20%', position: [10, 50, 26, 59] }, { text: '30', position: [40, 50, 56, 59] }, { text: 'USD', position: [70, 50, 96, 59] },
  ] }];
  it('boxes every valued cell of a wiped table via row-tuple line matching', () => {
    const out = reseedTableByValues({ fields, ocrPages });
    const byId = Object.fromEntries(out.map((c) => [c.datapointId, c]));
    expect(out).toHaveLength(6);
    expect(byId[61].newBox).toEqual([9, 9, 27, 20]);   // rate r1 → '0%'
    expect(byId[72].newBox).toEqual([39, 29, 57, 40]); // tx r2 → '20'
    expect(byId[63].newBox).toEqual([9, 49, 27, 60]);  // rate r3 → '20%'
    expect(out.every((c) => c.page === 1)).toBe(true); // page recovered from the matched line
  });
  it('refuses when any row matches ambiguously (two candidate lines)', () => {
    const dupPages = [{ page: 1, words: [
      ...ocrPages[0].words,
      { text: '10%', position: [10, 80, 26, 89] }, { text: '20', position: [40, 80, 56, 89] }, // duplicate of row 2's tuple
    ] }];
    expect(reseedTableByValues({ fields, ocrPages: dupPages })).toEqual([]);
  });
  it('skips tables that still have any boxed cell (banded reseed handles those)', () => {
    const anchored = fields.map((f) => (f.datapointId === 61 ? { ...f, position: [9, 9, 27, 20], page: 1 } : f));
    expect(reseedTableByValues({ fields: anchored, ocrPages })).toEqual([]);
  });
});

describe('boxMatchesValue + repairMismatchedBoxes', () => {
  const words = [
    { text: 'Jan', position: [300, 270, 330, 288] }, { text: '6,', position: [335, 270, 350, 288] }, { text: '2025', position: [355, 270, 400, 288] },
    { text: '098765', position: [100, 100, 180, 118] },
  ];
  it('accepts a normalized date box (separator-tolerant tokens)', () => {
    expect(boxMatchesValue('2025-01-06', [299, 269, 401, 289], words)).toBe(true); // shares '2025'
  });
  it('accepts numeric comma/dot variants and rejects true mismatches', () => {
    expect(boxMatchesValue('5060.00', [0, 0, 100, 20], [{ text: '5060,00', position: [10, 5, 90, 15] }])).toBe(true);
    expect(boxMatchesValue('098765', [299, 269, 401, 289], words)).toBe(false); // box holds the date, not the id
  });
  it('relocates a mismatched box to its value, never clears unprovable ones', () => {
    const fields = [
      { datapointId: 1, schemaId: 'order_id', value: '098765', position: [299, 269, 401, 289], page: 1, inLineItem: false, rowIndex: null }, // box sits on the date
      { datapointId: 2, schemaId: 'weird', value: 'zzz', position: [200, 200, 240, 220], page: 1, inLineItem: false, rowIndex: null },       // value not on page
    ];
    const ocrPages = [{ page: 1, words: [...words, { text: 'qq', position: [201, 201, 239, 219] }] }];
    const out = repairMismatchedBoxes({ fields, ocrPages });
    expect(out).toHaveLength(1); // 'weird' is left alone (relocate-only, never clear)
    expect(out[0]).toMatchObject({ datapointId: 1, newBox: [99, 99, 181, 119] }); // moved onto '098765'
  });
});
