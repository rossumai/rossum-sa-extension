// Pure box geometry for annotation correction. No DOM, no network.
//
// Two deterministic, SAFE operations:
//  1. tightenBox — shrink a box to the OCR words it actually contains (fixes loose
//     boxes that don't hug their value). Tightening only ever shrinks, so it can
//     never introduce a new overlap.
//  2. overlap detection — used by the write path to enforce a hard invariant:
//     never WRITE a box that overlaps another field's box. (Rossum stores overlaps
//     silently — the API does not reject them — so this is our responsibility.)
//
// Deliberately NOT here: relocating a mislocated line-item cell to "its row". That
// needs semantic/visual disambiguation (a backend that merged two columns into one
// x-range, or a row whose sibling cells are themselves mislocated, cannot be fixed
// by geometry alone) — that is Fabry's job (vision), and the overlap guard keeps us
// from writing a bad box regardless.

const EPS = 0.5; // px² — shared edges / sub-pixel touches don't count as overlap

// Shared token normalization for value↔OCR matching: case-insensitive, trailing-%
// tolerant, and decimal/thousands separator agnostic ('1000,2' ≡ '1000.2').
export function normToken(s) {
  return String(s).trim().toLowerCase().replace(/%$/, '').replace(/[.,]/g, '');
}

// Words whose center lies inside `box`.
export function wordsInBox(box, ocrWords) {
  return (ocrWords || []).filter((w) => {
    if (!w.position) return false;
    const cx = (w.position[0] + w.position[2]) / 2;
    const cy = (w.position[1] + w.position[3]) / 2;
    return box[0] <= cx && cx <= box[2] && box[1] <= cy && cy <= box[3];
  });
}

// THE box invariant: a box is only correct if it contains (at least part of) its
// value's text. Empty values and boxes over OCR-less regions are not judged.
export function boxMatchesValue(value, box, ocrWords) {
  const v = String(value ?? '').trim();
  if (!v || !box) return true;
  const inside = wordsInBox(box, ocrWords).map((w) => normToken(w.text));
  if (!inside.length) return true; // no OCR there — cannot judge (stamp/handwriting)
  // Split on whitespace AND common value separators: a normalized date
  // '2025-01-06' shares its '2025' token with the printed 'Jan 6, 2025'.
  const tokens = v.split(/[\s\-_/]+/).map(normToken).filter(Boolean);
  return tokens.some((t) => inside.some((w) => w === t || (t.length >= 3 && w.includes(t))));
}

export function boxArea(b) {
  return b ? Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]) : 0;
}

export function intersectionArea(a, b) {
  if (!a || !b) return 0;
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  return ix * iy;
}

export function boxesOverlap(a, b) {
  return intersectionArea(a, b) > EPS;
}

function centerIn(word, box) {
  const cx = (word[0] + word[2]) / 2;
  const cy = (word[1] + word[3]) / 2;
  return box[0] <= cx && cx <= box[2] && box[1] <= cy && cy <= box[3];
}

// Tighten a box to the padded union of OCR words whose center lies inside it.
// Returns the box unchanged if no words are inside (nothing to hug).
export function tightenBox(box, ocrWords, pad = 1) {
  if (!box) return box;
  const inside = (ocrWords || []).filter((w) => w.position && centerIn(w.position, box)).map((w) => w.position);
  if (!inside.length) return box;
  const u = [
    Math.min(...inside.map((b) => b[0])), Math.min(...inside.map((b) => b[1])),
    Math.max(...inside.map((b) => b[2])), Math.max(...inside.map((b) => b[3])),
  ];
  return [u[0] - pad, u[1] - pad, u[2] + pad, u[3] + pad];
}

function sameBox(a, b) { return a && b && a.length === b.length && a.every((n, i) => Math.abs(n - b[i]) < 0.5); }

// True when a candidate box overlaps ANY of the given other-field boxes (its own
// datapoint excluded). Used by the loop to drop a would-be-overlapping write.
export function overlapsAny(box, others) {
  return (others || []).some((o) => boxesOverlap(box, o));
}

