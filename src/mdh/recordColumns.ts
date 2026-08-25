import { splitPath } from './flatten.js';

// Column set for the Table results view: union of top-level keys across the
// loaded page, _id first, then first-seen order. Nested values are rendered as
// expandable badges by RecordTable — they do not become their own columns.
export function deriveColumns(records: any[]): string[] {
  const seen = new Set();
  const cols = [];
  for (const rec of records || []) {
    if (!rec || typeof rec !== 'object') continue;
    for (const key of Object.keys(rec)) {
      if (!seen.has(key)) {
        seen.add(key);
        cols.push(key);
      }
    }
  }
  if (seen.has('_id')) {
    return ['_id', ...cols.filter((c) => c !== '_id')];
  }
  return cols;
}

// Column order for a CSV/Excel export so it matches the Table view the user sees.
// `discoveredPaths` are leaf PATHS (address.city), while the Table view shows
// top-level keys (address) — so each table column pulls in all the leaves that
// live under it, in path order, and anything left over is appended
// alphabetically. Grouping is by the DECODED first segment, so a literal
// dotted key is its own root rather than a child of a same-named object.
export function orderExportColumns(loadedRecords: any[], discoveredPaths: string[]): string[] {
  const discovered = discoveredPaths || [];
  const byRoot = new Map<string, string[]>();
  for (const p of discovered) {
    const root = splitPath(p)[0] as string;
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root)!.push(p);
  }
  const out: string[] = [];
  const used = new Set<string>();
  for (const key of deriveColumns(loadedRecords)) {
    for (const p of (byRoot.get(key) || []).slice().sort((a, b) => a.localeCompare(b))) {
      out.push(p);
      used.add(p);
    }
  }
  const extra = discovered.filter((p) => !used.has(p)).sort((a, b) => a.localeCompare(b));
  return [...out, ...extra];
}
