import { describe, it, expect } from 'vitest';
import { parseProposal, resolveBoxes, diffProposals } from '../src/rossum/annotate/proposal.js';

describe('parseProposal', () => {
  it('parses a fenced json array into normalized proposals', () => {
    const reply = 'Here:\n```json\n[{"schema_id":"document_id","new_value":"INV-1","box_words":["INV-1"],"page":1,"reason":"r","confidence":0.8}]\n```';
    expect(parseProposal(reply)).toEqual([
      { schemaId: 'document_id', datapointId: null, table: null, row: null, newValue: 'INV-1', boxWords: ['INV-1'], boxPixels: null, page: 1, reason: 'r', confidence: 0.8 },
    ]);
  });
  it('parses an unfenced array and defaults missing fields', () => {
    const reply = '[{"schema_id":"total","new_value":"9","box_pixels":[1,2,3,4]}]';
    expect(parseProposal(reply)).toEqual([
      { schemaId: 'total', datapointId: null, table: null, row: null, newValue: '9', boxWords: null, boxPixels: [1, 2, 3, 4], page: null, reason: '', confidence: null },
    ]);
  });
  it('returns [] when nothing parseable / no schema_id', () => {
    expect(parseProposal('no json here')).toEqual([]);
    expect(parseProposal('[{"foo":1}]')).toEqual([]);
  });

  it('does not truncate the scan on a bracket character inside a string value', () => {
    // Leading non-JSON text ('notes: ') makes the whole-text safeParseArray (step 2)
    // fail, forcing the scan (step 3) to actually exercise balancedArrayEnd's
    // string-awareness rather than being short-circuited by the whole-text parse.
    const reply = 'notes: [{"schema_id":"a","reason":"value looks like ] or [ inside a string"}]';
    const result = parseProposal(reply);
    expect(result).toHaveLength(1);
    expect(result[0].schemaId).toBe('a');
    expect(result[0].reason).toBe('value looks like ] or [ inside a string');
  });

  it('skips an incidental empty array to find the real proposal array', () => {
    const reply = 'no immediate changes: [] but corrections: [{"schema_id":"z"}]';
    const result = parseProposal(reply);
    expect(result).toHaveLength(1);
    expect(result[0].schemaId).toBe('z');
  });

  it('treats a fenced empty array as authoritative "no changes"', () => {
    expect(parseProposal('```json\n[]\n```')).toEqual([]);
  });

  it('skips an incidental earlier bracketed array to find the real proposal array', () => {
    const reply = 'ids: [1,2,3] then [{"schema_id":"z"}]';
    const result = parseProposal(reply);
    expect(result).toHaveLength(1);
    expect(result[0].schemaId).toBe('z');
  });

  it('keeps scanning past unparsable bracket-shaped text to find the real array', () => {
    const reply = 'garbage [not json] then real: [{"schema_id":"x"}]';
    const result = parseProposal(reply);
    expect(result).toHaveLength(1);
    expect(result[0].schemaId).toBe('x');
  });
});

