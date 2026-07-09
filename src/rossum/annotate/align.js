// Deterministic quote→OCR location for the READ → LOCATE → RECONCILE pipeline.
// Fabry reports verbatim `printed` quotes; this module finds them on the page.
// Table cells use WHOLE-TABLE sequence alignment (rows→lines, order-preserving,
// injective, max-total) because per-row matching is ambiguous on near-identical
// rows (measured 0/5 unambiguous on the probe doc) — the discriminator cells
// ("#1"…"#5", distinct amounts) only decide the assignment jointly.
import { normToken, matchValueWords } from './geometry.js';

// Cluster a page's OCR words into horizontal text lines (same clustering as the
// whole-table reseed: a word joins the current line when its top is within 3px
// of the line's running bottom).
export function clusterLines(words) {
  const sorted = [...(words || [])].sort((a, b) => a.position[1] - b.position[1]);
  const lines = [];
  for (const w of sorted) {
    const last = lines[lines.length - 1];
    if (last && w.position[1] <= last.bottom + 3) {
      last.words.push(w);
      last.bottom = Math.max(last.bottom, w.position[3]);
    } else {
      lines.push({ top: w.position[1], bottom: w.position[3], words: [w] });
    }
  }
  for (const l of lines) l.words.sort((a, b) => a.position[0] - b.position[0]);
  return lines;
}

export function quoteTokens(printed) {
  return String(printed ?? '').split(/\s+/).map(normToken).filter(Boolean);
}

// Match a verbatim quote against a line as a CONSECUTIVE word window (quotes are
// copied from the page, so their words are adjacent in reading order), skipping
// words already consumed by another cell. Returns the matched words or null.
export function matchQuoteInLine(tokens, lineWords, used = new Set()) {
  if (!tokens.length) return null;
  const ws = lineWords;
  outer: for (let i = 0; i + tokens.length <= ws.length; i++) {
    for (let k = 0; k < tokens.length; k++) {
      const w = ws[i + k];
      if (used.has(w) || normToken(w.text) !== tokens[k]) continue outer;
    }
    return ws.slice(i, i + tokens.length);
  }
  return null;
}

// How many of a row's quoted cells this line can host (each cell consumes its
// words — two cells can't share one printed token).
export function lineScore(cells, line) {
  const used = new Set();
  let n = 0;
  for (const c of cells || []) {
    if (c.printed == null) continue;
    const m = matchQuoteInLine(quoteTokens(c.printed), line.words, used);
    if (m) {
      for (const w of m) used.add(w);
      n++;
    }
  }
  return n;
}

// Order-preserving injective max-total assignment of rows to lines.
// scores[i][j] = row i's score on line j; a row is assignable to a line only
// when its score ≥ minScores[i]. Ties prefer MORE assigned rows (so identical
// interchangeable rows all land, in order). Returns rowIdx → lineIdx | null.
export function orderPreservingAssignment(scores, minScores) {
  const R = scores.length;
  const L = R ? scores[0].length : 0;
  // f[i][j] = [bestTotal, bestCount] over rows i.. using lines j..
  const f = Array.from({ length: R + 1 }, () => Array.from({ length: L + 1 }, () => [0, 0]));
  const better = (a, b) => (a[0] !== b[0] ? a[0] > b[0] : a[1] > b[1]);
  for (let i = R - 1; i >= 0; i--) {
    for (let j = L - 1; j >= 0; j--) {
      let best = f[i + 1][j]; // skip this row
      if (better(f[i][j + 1], best)) best = f[i][j + 1]; // skip this line
      if (scores[i][j] >= (minScores[i] ?? 1)) {
        const take = [scores[i][j] + f[i + 1][j + 1][0], 1 + f[i + 1][j + 1][1]];
        if (better(take, best) || (take[0] === best[0] && take[1] === best[1])) best = take; // prefer assigning on ties
      }
      f[i][j] = best;
    }
  }
  const out = new Array(R).fill(null);
  let i = 0;
  let j = 0;
  while (i < R && j < L) {
    const here = f[i][j];
    if (scores[i][j] >= (minScores[i] ?? 1)) {
      const take = [scores[i][j] + f[i + 1][j + 1][0], 1 + f[i + 1][j + 1][1]];
      if (take[0] === here[0] && take[1] === here[1]) {
        out[i] = j;
        i++;
        j++;
        continue;
      }
    }
    if (f[i][j + 1][0] === here[0] && f[i][j + 1][1] === here[1]) j++;
    else i++;
  }
  return out;
}

function unionBox(words) {
  return [
    Math.min(...words.map((w) => w.position[0])) - 1,
    Math.min(...words.map((w) => w.position[1])) - 1,
    Math.max(...words.map((w) => w.position[2])) + 1,
    Math.max(...words.map((w) => w.position[3])) + 1,
  ];
}

// Locate a read table's rows on ONE page. rows = [{cells:[{schemaId, value,
// printed}]}]. Returns [{lineIdx, boxes: {schemaId: box}} | null per row].
export function locateTableOnPage(rows, page) {
  const lines = clusterLines(page.words);
  const scores = rows.map((r) => lines.map((l) => lineScore(r.cells, l)));
  const minScores = rows.map((r) => Math.min(2, (r.cells || []).filter((c) => c.printed != null).length) || 1);
  const asg = orderPreservingAssignment(scores, minScores);
  return rows.map((r, i) => {
    const li = asg[i];
    if (li == null) return null;
    const used = new Set();
    const boxes = {};
    for (const c of r.cells || []) {
      if (c.printed == null) continue;
      const m = matchQuoteInLine(quoteTokens(c.printed), lines[li].words, used);
      if (m) {
        for (const w of m) used.add(w);
        boxes[c.schemaId] = unionBox(m);
      }
    }
    return { lineIdx: li, boxes };
  });
}

// Locate a table across pages: the page hosting the most rows wins.
// Returns { page, rows } (rows as in locateTableOnPage) or null.
export function locateTable(rows, ocrPages) {
  let best = null;
  for (const page of ocrPages || []) {
    const located = locateTableOnPage(rows, page);
    const n = located.filter(Boolean).length;
    if (n > 0 && (!best || n > best.n)) best = { page: page.page, rows: located, n };
  }
  return best ? { page: best.page, rows: best.rows } : null;
}

// Locate a header field's verbatim quote on a page (line-coherent, claim-aware).
// Returns { box, page } or null.
export function locateQuote(printed, page, claimedBoxes) {
  if (printed == null || !page) return null;
  const toks = quoteTokens(printed);
  if (!toks.length) return null;
  const matched = matchValueWords(toks, page.words, claimedBoxes || []);
  if (!matched || !matched.length) return null;
  return {
    box: [
      Math.min(...matched.map((b) => b[0])) - 1, Math.min(...matched.map((b) => b[1])) - 1,
      Math.max(...matched.map((b) => b[2])) + 1, Math.max(...matched.map((b) => b[3])) + 1,
    ],
    page: page.page,
  };
}