// Produce box-only tighten changes for fields whose box is materially looser than the
// OCR words it contains. Tightening only shrinks, so no new overlaps are created.
// Input: { fields, ocrPages }. Output: change[] = { datapointId, oldBox, newBox, boxSource:'tighten', page }.
// `minSlack` gates the change so we don't churn boxes that are already tight.
export function tightenFields({ fields, ocrPages, minSlack = 1.15 }) {
  const wordsByPage = Object.fromEntries((ocrPages || []).map((p) => [p.page, p.words || []]));
  const out = [];
  for (const f of fields || []) {
    if (!Array.isArray(f.position)) continue;
    const t = tightenBox(f.position, wordsByPage[f.page] || [], 1);
    if (sameBox(t, f.position)) continue;
    // Only emit when the current box is meaningfully looser than the tight one.
    if (boxArea(f.position) < boxArea(t) * minSlack) continue;
    out.push({ datapointId: f.datapointId, oldBox: f.position, newBox: t, boxSource: 'tighten', page: f.page });
  }
  return out;
}

// The y-band [minY, maxY] of a line-item row, from the OTHER boxed cells of the same
// (table, row) — excluding cells whose box is shared with other rows (stacked artifacts
// must not pollute the band). Null when the row has no clean sibling boxes.
export function rowBandOf(fields, mvSchemaId, rowIndex, excludeDatapointId) {
  const stackCounts = {};
  for (const f of fields || []) {
    if (f.inLineItem && f.mvSchemaId === mvSchemaId && Array.isArray(f.position)) {
      const k = f.schemaId + '|' + f.position.join(',');
      stackCounts[k] = (stackCounts[k] || 0) + 1;
    }
  }
  const sib = (fields || []).filter((f) => f.inLineItem && f.mvSchemaId === mvSchemaId
    && f.rowIndex === rowIndex && f.datapointId !== excludeDatapointId && Array.isArray(f.position)
    && stackCounts[f.schemaId + '|' + f.position.join(',')] === 1);
  if (!sib.length) return null;
  return [Math.min(...sib.map((f) => f.position[1])), Math.max(...sib.map((f) => f.position[3]))];
}

// Orphaned-box sweep: a field with an EMPTY value but a box carries no information —
// and when that box overlaps a NON-empty field's box it visually squats on someone
// else's text (a backend mis-extraction residue). Emit a clear-box change for it.
export function orphanClears({ fields }) {
  const out = [];
  const boxed = (fields || []).filter((f) => Array.isArray(f.position));
  for (const f of boxed) {
    if (String(f.value ?? '') !== '') continue; // only empty-valued fields
    const clashes = boxed.some((g) => g.datapointId !== f.datapointId && g.page === f.page
      && String(g.value ?? '') !== '' && boxesOverlap(f.position, g.position));
    if (!clashes) continue;
    out.push({
      datapointId: f.datapointId, schemaId: f.schemaId, rowIndex: f.rowIndex ?? null,
      oldValue: f.value ?? null, newValue: f.value ?? '', oldBox: f.position, newBox: null,
      page: f.page, boxSource: 'cleared', reason: 'orphaned box removed (empty field over another field’s text)',
      confidence: null, valueChanged: false, boxChanged: true, clearBox: true,
    });
  }
  return out;
}

// True when a valued field's box provably sits on OTHER fields' text: at least
// `minHits` of the words inside it exactly match other same-page fields' VALUES
// while none match its own. Such a box is a wrong extraction residue and may be
// cleared to make room (its value is kept).
export function boxSquatsOnOthers(field, fields, ocrWords, minHits = 2) {
  if (!Array.isArray(field.position) || String(field.value ?? '') === '') return false;
  const norm = (x) => String(x).trim().toLowerCase();
  const inside = (ocrWords || []).filter((w) => {
    const cx = (w.position[0] + w.position[2]) / 2;
    const cy = (w.position[1] + w.position[3]) / 2;
    return field.position[0] <= cx && cx <= field.position[2] && field.position[1] <= cy && cy <= field.position[3];
  }).map((w) => norm(w.text));
  if (!inside.length) return false;
  const own = String(field.value ?? '').split(/\s+/).map(norm);
  if (inside.some((t) => own.includes(t))) return false; // contains its own value → plausible box
  const otherValues = new Set((fields || [])
    .filter((g) => g.datapointId !== field.datapointId && String(g.value ?? '') !== '')
    .flatMap((g) => String(g.value).split(/\s+/).map(norm)));
  const hits = inside.filter((t) => otherValues.has(t)).length;
  return hits >= minHits;
}

