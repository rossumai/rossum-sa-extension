// Column set for the Table results view: union of top-level keys across the
// loaded page, _id first, then first-seen order. Nested values are rendered as
// expandable badges by RecordTable — they do not become their own columns.
export function deriveColumns(records) {
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