describe('resolveBoxes', () => {
  const ocrPages = [{ page: 1, width: 100, height: 100, words: [
    { text: 'INV', position: [10, 10, 30, 20] },
    { text: '123', position: [32, 10, 50, 20] },
  ] }];

  it('snaps to the union of matched OCR word boxes', () => {
    const r = resolveBoxes([{ schemaId: 'd', newValue: 'INV 123', boxWords: ['INV', '123'], boxPixels: null, page: 1, reason: '', confidence: 1 }], ocrPages);
    expect(r[0].resolvedBox).toEqual([10, 10, 50, 20]);
    expect(r[0].boxSource).toBe('ocr');
  });

  it('falls back to clamped pixel box when no words match', () => {
    const r = resolveBoxes([{ schemaId: 'd', newValue: 'x', boxWords: ['ZZZ'], boxPixels: [90, 90, 200, 200], page: 1, reason: '', confidence: 1 }], ocrPages);
    expect(r[0].resolvedBox).toEqual([90, 90, 100, 100]); // clamped to page 100x100
    expect(r[0].boxSource).toBe('pixels');
  });

  it('marks none when neither words match nor pixels given', () => {
    const r = resolveBoxes([{ schemaId: 'd', newValue: 'x', boxWords: null, boxPixels: null, page: 1, reason: '', confidence: 1 }], ocrPages);
    expect(r[0].resolvedBox).toBeNull();
    expect(r[0].boxSource).toBe('none');
  });

  it('resolves a partial match to the union of just the matched words', () => {
    const r = resolveBoxes([{ schemaId: 'd', newValue: 'INV', boxWords: ['INV', 'ZZZ'], boxPixels: null, page: 1, reason: '', confidence: 1 }], ocrPages);
    expect(r[0].boxSource).toBe('ocr');
    expect(r[0].resolvedBox).toEqual([10, 10, 30, 20]);
  });

  it('does not alias the source OCR word position on a single-word match', () => {
    const r = resolveBoxes([{ schemaId: 'd', newValue: 'INV', boxWords: ['INV'], boxPixels: null, page: 1, reason: '', confidence: 1 }], ocrPages);
    expect(r[0].resolvedBox).toEqual([10, 10, 30, 20]);
    expect(r[0].resolvedBox).not.toBe(ocrPages[0].words[0].position);
    r[0].resolvedBox[0] = 999;
    expect(ocrPages[0].words[0].position).toEqual([10, 10, 30, 20]);
  });
});

describe('diffProposals', () => {
  it('emits a change with value + box deltas and the datapointId', () => {
    const fields = [{ datapointId: 11, schemaId: 'd', value: 'old', position: [10, 10, 30, 20], page: 1, confidence: 0.5 }];
    const resolved = [{ schemaId: 'd', newValue: 'new', resolvedBox: [10, 10, 50, 20], boxSource: 'ocr', page: 1, reason: 'r', confidence: 0.9 }];
    expect(diffProposals(resolved, fields)).toEqual([{
      schemaId: 'd', datapointId: 11, rowIndex: null, oldValue: 'old', newValue: 'new',
      oldBox: [10, 10, 30, 20], newBox: [10, 10, 50, 20], page: 1, boxSource: 'ocr',
      reason: 'r', confidence: 0.9, valueChanged: true, boxChanged: true,
    }]);
  });
  it('drops no-op and unknown-schema proposals', () => {
    const fields = [{ datapointId: 11, schemaId: 'd', value: 'old', position: [10, 10, 30, 20], page: 1, confidence: 0.5 }];
    const same = [{ schemaId: 'd', newValue: 'old', resolvedBox: [10, 10, 30, 20], boxSource: 'ocr', page: 1, reason: '', confidence: 1 }];
    expect(diffProposals(same, fields)).toEqual([]);
    const unknown = [{ schemaId: 'zzz', newValue: 'x', resolvedBox: null, boxSource: 'none', page: 1, reason: '', confidence: 1 }];
    expect(diffProposals(unknown, fields)).toEqual([]);
  });
});

