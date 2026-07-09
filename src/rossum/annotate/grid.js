// Pure grid logic for grid-governed tables. In Rossum, a multivalue table's
// annotation is rendered from its GRID (column x-positions mapped to schema ids ×
// row y-positions linked to tuples) — per-cell boxes are secondary and get
// reconciled against it. Fixing a table therefore means fixing the GRID and
// deriving cell boxes FROM it (disjoint by construction → overlaps impossible),
// not writing free-floating per-cell boxes. Grid writes go through a `replace`
// op on the multivalue's content id with value {grid} (verified live 2026-07-08).

// Extract every grid-backed multivalue from the content tree:
// [{ mvId, schemaId, grid, tupleIds }] (tupleIds in document order).
export function parseGridInfo(contentTree) {
  const out = [];
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (n.category === 'multivalue') {
        const tupleIds = (n.children || []).filter((t) => t && t.category === 'tuple').map((t) => t.id);
        if (n.grid && Array.isArray(n.grid.parts) && n.grid.parts.length) {
          out.push({ mvId: n.id, schemaId: n.schema_id, grid: n.grid, tupleIds });
        }
      }
      const ch = n.children;
      if (Array.isArray(ch)) walk(ch);
    }
  };
  walk(contentTree);
  return out;
}

const clone = (x) => JSON.parse(JSON.stringify(x));

// Remap a mis-assigned column: when a column's schema id S has ONLY empty-valued
// cells while exactly one valued table schema T has NO column, and T's extraction
// evidence (rir/ocr x-range) sits inside that column, the column belongs to T.
// (This is the "quantity extracted, but the grid says the column is item_code"
// backend artifact.) Anything ambiguous is left untouched — never guess.
export function remapEmptyColumns(gridInfo, fields, rirBoxOf = (f) => f.rirPosition || f.position || null) {
  const grid = clone(gridInfo.grid);
  const cells = fields.filter((f) => f.inLineItem && f.mvSchemaId === gridInfo.schemaId);
  const valuedSchemas = new Set(cells.filter((f) => String(f.value ?? '') !== '').map((f) => f.schemaId));
  const allSchemas = new Set(cells.map((f) => f.schemaId));
  let changed = false;
  for (const part of grid.parts) {
    const cols = part.columns || [];
    const mapped = new Set(cols.map((c) => c.schema_id).filter(Boolean));
    const unmappedValued = [...valuedSchemas].filter((s) => !mapped.has(s));
    for (let k = 0; k < cols.length; k++) {
      const col = cols[k];
      if (!col.schema_id || !allSchemas.has(col.schema_id)) continue;
      const colCells = cells.filter((f) => f.schemaId === col.schema_id);
      if (!colCells.length || colCells.some((f) => String(f.value ?? '') !== '')) continue; // column's schema has values → keep
      const right = k + 1 < cols.length ? cols[k + 1].left_position : col.left_position + (part.width || 0);
      // Candidate valued schemas without a column whose extraction x-evidence sits in this column.
      const candidates = unmappedValued.filter((s) => {
        const ev = cells.filter((f) => f.schemaId === s).map((f) => rirBoxOf(f)).filter(Boolean);
        if (!ev.length) return false;
        const cx = ev.map((b) => (b[0] + b[2]) / 2);
        return cx.every((x) => col.left_position <= x && x < right);
      });
      if (candidates.length === 1) { col.schema_id = candidates[0]; changed = true; }
    }
  }
  return changed ? grid : null;
}

// Link grid rows to tuples 1:1 by document order when the counts match and the
// rows aren't already linked. Returns the updated grid, or null if nothing to do.
export function linkGridRows(gridInfo) {
  const grid = clone(gridInfo.grid);
  let changed = false;
  let ti = 0;
  const rows = grid.parts.flatMap((p) => p.rows || []);
  if (rows.length !== gridInfo.tupleIds.length) return null; // ambiguous — don't guess
  for (const part of grid.parts) {
    for (const row of part.rows || []) {
      const want = gridInfo.tupleIds[ti++];
      if (row.tuple_id !== want) { row.tuple_id = want; changed = true; }
    }
  }
  return changed ? grid : null;
}

