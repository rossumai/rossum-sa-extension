// Pure: parse Fabry's correction proposals, resolve boxes (hybrid snap-to-OCR /
// pixel fallback), and diff against the current fields. No DOM, no network.

import { stripFences, safeParseArray } from '../../mdh/llmPipeline.js';
import { matchValueWords, normToken } from './geometry.js';

// Find the index of the ']' that matches the '[' at `start`, treating brackets
// inside JSON string literals as opaque (so a `reason` field containing `[`/`]`
// doesn't truncate the scan). Returns -1 if unmatched.
function balancedArrayEnd(s, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function isObjectArray(a) {
  return Array.isArray(a) && a.length > 0 && a.every((o) => o && typeof o === 'object' && !Array.isArray(o));
}

function firstJsonArray(text) {
  if (typeof text !== 'string') return null;

  const fenceRe = /```(?:json)?\s*\n?([\s\S]*?)```/gi;
  let fenceMatch;
  while ((fenceMatch = fenceRe.exec(text))) {
    const a = safeParseArray(fenceMatch[1].trim());
    if (Array.isArray(a)) return a;
  }

  const whole = safeParseArray(stripFences(text).trim());
  if (Array.isArray(whole)) return whole;

  for (let i = text.indexOf('['); i !== -1; i = text.indexOf('[', i + 1)) {
    const end = balancedArrayEnd(text, i);
    if (end === -1) continue;
    const a = safeParseArray(text.slice(i, end + 1).trim());
    if (isObjectArray(a)) return a;
  }

  return null;
}

export function parseProposal(replyText) {
  const arr = firstJsonArray(replyText);
  if (!arr) return [];
  return arr
    .filter((o) => o && typeof o === 'object' && (typeof o.schema_id === 'string' || typeof o.datapoint_id === 'number'))
    .map((o) => ({
      schemaId: typeof o.schema_id === 'string' ? o.schema_id : null,
      datapointId: typeof o.datapoint_id === 'number' ? o.datapoint_id : null,
      table: typeof o.table === 'string' ? o.table : null,
      row: typeof o.row === 'number' ? o.row : null,
      newValue: o.new_value ?? null,
      boxWords: Array.isArray(o.box_words) ? o.box_words.map(String) : null,
      boxPixels: Array.isArray(o.box_pixels) && o.box_pixels.length === 4 ? o.box_pixels.map(Number) : null,
      page: o.page ?? null,
      reason: typeof o.reason === 'string' ? o.reason : '',
      confidence: typeof o.confidence === 'number' ? o.confidence : null,
    }));
}

function unionBox(boxes) {
  return boxes.reduce((a, b) => [
    Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3]),
  ]);
}

function clampBox(box, w, h) {
  if (!w || !h) return box.map((n) => Math.max(0, n));
  return [
    Math.max(0, Math.min(box[0], w)), Math.max(0, Math.min(box[1], h)),
    Math.max(0, Math.min(box[2], w)), Math.max(0, Math.min(box[3], h)),
  ];
}

// Resolve the field a proposal targets: by datapoint id, by (table, row, schema)
// for table cells, or by unique schema id — the SAME ladder diffProposals applies,
// so band/claim resolution can never disagree with diffing about the target.
// Null when unknown or ambiguous.
export function targetFieldOf(p, fields) {
  if (p.datapointId != null) {
    return (fields || []).find((x) => x.datapointId === p.datapointId) || null;
  }
  if (p.table && p.row != null && p.schemaId) {
    return (fields || []).find((x) => x.inLineItem && x.mvSchemaId === p.table
      && x.rowIndex === p.row && x.schemaId === p.schemaId) || null;
  }
  const matches = (fields || []).filter((x) => x.schemaId === p.schemaId);
  return matches.length === 1 ? matches[0] : null;
}