// Shrink an engulfing box: when valued field A's box fully CONTAINS valued field
// B's box (A swallowed B's text line — a repeated-token matching artifact), shrink
// A to the slice of its region OUTSIDE B's y-span that still holds OCR words.
export function shrinkEngulfingBoxes({ fields, ocrPages }) {
  const wordsByPage = Object.fromEntries((ocrPages || []).map((p) => [p.page, p.words || []]));
  const boxed = (fields || []).filter((f) => Array.isArray(f.position) && String(f.value ?? '') !== '');
  const contains = (a, b) => a[0] <= b[0] + 0.5 && a[1] <= b[1] + 0.5 && a[2] >= b[2] - 0.5 && a[3] >= b[3] - 0.5
    && boxArea(a) > boxArea(b) + 1;
  const out = [];
  for (const A of boxed) {
    for (const B of boxed) {
      if (A.datapointId === B.datapointId || A.page !== B.page) continue;
      if (!contains(A.position, B.position)) continue;
      const words = wordsByPage[A.page] || [];
      const below = [A.position[0], B.position[3] + 1, A.position[2], A.position[3]];
      const above = [A.position[0], A.position[1], A.position[2], B.position[1] - 1];
      for (const region of [below, above]) {
        if (region[3] - region[1] < 4) continue;
        const t = tightenBox(region, words, 1);
        if (t !== region) {
          out.push({ datapointId: A.datapointId, oldBox: A.position, newBox: t, boxSource: 'row-align', page: A.page });
          break;
        }
      }
      break;
    }
  }
  return out;
}

// Line-coherent, claim-aware token matching. Tokens are matched RAREST-FIRST; the
// rarest token anchors a text LINE, and the remaining tokens prefer words on that
// same line — so 'Feb 6, 2025' can never bind '6,' from one date line and 'Feb'
// from another (the spanning-box class of wrong boxes). Words inside another
// field's box are avoided (claimed text belongs to that field). Each word is used
// at most once. Returns the matched word positions, or null.
export function matchValueWords(tokens, candidateWords, claimedBoxes) {
  const pool = (candidateWords || []).slice();
  const isClaimed = (w) => (claimedBoxes || []).some((b) => {
    const cx = (w.position[0] + w.position[2]) / 2;
    const cy = (w.position[1] + w.position[3]) / 2;
    return b[0] <= cx && cx <= b[2] && b[1] <= cy && cy <= b[3];
  });
  const hitsFor = (tok, words) => words.filter((w) => normToken(w.text) === tok);
  const counts = tokens.map((t) => hitsFor(t, pool).length);
  if (!counts.some((c) => c > 0)) return null; // nothing matches at all
  // Tokens absent from the page are skipped (the agent may include a stray token);
  // the ones that DO match still anchor line-coherently, rarest first.
  const order = tokens.map((t, i) => i).filter((i) => counts[i] > 0).sort((a, b) => counts[a] - counts[b]);
  const picked = [];
  let line = null;
  for (const i of order) {
    let hits = hitsFor(tokens[i], pool);
    if (line) {
      const onLine = hits.filter((w) => {
        const cy = (w.position[1] + w.position[3]) / 2;
        return line[0] <= cy && cy <= line[1];
      });
      if (onLine.length) hits = onLine;
    }
    // Claims are a PREFERENCE, not a veto: when every candidate is inside another
    // field's box, still pick one — the overlap guard downstream owns the conflict
    // (it can tighten the neighbor away, clear a squatter, or drop this box).
    // A hard veto here deadlocks: a wrong box claiming the words would prevent the
    // very reseed whose clash is what gets the wrong box cleared.
    const unclaimed = hits.filter((w) => !isClaimed(w));
    const pick = (unclaimed.length ? unclaimed : hits).sort((a, b) => a.position[1] - b.position[1])[0];
    if (!pick) return null;
    picked.push(pick);
    pool.splice(pool.indexOf(pick), 1);
    if (!line) {
      const h = pick.position[3] - pick.position[1];
      line = [pick.position[1] - h * 0.6, pick.position[3] + h * 0.6];
    }
  }
  return picked.map((w) => w.position.slice()); // copies — never alias shared OCR data
}

