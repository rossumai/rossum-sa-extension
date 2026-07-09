// Pure: snapshot + content-operation builders for the "Annotate for me" feature.

export function snapshotFields(fields, datapointIds) {
  const snap = {};
  for (const id of datapointIds) {
    const f = fields.find((x) => x.datapointId === id);
    if (f) snap[id] = { value: f.value ?? null, position: f.position ?? null, page: f.page ?? null };
  }
  return snap;
}

function contentOf(value, box, page) {
  const content = { value: value ?? null };
  if (box) { content.position = box; content.page = page; }
  return { content };
}

export function buildReplaceOperations(changes) {
  return changes.map((c) => {
    if (c.clearBox) {
      // Clears an orphaned box (empty-valued field whose box squats on another
      // field's text). position:null removes the box — verified live 2026-07-08.
      return { op: 'replace', id: c.datapointId, value: { content: { value: c.newValue ?? '', position: null } } };
    }
    return { op: 'replace', id: c.datapointId, value: contentOf(c.newValue, c.newBox, c.page) };
  });
}

export function buildRestoreOperations(snapshot) {
  return Object.keys(snapshot).filter((k) => !k.startsWith('__')).map((id) => {
    const s = snapshot[id];
    return { op: 'replace', id: Number(id), value: contentOf(s.value, s.position, s.page) };
  });
}

// Build `add` operations for missing table rows. addRows = [{ table:<mvSchemaId>, cells:[{schemaId, value}] }].
// `multivalues` maps a multivalue's schema_id → its content-node id. A row whose table id is
// unknown is SKIPPED (never guess a target). Cells carry values only (boxes come from a later
// geometry/refine pass, once the new datapoints exist and have server ids).
export function buildAddOperations(addRows, multivalues) {
  const ops = [];
  for (const r of addRows || []) {
    const mvId = multivalues ? multivalues[r.table] : undefined;
    if (mvId == null) continue;
    const cells = (r.cells || []).filter((c) => c && c.schemaId).map((c) => ({ schema_id: c.schemaId, content: { value: c.value ?? null } }));
    if (cells.length) ops.push({ op: 'add', id: mvId, value: cells });
  }
  return ops;
}

// Restore ops that REMOVE rows we added (for Undo). addedRowIds = tuple/datapoint ids returned
// by the add op's response. Emitted before the value-restores so the tree is clean.
export function buildRemoveOperations(addedRowIds) {
  return (addedRowIds || []).map((id) => ({ op: 'remove', id: Number(id) }));
}
