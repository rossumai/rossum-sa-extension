import { describe, it, expect } from 'vitest';
import { clusterLines, quoteTokens, matchQuoteInLine, lineScore, orderPreservingAssignment, locateTableOnPage, locateTable, locateQuote } from '../src/rossum/annotate/align.js';

const W = (text, x, y, w = 30, h = 20) => ({ text, position: [x, y, x + w, y + h] });

// The probe doc's shape: five NEAR-IDENTICAL line-item rows differing only in
// the description suffix (#1…#5) and the amount. Per-row matching is ambiguous
// (every line hosts "750 hours … 10% … USD"); only joint alignment resolves it.
function probePage() {
  const rows = [];
  const mk = (n, y, amount) => [
    W('750', 145, y), W('hours', 218, y), W('Professional', 364, y), W('services', 493, y),
    W(`#${n}`, 581, y), W('10%', 729, y), W(amount, 875, y), W('USD', 1021, y),
  ];
  rows.push(...mk(1, 686, '1000.1'), ...mk(2, 716, '1000,2'), ...mk(3, 745, '(1000)'), ...mk(4, 775, '1000'), ...mk(5, 804, '1000CR'));
  return { page: 1, width: 1240, height: 1605, words: rows };
}

const readRow = (n, amount) => ({ cells: [
  { schemaId: 'item_quantity', value: '750', printed: '750' },
  { schemaId: 'item_uom', value: 'hours', printed: 'hours' },
  { schemaId: 'item_description', value: `Professional services #${n}`, printed: `Professional services #${n}` },
  { schemaId: 'item_rate', value: '10', printed: '10%' },
  { schemaId: 'item_amount_total', value: amount, printed: amount },
] });

describe('clusterLines', () => {
  it('groups words into y-lines, x-sorted', () => {
    const lines = clusterLines([W('b', 50, 10), W('a', 10, 12), W('c', 10, 60)]);
    expect(lines).toHaveLength(2);
    expect(lines[0].words.map((w) => w.text)).toEqual(['a', 'b']);
    expect(lines[1].words.map((w) => w.text)).toEqual(['c']);
  });
});

describe('matchQuoteInLine', () => {
  const line = clusterLines([W('Professional', 10, 10), W('services', 50, 10), W('#2', 90, 10), W('services', 130, 10)])[0];
  it('matches a consecutive window', () => {
    const m = matchQuoteInLine(quoteTokens('Professional services #2'), line.words);
    expect(m.map((w) => w.text)).toEqual(['Professional', 'services', '#2']);
  });
  it('skips words already used by another cell', () => {
    const used = new Set([line.words[1]]); // first 'services' consumed
    const m = matchQuoteInLine(quoteTokens('services'), line.words, used);
    expect(m[0]).toBe(line.words[3]); // takes the second occurrence
  });
  it('returns null when the sequence is broken', () => {
    expect(matchQuoteInLine(quoteTokens('Professional #2'), line.words)).toBeNull();
  });
});

describe('lineScore', () => {
  it('counts hostable quoted cells, consuming words per cell', () => {
    const line = clusterLines([W('750', 10, 10), W('hours', 50, 10)])[0];
    expect(lineScore(readRow(1, '1000.1').cells, line)).toBe(2); // 750 + hours
    expect(lineScore([{ printed: '750' }, { printed: '750' }], line)).toBe(1); // one printed 750 can't serve two cells
  });
});

describe('orderPreservingAssignment', () => {
  it('assigns near-identical rows to their own lines via discriminators', () => {
    // row i scores 5 on its true line, 4 elsewhere (the #N + amount discriminate)
    const scores = Array.from({ length: 5 }, (_, i) => Array.from({ length: 5 }, (_, j) => (i === j ? 5 : 4)));
    expect(orderPreservingAssignment(scores, [2, 2, 2, 2, 2])).toEqual([0, 1, 2, 3, 4]);
  });
  it('assigns fully identical rows in order (interchangeable)', () => {
    const scores = Array.from({ length: 3 }, () => [4, 4, 4]);
    expect(orderPreservingAssignment(scores, [2, 2, 2])).toEqual([0, 1, 2]);
  });
  it('skips a row whose best line is below its minimum score', () => {
    const scores = [[3, 0], [1, 1]];
    expect(orderPreservingAssignment(scores, [2, 2])).toEqual([0, null]);
  });
  it('skips lines to keep order when a middle row is missing from the page', () => {
    const scores = [[5, 0, 0], [0, 0, 5]];
    expect(orderPreservingAssignment(scores, [2, 2])).toEqual([0, 2]);
  });
});

describe('locateTableOnPage / locateTable — the probe fixture', () => {
  const page = probePage();
  const rows = [readRow(1, '1000.1'), readRow(2, '1000,2'), readRow(3, '(1000)'), readRow(4, '1000'), readRow(5, '1000CR')];
  it('locates all five near-identical rows on their own lines with per-cell boxes', () => {
    const located = locateTableOnPage(rows, page);
    expect(located.filter(Boolean)).toHaveLength(5);
    const ys = located.map((r) => r.boxes.item_quantity[1]);
    expect(new Set(ys).size).toBe(5); // five DISTINCT quantity boxes — never stacked
    expect(located[0].boxes.item_quantity).toEqual([144, 685, 176, 707]);
    expect(located[4].boxes.item_quantity[1]).toBeGreaterThan(located[0].boxes.item_quantity[3]);
    expect(located[2].boxes.item_amount_total).toBeTruthy(); // '(1000)' located too
  });
  it('locateTable picks the page hosting the rows', () => {
    const other = { page: 2, width: 100, height: 100, words: [W('unrelated', 10, 10)] };
    const best = locateTable(rows, [other, page]);
    expect(best.page).toBe(1);
    expect(best.rows.filter(Boolean)).toHaveLength(5);
  });
  it('returns null when no page hosts any row', () => {
    expect(locateTable(rows, [{ page: 3, words: [W('zz', 1, 1)] }])).toBeNull();
  });
});

describe('locateQuote (headers)', () => {
  const page = { page: 1, words: [W('Jan', 300, 270), W('6,', 335, 270), W('2025', 355, 270), W('Feb', 300, 296), W('6,', 335, 296), W('2025', 355, 296)] };
  it('locates a verbatim quote line-coherently', () => {
    const r = locateQuote('Feb 6, 2025', page, []);
    expect(r.page).toBe(1);
    expect(r.box[1]).toBeGreaterThan(290); // the Feb line, not spanning into Jan's
  });
  it('returns null for unprinted or missing quotes', () => {
    expect(locateQuote(null, page, [])).toBeNull();
    expect(locateQuote('nowhere', page, [])).toBeNull();
  });
});
