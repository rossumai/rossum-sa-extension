// src/devtools/annotationContent.ts
// PURE: the one editable sub-resource — an annotation's whole content tree, saved with
// `PATCH /annotations/{id}/content`. Every other sub-resource stays read-only.

const CONTENT_PATH = /^\/api\/v1\/annotations\/\d+\/content$/;

export function isAnnotationContentPath(apiPath: string | undefined): boolean {
  return typeof apiPath === 'string' && CONTENT_PATH.test(apiPath);
}

// GET returns the tree twice (`content` and an identical `results`); PATCH reads only
// `content`. Showing one copy means an edit can never land in the copy that is not saved.
// The body is an untyped wire object.
export function forEditing(data: any): any {
  if (!data || !Array.isArray(data.content) || !('results' in data)) return data;
  const { results: _results, ...rest } = data;
  return rest;
}

// A multivalue's rows, as the sequence of their ids (a new row has none).
function tables(tree: any): Map<number, { schemaId: string; rows: unknown[] }> {
  const out = new Map<number, { schemaId: string; rows: unknown[] }>();
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (node.category === 'multivalue' && node.id != null) {
      const children = Array.isArray(node.children) ? node.children : [];
      out.set(node.id, { schemaId: String(node.schema_id), rows: children.map((c: any) => c?.id) });
    }
    for (const child of Array.isArray(node.children) ? node.children : []) walk(child);
  };
  for (const section of Array.isArray(tree?.content) ? tree.content : []) walk(section);
  return out;
}

// PATCH matches table rows by POSITION: a row removed or moved in the JSON is removed or
// moved on the server too. Returns the schema_ids of the tables where that happened. New
// rows appended AFTER every existing one are harmless (they are simply added), so only the
// existing rows must keep their exact order at the front.
export function changedTables(original: any, edited: any): string[] {
  const before = tables(original);
  const after = tables(edited);
  const changed: string[] = [];
  for (const [id, t] of before) {
    const now = after.get(id);
    if (!now) continue; // a multivalue left out of the payload keeps its rows
    const kept = now.rows.slice(0, t.rows.length);
    const appended = now.rows.slice(t.rows.length);
    const existingInPlace = kept.length === t.rows.length && kept.every((r, i) => r === t.rows[i]);
    if (!existingInPlace || appended.some((r) => r != null)) changed.push(t.schemaId);
  }
  return changed;
}