// Find the box for a field's VALUE from the strongest available evidence region:
// row band (boxed siblings) ∩ column strip (same-schema boxed cells) for table
// cells; the whole page for header fields. Claim-aware and line-coherent.
export function findValueBox(f, fields, wordsByPage) {
  const value = String(f.value ?? '').trim();
  if (!value) return null;
  const band = f.inLineItem ? rowBandOf(fields, f.mvSchemaId, f.rowIndex, f.datapointId) : null;
  const sameCol = f.inLineItem ? (fields || []).filter((g) => g.inLineItem && g.mvSchemaId === f.mvSchemaId
    && g.schemaId === f.schemaId && g.datapointId !== f.datapointId && Array.isArray(g.position)) : [];
  const strip = sameCol.length
    ? [Math.min(...sameCol.map((g) => g.position[0])) - 2, Math.max(...sameCol.map((g) => g.position[2])) + 2]
    : null;
  if (f.inLineItem && !band && !strip) return null; // table cell with no anchor — don't guess a row
  const page = f.page ?? ((fields || []).find((g) => Array.isArray(g.position) && g.page != null
    && (!f.inLineItem || g.mvSchemaId === f.mvSchemaId)) || {}).page ?? Object.keys(wordsByPage)[0];
  if (page == null) return null;
  const candidates = (wordsByPage[page] || []).filter((w) => {
    const cx = (w.position[0] + w.position[2]) / 2;
    const cy = (w.position[1] + w.position[3]) / 2;
    if (band && (cy < band[0] || cy > band[1])) return false;
    if (strip && (cx < strip[0] || cx > strip[1])) return false;
    return true;
  });
  const claimed = (fields || []).filter((g) => g.datapointId !== f.datapointId && Array.isArray(g.position))
    .map((g) => g.position);
  const picked = matchValueWords(value.split(/\s+/).map(normToken), candidates, claimed);
  if (!picked) return null;
  const u = [
    Math.min(...picked.map((b) => b[0])) - 1, Math.min(...picked.map((b) => b[1])) - 1,
    Math.max(...picked.map((b) => b[2])) + 1, Math.max(...picked.map((b) => b[3])) + 1,
  ];
  return { box: u, page: Number(page) };
}

// Repair pass: a valued field whose box does NOT contain its value's text is a
// WRONG box (worse than none — it points the reviewer at the wrong evidence).
// Relocate it to the value's real location when findable; otherwise clear it.
export function repairMismatchedBoxes({ fields, ocrPages }) {
  const wordsByPage = Object.fromEntries((ocrPages || []).map((p) => [p.page, p.words || []]));
  const out = [];
  for (const f of fields || []) {
    if (!Array.isArray(f.position) || String(f.value ?? '') === '') continue;
    if (boxMatchesValue(f.value, f.position, wordsByPage[f.page] || [])) continue;
    const found = findValueBox({ ...f, position: null }, fields.filter((g) => g.datapointId !== f.datapointId), wordsByPage);
    // Relocate only. Our value↔print matching is deliberately incomplete (formats,
    // abbreviations) — when the value's true location can't be found, LEAVING the
    // existing box beats clearing a possibly-correct one.
    if (found) {
      out.push({ datapointId: f.datapointId, oldBox: f.position, newBox: found.box, boxSource: 'row-align', page: found.page, repair: true });
    }
  }
  return out;
}

// Re-seed a boxless VALUED line-item cell by finding its VALUE's tokens in the
// OCR, constrained to the strongest available evidence region: the row's y-band
// (from boxed siblings) and/or the column's x-strip (from same-schema boxed cells
// in other rows). Every token must match exactly one word in the region — any
// ambiguity skips the cell (the overlap guard downstream is the final net). This
// recovers cells whose boxes (and rir evidence) were wiped externally.
export function reseedFromRir({ fields, ocrPages }) {
  const wordsByPage = Object.fromEntries((ocrPages || []).map((p) => [p.page, p.words || []]));
  const out = [];
  for (const f of fields || []) {
    if (!f.inLineItem || Array.isArray(f.position)) continue;
    if (String(f.value ?? '').trim() === '') continue;
    const found = findValueBox(f, fields, wordsByPage);
    if (!found) continue;
    out.push({ datapointId: f.datapointId, oldBox: null, newBox: found.box, boxSource: 'row-align', page: found.page });
  }
  return out;
}

