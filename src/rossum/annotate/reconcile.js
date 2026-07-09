// RECONCILE: diff a Fabry document READING against the current annotation and
// emit write changes (same shape diffProposals produced) + rows to add. Pure.
//
// Policy (owner-approved):
// - empty field + read value → FILL (+ located box when the quote is found);
// - valued field, reading agrees under the parse-aware comparator → KEEP the
//   value; if the field is boxless and the quote locates → box-only change;
// - valued field, MATERIAL disagreement → correction;
// - enum fields are conservative: write only exact option-value matches;
// - read rows beyond the annotation's rows → add_row (values only — they get
//   boxes on the NEXT pass from the same cached reading);
// - rows pair IN ORDER (v1: an annotation missing its FIRST printed row would
//   mispair — accepted, documented in the spec);
// - never delete rows, never touch fields the reading doesn't mention.
import { locateTable, locateQuote } from './align.js';

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const iso = (y, mo, d) => (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null);

// All defensible calendar-date interpretations of a string (ISO, M/D/Y, D/M/Y,
// month-name). Two values denote the same date when their sets intersect.
export function dateCandidates(s) {
  const out = new Set();
  const str = String(s ?? '').trim();
  let m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) { const d = iso(+m[1], +m[2], +m[3]); if (d) out.add(d); }
  m = str.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (m) {
    const a = iso(+m[3], +m[1], +m[2]); // M/D/Y
    const b = iso(+m[3], +m[2], +m[1]); // D/M/Y
    if (a) out.add(a);
    if (b) out.add(b);
  }
  m = str.match(/^([a-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/i) || str.match(/^(\d{1,2})\.?\s+([a-z]{3,})\.?\s+(\d{4})$/i);
  if (m) {
    const name = (isNaN(+m[1]) ? m[1] : m[2]).slice(0, 3).toLowerCase();
    const day = isNaN(+m[1]) ? +m[2] : +m[1];
    const mo = MONTHS[name];
    if (mo) { const d = iso(+m[3], mo, day); if (d) out.add(d); }
  }
  return out;
}

// Parse a printed number, understanding grouping vs decimal separators. Returns
// a finite number or null — NEVER a digits-only guess ('1.5' vs '15' must differ).
export function parseNumberLoose(s) {
  const str = String(s ?? '').trim().replace(/\s/g, '');
  if (/^-?\d+$/.test(str)) return Number(str);
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(str)) return Number(str.replace(/,/g, ''));
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(str)) return Number(str.replace(/\./g, '').replace(',', '.'));
  if (/^-?\d+\.\d+$/.test(str)) return Number(str);
  if (/^-?\d+,\d+$/.test(str)) return Number(str.replace(',', '.'));
  return null;
}

// Parse-aware equality: format-only differences are NOT material. Unknown
// formats compare case-insensitively; when in doubt, values are treated as
// equal only on that exact basis (we never churn correct values).
export function sameValueLoose(readV, curV) {
  const a = String(readV ?? '').trim();
  const b = String(curV ?? '').trim();
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.toLowerCase() === b.toLowerCase()) return true;
  const na = parseNumberLoose(a);
  const nb = parseNumberLoose(b);
  if (na != null && nb != null) return Math.abs(na - nb) < 1e-9;
  if (na != null || nb != null) return false; // one numeric, one not
  const da = dateCandidates(a);
  if (da.size) {
    const db = dateCandidates(b);
    if (db.size) return [...da].some((d) => db.has(d));
  }
  return false;
}

// Enum guard: the canonical option value for a read value (exact, case-insensitive,
// value or label) — or null when it maps to nothing. Enums are never fuzzy-matched.
export function enumCanonical(readV, schemaField) {
  const opts = schemaField && Array.isArray(schemaField.options) ? schemaField.options : null;
  if (!opts || !opts.length) return undefined; // not an enum — caller keeps the raw value
  const v = String(readV ?? '').trim().toLowerCase();
  const hit = opts.find((o) => o.value.toLowerCase() === v || o.label.toLowerCase() === v);
  return hit ? hit.value : null;
}