describe('parseProposal datapoint_id', () => {
  it('reads datapoint_id when present, null otherwise', () => {
    expect(parseProposal('[{"schema_id":"item_amount","datapoint_id":11,"new_value":"9"}]')[0].datapointId).toBe(11);
    expect(parseProposal('[{"schema_id":"total","new_value":"9"}]')[0].datapointId).toBeNull();
  });

  it('accepts a datapoint_id-only proposal with no schema_id (the refine-turn shape)', () => {
    const result = parseProposal('[{"datapoint_id":11,"new_value":"9","reason":"fix"}]');
    expect(result).toEqual([
      { schemaId: null, datapointId: 11, newValue: '9', boxWords: null, boxPixels: null, page: null, reason: 'fix', confidence: null, table: null, row: null },
    ]);
  });

  it('still drops a junk object with neither schema_id nor datapoint_id', () => {
    expect(parseProposal('[{"foo":1}]')).toEqual([]);
  });
});
describe('diffProposals datapoint-id targeting', () => {
  const fields = [
    { datapointId: 10, schemaId: 'item_amount', value: 'a', position: null, page: 1, rowIndex: 1, inLineItem: true },
    { datapointId: 11, schemaId: 'item_amount', value: 'b', position: null, page: 1, rowIndex: 2, inLineItem: true },
    { datapointId: 1, schemaId: 'total', value: 'x', position: null, page: 1, rowIndex: null, inLineItem: false },
  ];
  it('targets the exact row by datapoint id', () => {
    const r = [{ datapointId: 11, schemaId: 'item_amount', newValue: 'B2', resolvedBox: null, boxSource: 'none', page: 1, reason: '', confidence: 1 }];
    const out = diffProposals(r, fields);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ datapointId: 11, rowIndex: 2, oldValue: 'b', newValue: 'B2' });
  });
  it('resolves a schema_id-only proposal when the match is unique (header field)', () => {
    const r = [{ datapointId: null, schemaId: 'total', newValue: 'X2', resolvedBox: null, boxSource: 'none', page: 1, reason: '', confidence: 1 }];
    expect(diffProposals(r, fields)[0]).toMatchObject({ datapointId: 1, newValue: 'X2' });
  });
  it('skips a proposal whose datapoint id matches no field', () => {
    const r = [{ datapointId: 999, schemaId: 'item_amount', newValue: 'z', resolvedBox: null, boxSource: 'none', page: 1, reason: '', confidence: 1 }];
    expect(diffProposals(r, fields)).toEqual([]);
  });
  it('skips a schema_id-only proposal that matches multiple line-item fields (ambiguous row — never guesses row 1)', () => {
    const r = [{ datapointId: null, schemaId: 'item_amount', newValue: 'Z', resolvedBox: null, boxSource: 'none', page: 1, reason: '', confidence: 1 }];
    expect(diffProposals(r, fields)).toEqual([]);
  });
});

// (parseAddRows was removed: missing rows now come from the READING via
// reconcileReading — see annotate-reconcile.test.js.)

describe('resolveBoxes row-band matching (repeated tokens)', () => {
  const fields = [
    { datapointId: 2, schemaId: 'qty', mvSchemaId: 'li', inLineItem: true, rowIndex: 2, page: 1, position: [10, 10, 30, 20] },
    { datapointId: 12, schemaId: 'desc', mvSchemaId: 'li', inLineItem: true, rowIndex: 2, page: 1, position: [50, 30, 90, 40] },
  ];
  const ocrPages = [{ page: 1, width: 200, height: 100, words: [
    { text: '750', position: [12, 11, 28, 19] },  // row 1's token (first on page)
    { text: '750', position: [12, 31, 28, 39] },  // row 2's token
  ] }];
  it('snaps a line-item proposal to the token in ITS row band, not the first on the page', () => {
    const r = resolveBoxes([{ datapointId: 2, schemaId: 'qty', newValue: '750', boxWords: ['750'], boxPixels: null, page: 1, reason: '', confidence: 1 }], ocrPages, fields);
    expect(r[0].resolvedBox).toEqual([12, 31, 28, 39]); // row 2's word — not row 1's
    expect(r[0].boxSource).toBe('ocr');
  });
  it('falls back to page-wide matching when the band has no such word', () => {
    const r = resolveBoxes([{ datapointId: 2, schemaId: 'qty', newValue: 'X9', boxWords: ['X9'], boxPixels: null, page: 1, reason: '', confidence: 1 }],
      [{ page: 1, width: 200, height: 100, words: [{ text: 'X9', position: [12, 80, 28, 90] }] }], fields);
    expect(r[0].resolvedBox).toEqual([12, 80, 28, 90]);
  });
});