// Resolve each proposal's box. `fields` (optional) enables ROW-BAND matching for
// line-item proposals: with repeated tokens on the page (e.g. the same quantity
// printed on every row), an unconstrained text match always snaps to the FIRST
// occurrence — restacking every row onto row 1. When the proposal targets a
// line-item datapoint whose row has a y-band (from its sibling cells), candidate
// words are restricted to that band first, falling back to the whole page.
export function resolveBoxes(proposals, ocrPages, fields) {
  const byPage = Object.fromEntries((ocrPages || []).map((p) => [p.page, p]));
  const bandFor = (p) => {
    const f = targetFieldOf(p, fields);
    if (!f || !f.inLineItem || f.rowIndex == null) return null;
    const sib = (fields || []).filter((x) => x.inLineItem && x.mvSchemaId === f.mvSchemaId
      && x.rowIndex === f.rowIndex && x.datapointId !== f.datapointId && Array.isArray(x.position));
    if (!sib.length) return null;
    return [Math.min(...sib.map((x) => x.position[1])), Math.max(...sib.map((x) => x.position[3]))];
  };
  // Line-coherent, claim-aware matching (matchValueWords): tokens anchor on the
  // rarest word and stay on ONE text line — a date's '2025' can no longer bind to
  // the neighbouring date's line. Words inside other fields' boxes are avoided.
  const claimedFor = (p) => {
    const f = targetFieldOf(p, fields);
    return (fields || [])
      .filter((g) => (!f || g.datapointId !== f.datapointId) && Array.isArray(g.position))
      .map((g) => g.position);
  };
  return proposals.map((p) => {
    const page = byPage[p.page];
    if (p.boxWords && p.boxWords.length && page) {
      const band = bandFor(p);
      const inBand = band
        ? page.words.filter((w) => { const cy = (w.position[1] + w.position[3]) / 2; return band[0] <= cy && cy <= band[1]; })
        : null;
      const tokens = p.boxWords.map(normToken);
      const claimed = claimedFor(p);
      let matched = inBand ? matchValueWords(tokens, inBand, claimed) : null;
      if (!matched) matched = matchValueWords(tokens, page.words, claimed);
      if (matched && matched.length) return { ...p, resolvedBox: unionBox(matched), boxSource: 'ocr' };
    }
    if (p.boxPixels) {
      return { ...p, resolvedBox: clampBox(p.boxPixels, page && page.width, page && page.height), boxSource: 'pixels' };
    }
    return { ...p, resolvedBox: null, boxSource: 'none' };
  });
}

function sameBox(a, b) {
  if (!a || !b) return a === b;
  return a.length === b.length && a.every((n, i) => Number(n) === Number(b[i]));
}

export function diffProposals(resolved, fields) {
  const out = [];
  for (const p of resolved) {
    // targetFieldOf's ladder: datapoint id → (table, row, schema) addressing (unique
    // by construction, lets the agent target table cells without a dp# inventory) →
    // schema id ONLY when unique (a line-item schema id is shared across every row,
    // so a non-unique match is ambiguous — skip rather than guess).
    const f = targetFieldOf(p, fields);
    if (!f) continue; // unknown datapoint id, or unknown/ambiguous schema → skip, never write to the wrong field/row
    const newValue = p.newValue;
    const newBox = p.resolvedBox;
    const valueChanged = newValue != null && String(newValue) !== String(f.value ?? '');
    const boxChanged = !!newBox && !sameBox(newBox, f.position);
    if (!valueChanged && !boxChanged) continue;
    out.push({
      schemaId: f.schemaId, datapointId: f.datapointId, rowIndex: f.rowIndex ?? null,
      oldValue: f.value ?? null, newValue: valueChanged ? newValue : (f.value ?? null),
      oldBox: f.position, newBox: boxChanged ? newBox : f.position,
      page: p.page ?? f.page, boxSource: p.boxSource,
      reason: p.reason, confidence: p.confidence,
      valueChanged, boxChanged,
    });
  }
  return out;
}