function change(f, { newValue = null, newBox = null, page = null, reason }) {
  const valueChanged = newValue != null && String(newValue) !== String(f.value ?? '');
  const boxChanged = !!newBox;
  return {
    schemaId: f.schemaId, datapointId: f.datapointId, rowIndex: f.rowIndex ?? null,
    oldValue: f.value ?? null, newValue: valueChanged ? newValue : (f.value ?? null),
    oldBox: f.position ?? null, newBox: boxChanged ? newBox : (f.position ?? null),
    page: page ?? f.page ?? null, boxSource: boxChanged ? 'ocr' : 'none',
    reason, confidence: null, valueChanged, boxChanged,
  };
}

// Reconcile one field against its read (value, printed, locate() → {box,page}|null).
function reconcileField(f, sf, readValue, locate, out) {
  const cur = String(f.value ?? '');
  let value = readValue == null ? null : String(readValue);
  const canonical = enumCanonical(value, sf);
  if (canonical !== undefined) {
    if (canonical === null) return; // enum the reading can't map exactly → leave alone
    value = canonical;
  }
  if (cur === '') {
    if (value == null || value === '') return;
    const found = locate();
    out.push(change(f, { newValue: value, newBox: found && found.box, page: found && found.page, reason: 'read from document' }));
  } else if (value != null && value !== '' && !sameValueLoose(value, cur)) {
    const found = locate();
    out.push(change(f, { newValue: value, newBox: found && found.box, page: found && found.page, reason: 'differs from document' }));
  } else if (!Array.isArray(f.position)) {
    const found = locate();
    if (found) out.push(change(f, { newBox: found.box, page: found.page, reason: 'box located from document text' }));
  }
}

// reading: parseReading output. Returns { changes, addRows } where changes feed
// snapAndGuard/buildReplaceOperations and addRows feed buildAddOperations.
// `skipValueIds`: datapoints whose value was set by a VALIDATION-driven refine
// turn — those outrank the raw reading (the page may print a value master data
// rejects), so reconcile must never write them back and oscillate.
export function reconcileReading(reading, { fields, ocrPages, schemaFields, skipValueIds }) {
  const changes = [];
  const addRows = [];
  if (!reading) return { changes, addRows };
  const skip = skipValueIds || new Set();
  const sfBy = Object.fromEntries((schemaFields || []).map((s) => [s.schemaId, s]));
  const byPage = Object.fromEntries((ocrPages || []).map((p) => [p.page, p]));
  const firstPage = (ocrPages || [])[0];
  const claimedFor = (f) => (fields || [])
    .filter((g) => g.datapointId !== f.datapointId && Array.isArray(g.position))
    .map((g) => g.position);

  for (const h of reading.headers || []) {
    const matches = (fields || []).filter((f) => !f.inLineItem && f.schemaId === h.schemaId);
    if (matches.length !== 1) continue; // unknown or ambiguous header → never guess
    const f = matches[0];
    if (skip.has(f.datapointId)) continue;
    const page = (h.page != null && byPage[h.page]) || (f.page != null && byPage[f.page]) || firstPage;
    reconcileField(f, sfBy[h.schemaId], h.value, () => locateQuote(h.printed, page, claimedFor(f)), changes);
  }

  for (const t of reading.tables || []) {
    const cells = (fields || []).filter((f) => f.inLineItem && f.mvSchemaId === t.table);
    const annRows = [...new Set(cells.map((f) => f.rowIndex))].sort((a, b) => a - b);
    const located = locateTable(t.rows, ocrPages);
    for (let i = 0; i < (t.rows || []).length; i++) {
      const readRow = t.rows[i];
      const loc = located && located.rows[i];
      if (i < annRows.length) {
        const rowIdx = annRows[i];
        for (const rc of readRow.cells) {
          const f = cells.find((x) => x.rowIndex === rowIdx && x.schemaId === rc.schemaId);
          if (!f || skip.has(f.datapointId)) continue;
          const box = loc && loc.boxes[rc.schemaId];
          reconcileField(f, sfBy[rc.schemaId], rc.value, () => (box ? { box, page: located.page } : null), changes);
        }
      } else {
        const rowCells = readRow.cells
          .filter((c) => c.value != null && String(c.value) !== '')
          .map((c) => {
            const canonical = enumCanonical(c.value, sfBy[c.schemaId]);
            if (canonical === null) return null; // unmappable enum cell → drop the cell
            return { schemaId: c.schemaId, value: canonical !== undefined ? canonical : String(c.value) };
          })
          .filter(Boolean);
        if (rowCells.length) addRows.push({ table: t.table, cells: rowCells });
      }
    }
  }
  return { changes, addRows };
}