// Whole-table value-anchored reseed: when a table has valued cells but NO boxed
// cell at all (a full wipe), match each ROW's value-tuple against the page's OCR
// text lines: a line must exactly match ≥2 of the row's distinct cell values
// (numeric values also match their printed '%'-suffixed form), rows must map to
// lines injectively and in order, and every row must match exactly one line —
// otherwise the table is left alone (never guess). Emits per-cell boxes for the
// matched words.
export function reseedTableByValues({ fields, ocrPages }) {
  const norm = (x) => String(x).trim().toLowerCase();
  const stripPct = (x) => x.endsWith('%') ? x.slice(0, -1) : x;
  const out = [];
  const tables = [...new Set((fields || []).filter((f) => f.inLineItem && f.mvSchemaId).map((f) => f.mvSchemaId))];
  for (const mv of tables) {
    const cells = fields.filter((f) => f.inLineItem && f.mvSchemaId === mv);
    if (cells.some((f) => Array.isArray(f.position))) continue; // anchored tables use the banded reseed
    const rows = [...new Set(cells.map((f) => f.rowIndex))].sort((a, b) => a - b)
      .map((r) => ({ r, cells: cells.filter((f) => f.rowIndex === r && String(f.value ?? '') !== '') }))
      .filter((row) => row.cells.length);
    if (rows.length < 1) continue;
    for (const page of ocrPages || []) {
      // Cluster the page's words into horizontal text lines.
      const sorted = page.words.slice().sort((a, b) => a.position[1] - b.position[1]);
      const lines = [];
      for (const w of sorted) {
        const last = lines[lines.length - 1];
        if (last && w.position[1] <= last.bottom + 3) { last.words.push(w); last.bottom = Math.max(last.bottom, w.position[3]); continue; }
        lines.push({ top: w.position[1], bottom: w.position[3], words: [w] });
      }
      // For each row, the lines that match ≥2 of its distinct cell values.
      const need = (row) => Math.min(2, row.cells.length);
      const rowLines = rows.map((row) => {
        const hits = [];
        lines.forEach((line, li) => {
          const avail = line.words.slice();
          let matched = 0;
          const picks = {};
          for (const c of row.cells) {
            const v = norm(c.value);
            const i = avail.findIndex((w) => { const t = norm(w.text); return t === v || stripPct(t) === v; });
            if (i !== -1) { picks[c.datapointId] = avail[i]; avail.splice(i, 1); matched++; }
          }
          if (matched >= need(row)) hits.push({ li, picks });
        });
        return hits;
      });
      if (!rowLines.every((h) => h.length === 1)) continue; // ambiguous or missing → don't guess
      const lis = rowLines.map((h) => h[0].li);
      if (!lis.every((li, i) => i === 0 || li > lis[i - 1])) continue; // rows must be in reading order
      for (let i = 0; i < rows.length; i++) {
        for (const [dpId, w] of Object.entries(rowLines[i][0].picks)) {
          out.push({
            datapointId: Number(dpId), oldBox: null,
            newBox: [w.position[0] - 1, w.position[1] - 1, w.position[2] + 1, w.position[3] + 1],
            boxSource: 'row-align', page: page.page,
          });
        }
      }
      break; // matched on this page
    }
  }
  return out;
}

// De-stack a known backend artifact: N rows of the SAME table column sharing a
// byte-identical box (legitimately impossible — one printed value can't belong to
// every row). Each stacked cell whose row-band doesn't contain the box is relocated:
// OCR words are searched within (column x-range × the row's y-band) and the box
// tightened to them. Rows without a band or without words there are left alone.
export function destackFields({ fields, ocrPages }) {
  const wordsByPage = Object.fromEntries((ocrPages || []).map((p) => [p.page, p.words || []]));
  const groups = {};
  for (const f of fields || []) {
    if (!f.inLineItem || !Array.isArray(f.position)) continue;
    const k = `${f.mvSchemaId}|${f.schemaId}|${f.position.join(',')}`;
    (groups[k] = groups[k] || []).push(f);
  }
  const out = [];
  for (const members of Object.values(groups)) {
    if (members.length < 2) continue; // not stacked
    for (const f of members) {
      const band = rowBandOf(fields, f.mvSchemaId, f.rowIndex, f.datapointId);
      if (!band) continue;
      const cy = (f.position[1] + f.position[3]) / 2;
      if (band[0] <= cy && cy <= band[1]) continue; // this row genuinely owns the box
      const region = [f.position[0], band[0], f.position[2], band[1]];
      const t = tightenBox(region, wordsByPage[f.page] || [], 1);
      if (t === region) continue; // no words in the row's slice of this column
      out.push({ datapointId: f.datapointId, oldBox: f.position, newBox: t, boxSource: 'row-align', page: f.page });
    }
  }
  return out;
}