describe('resolveBoxes line-coherence (repeated tokens across lines)', () => {
  // Two date lines: 'Jan 6, 2025' and 'Feb 6, 2025'. Naive first-match binding for
  // ['Feb','6,','2025'] grabs '6,' and '2025' from the ISSUE line → a box spanning
  // both lines (the exact wrong-box class seen live). Line-coherent matching must
  // anchor on the rare token ('Feb') and keep all words on ITS line.
  const ocrPages = [{ page: 1, width: 500, height: 400, words: [
    { text: 'Jan', position: [300, 270, 330, 288] }, { text: '6,', position: [335, 270, 350, 288] }, { text: '2025', position: [355, 270, 400, 288] },
    { text: 'Feb', position: [300, 296, 330, 314] }, { text: '6,', position: [335, 296, 350, 314] }, { text: '2025', position: [355, 296, 400, 314] },
  ] }];
  it('binds all box_words to the anchor token\'s line', () => {
    const r = resolveBoxes([{ datapointId: 9, schemaId: 'date_due', newValue: '2025-02-06', boxWords: ['Feb', '6,', '2025'], boxPixels: null, page: 1, reason: '', confidence: 1 }], ocrPages, []);
    expect(r[0].resolvedBox).toEqual([300, 296, 400, 314]); // the Feb line ONLY — never spanning
  });
  it('tolerates a stray token the page does not contain', () => {
    const r = resolveBoxes([{ datapointId: 9, schemaId: 'date_due', newValue: 'x', boxWords: ['Feb', 'XXXX'], boxPixels: null, page: 1, reason: '', confidence: 1 }], ocrPages, []);
    expect(r[0].resolvedBox).toEqual([300, 296, 330, 314]); // 'Feb' matched, stray skipped
  });
});

describe('(table, row, schema) addressing for table cells', () => {
  const fields = [
    { datapointId: 10, schemaId: 'qty', mvSchemaId: 'li', inLineItem: true, rowIndex: 1, value: '', position: null, page: 1 },
    { datapointId: 20, schemaId: 'qty', mvSchemaId: 'li', inLineItem: true, rowIndex: 2, value: '', position: null, page: 1 },
  ];
  it('resolves a table+row proposal to the exact row cell', () => {
    const r = parseProposal('[{"schema_id":"qty","table":"li","row":2,"new_value":"750"}]');
    expect(r[0]).toMatchObject({ schemaId: 'qty', table: 'li', row: 2, datapointId: null });
    const out = diffProposals(r.map((p) => ({ ...p, resolvedBox: null, boxSource: 'none' })), fields);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ datapointId: 20, newValue: '750', rowIndex: 2 });
  });
  it('skips a table+row proposal that matches no cell', () => {
    const r = parseProposal('[{"schema_id":"qty","table":"li","row":9,"new_value":"1"}]');
    expect(diffProposals(r.map((p) => ({ ...p, resolvedBox: null, boxSource: 'none' })), fields)).toEqual([]);
  });
});

describe('(table, row, schema) addressing box resolution (repeated tokens)', () => {
  // The quantity column: the SAME value on every row. A table-addressed proposal
  // (no datapoint_id — empty cells carry none in the prompt) must still resolve
  // its row band from siblings and bind to ITS row's occurrence; a whole-page
  // match would stack every row onto the first occurrence.
  const fields = [
    { datapointId: 11, schemaId: 'desc', mvSchemaId: 'li', inLineItem: true, rowIndex: 1, value: 'Alpha', position: [50, 10, 90, 20], page: 1 },
    { datapointId: 12, schemaId: 'qty', mvSchemaId: 'li', inLineItem: true, rowIndex: 1, value: '', position: null, page: 1 },
    { datapointId: 21, schemaId: 'desc', mvSchemaId: 'li', inLineItem: true, rowIndex: 2, value: 'Beta', position: [50, 30, 90, 40], page: 1 },
    { datapointId: 22, schemaId: 'qty', mvSchemaId: 'li', inLineItem: true, rowIndex: 2, value: '', position: null, page: 1 },
  ];
  const ocrPages = [{ page: 1, width: 200, height: 100, words: [
    { text: '1.00', position: [12, 11, 28, 19] },  // row 1's quantity (first on page)
    { text: '1.00', position: [12, 31, 28, 39] },  // row 2's quantity
  ] }];
  it('snaps a table-addressed proposal to the token in ITS row band, not the first on the page', () => {
    const r = resolveBoxes([{ datapointId: null, schemaId: 'qty', table: 'li', row: 2, newValue: '1.00', boxWords: ['1.00'], boxPixels: null, page: 1, reason: '', confidence: 1 }], ocrPages, fields);
    expect(r[0].resolvedBox).toEqual([12, 31, 28, 39]); // row 2's word — not row 1's
    expect(r[0].boxSource).toBe('ocr');
  });
});
