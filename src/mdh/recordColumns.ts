// Column set for the Table results view: union of top-level keys across the
// loaded page, _id first, then first-seen order. Nested values are rendered as
// expandable badges by RecordTable — they do not become their own columns.
export function deriveColumns(records: any[]): string[] {
  const seen = new Set();
  const cols = [];
  for (const rec of records || []) {
    if (!rec || typeof rec !== 'object') continue;
    for (const key of Object.keys(rec)) {
      if (!seen.has(key)) { seen.add(key); cols.push(key); }
    }
  }
  if (seen.has('_id')) {
    return ['_id', ...cols.filter((c) => c !== '_id')];
  }
  return cols;
}

// Column order for a CSV/Excel export so it matches the Table view the user sees.
// `loadedRecords` is the currently-loaded page (same source as the Table view);
// `discoveredKeys` is the union of top-level keys across ALL matched docs.
//
// Table-view columns come first, in Table order (deriveColumns: _id first, then
// first-seen) — but only those that actually exist in the export result set.
// Any remaining discovered keys (fields present only in off-page documents) are
// appended alphabetically so no field is dropped.
export function orderExportColumns(loadedRecords: any[], discoveredKeys: string[]): string[] {
  const discovered = discoveredKeys || [];
  const discoveredSet = new Set(discovered);
  const tableOrder = deriveColumns(loadedRecords).filter((k) => discoveredSet.has(k));
  const inTable = new Set(tableOrder);
  const extra = discovered.filter((k: string) => !inTable.has(k)).sort((a: string, b: string) => a.localeCompare(b));
  return [...tableOrder, ...extra];
}