// Grow a grid to cover tuples that have no row yet (e.g. rows added by the
// pipeline): cluster the OCR words under the part's x-span into horizontal text
// lines below the first row; when the number of lines equals the number of
// tuples, rebuild rows at those line tops (and stretch the part's height).
export function extendGridRows(gridInfo, ocrPages) {
  const grid = clone(gridInfo.grid);
  const part = grid.parts[0];
  if (!part || grid.parts.length !== 1) return null;
  const rows = part.rows || [];
  if (rows.length >= gridInfo.tupleIds.length) return null;
  const page = (ocrPages || []).find((p) => p.page === part.page);
  if (!page) return null;
  const left = Math.min(...(part.columns || []).map((c) => c.left_position));
  const right = left + (part.width || 0);
  const top = rows.length ? Math.min(...rows.map((r) => r.top_position)) : null;
  if (top == null) return null;
  const words = page.words.filter((w) => {
    const cx = (w.position[0] + w.position[2]) / 2;
    return cx >= left && cx <= right && w.position[1] >= top - 2;
  }).sort((a, b) => a.position[1] - b.position[1]);
  const lines = [];
  for (const w of words) {
    const last = lines[lines.length - 1];
    if (last && w.position[1] <= last.bottom + 3) { last.bottom = Math.max(last.bottom, w.position[3]); continue; }
    lines.push({ top: w.position[1], bottom: w.position[3] });
  }
  if (lines.length !== gridInfo.tupleIds.length) return null; // ambiguous — don't guess
  part.rows = lines.map((l, i) => ({ type: rows[i] ? rows[i].type ?? null : null, tuple_id: gridInfo.tupleIds[i], top_position: l.top - 1 }));
  part.height = (lines[lines.length - 1].bottom + 1) - part.rows[0].top_position;
  return grid;
}

// Derive per-cell boxes from a (repaired) grid: cell region = column x-range ×
// row y-range, tightened to the OCR words inside. Only VALUED cells get boxes
// (empty cells would just recreate orphaned boxes). Regions are disjoint by
// construction, and tightening only shrinks → derived boxes can never overlap.
export function deriveCellBoxes(gridInfo, grid, fields, ocrPages, tightenBox) {
  const out = [];
  const cells = fields.filter((f) => f.inLineItem && f.mvSchemaId === gridInfo.schemaId);
  for (const part of grid.parts) {
    const page = (ocrPages || []).find((p) => p.page === part.page);
    const words = page ? page.words : [];
    const rows = (part.rows || []).slice().sort((a, b) => a.top_position - b.top_position);
    const cols = (part.columns || []).slice().sort((a, b) => a.left_position - b.left_position);
    const partBottom = rows.length ? rows[0].top_position + (part.height || 0) : 0;
    rows.forEach((row, j) => {
      if (row.tuple_id == null) return;
      const rowIndex = gridInfo.tupleIds.indexOf(row.tuple_id) + 1;
      if (!rowIndex) return;
      const y1 = row.top_position;
      const y2 = j + 1 < rows.length ? rows[j + 1].top_position : partBottom;
      cols.forEach((col, k) => {
        if (!col.schema_id) return;
        const f = cells.find((c) => c.schemaId === col.schema_id && c.rowIndex === rowIndex);
        if (!f || String(f.value ?? '') === '') return;
        const x1 = col.left_position;
        const x2 = k + 1 < cols.length ? cols[k + 1].left_position : x1 + (part.width || 0);
        const region = [x1, y1, x2, y2];
        const t = tightenBox(region, words, 1);
        const box = t === region ? null : t; // no words → no box (don't invent one)
        if (!box) return;
        const same = Array.isArray(f.position) && f.position.length === 4 && f.position.every((n, i) => Math.abs(n - box[i]) < 0.5);
        if (same) return;
        out.push({ datapointId: f.datapointId, oldBox: f.position, newBox: box, boxSource: 'grid', page: part.page });
      });
    });
  }
  return out;
}

export function buildGridOp(mvId, grid) {
  return { op: 'replace', id: mvId, value: { grid } };
}
