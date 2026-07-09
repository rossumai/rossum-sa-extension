import { parseGridInfo } from './grid.js';

// Read-only gather of everything the correction pipeline reasons over. All
// Rossum reads are same-origin (content-script context). Verified shapes:
// content datapoints carry content.{value,position,page,rir_confidence};
// page_data?granularity=words → results[].items[].{position,text};
// pages → results[].{id,number,width,height}; page image at /pages/{id}/preview.

export function flattenFields(nodes) {
  const out = [];
  const walk = (list, ctx) => {
    for (const n of list || []) {
      if (n.category === 'datapoint') {
        const c = n.content || {};
        out.push({
          datapointId: n.id,
          schemaId: n.schema_id,
          value: c.value ?? null,
          position: Array.isArray(c.position) ? c.position : null,
          rirPosition: Array.isArray(c.rir_position) ? c.rir_position : null,
          page: c.page ?? null,
          confidence: c.rir_confidence ?? null,
          rowIndex: ctx.rowIndex,
          inLineItem: ctx.inLineItem,
          mvSchemaId: ctx.mvSchemaId,
          mvId: ctx.mvId,
        });
      } else if (n.category === 'multivalue' && Array.isArray(n.children)) {
        const mvCtx = { inLineItem: true, mvSchemaId: n.schema_id, mvId: n.id };
        n.children.forEach((tuple, i) => {
          if (tuple && tuple.category === 'tuple') walk(tuple.children, { ...mvCtx, rowIndex: i + 1 });
          else walk([tuple], { ...mvCtx, rowIndex: i + 1 });
        });
      } else if (Array.isArray(n.children)) {
        walk(n.children, ctx);
      }
    }
  };
  walk(nodes, { inLineItem: false, rowIndex: null, mvSchemaId: null, mvId: null });
  return out;
}

function schemaIdFromUrl(url) {
  const m = String(url || '').match(/\/schemas\/(\d+)/);
  return m ? m[1] : null;
}

function flattenSchema(nodes, out = []) {
  for (const n of nodes || []) {
    if (n.category === 'datapoint') {
      out.push({
        schemaId: n.id, label: n.label || n.id, type: n.type || 'string',
        required: !!(n.constraints && n.constraints.required),
        options: Array.isArray(n.options)
          ? n.options.map((o) => ({ value: String(o.value), label: String(o.label ?? o.value) }))
          : null,
      });
    } else if (Array.isArray(n.children)) {
      flattenSchema(n.children, out);
    } else if (n.children && Array.isArray(n.children.children)) {
      flattenSchema(n.children.children, out);
    }
  }
  return out;
}

// Map every multivalue's schema_id → its column schema_ids, from the SCHEMA tree
// (a schema multivalue's `children` is the tuple OBJECT). Unlike deriving columns
// from the annotation's fields, this survives a table whose rows were all deleted.
export function collectSchemaTables(nodes, out = {}) {
  for (const n of nodes || []) {
    if (n.category === 'multivalue' && typeof n.id === 'string') {
      const tuple = n.children;
      const cells = Array.isArray(tuple) ? tuple : (tuple && tuple.children) || [];
      const cols = (Array.isArray(cells) ? cells : []).filter((c) => c && c.category === 'datapoint').map((c) => c.id);
      if (cols.length) out[n.id] = cols;
    } else if (Array.isArray(n.children)) {
      collectSchemaTables(n.children, out);
    }
  }
  return out;
}

// Map every multivalue's schema_id → its content-node id, walked from the content
// tree (includes EMPTY tables, which flattenFields can't surface). Used to target
// `add` row operations.
export function collectMultivalues(nodes, out = {}) {
  for (const n of nodes || []) {
    if (n.category === 'multivalue') out[n.schema_id] = n.id;
    const ch = n.children;
    if (Array.isArray(ch)) collectMultivalues(ch, out);
    else if (ch && Array.isArray(ch.children)) collectMultivalues(ch.children, out);
  }
  return out;
}

// The tuple (row) ids of a given multivalue in the content tree. Diffing before/after an
// `add` identifies the newly-created row id(s) for Undo.
export function multivalueRowIds(nodes, mvSchemaId) {
  const ids = [];
  const walk = (list) => {
    for (const n of list || []) {
      if (n.category === 'multivalue' && n.schema_id === mvSchemaId) {
        for (const t of n.children || []) if (t && t.category === 'tuple') ids.push(t.id);
      } else if (Array.isArray(n.children)) walk(n.children);
    }
  };
  walk(nodes);
  return ids;
}

// Optional sources degrade (never throw) so one 403/500 doesn't sink the whole
// gather — only the annotation content and the annotation object are required.
async function fetchOptionalJson(getJson, path, fallback) {
  try {
    return await getJson(path);
  } catch {
    return fallback;
  }
}

export async function gatherAnnotation(annotationId, { getJson, getBase64 }) {
  const [contentRes, annRes] = await Promise.all([
    getJson(`/api/v1/annotations/${annotationId}/content`),
    getJson(`/api/v1/annotations/${annotationId}`),
  ]);

  const fields = flattenFields(contentRes.content || []);

  const [pageDataRes, pagesRes] = await Promise.all([
    fetchOptionalJson(getJson, `/api/v1/annotations/${annotationId}/page_data?granularity=words`, { results: [] }),
    fetchOptionalJson(getJson, `/api/v1/pages?annotation=${annotationId}`, { results: [] }),
  ]);

  const ocrPages = (pageDataRes.results || []).map((p) => ({
    page: p.page_number,
    width: null,
    height: null,
    words: (p.items || []).map((w) => ({ text: w.text, position: w.position })),
  }));

  const pages = (pagesRes.results || []).slice().sort((a, b) => (a.number || 0) - (b.number || 0));
  for (const pg of pages) {
    const op = ocrPages.find((o) => o.page === pg.number);
    if (op) { op.width = pg.width; op.height = pg.height; }
  }
  const pageImageResults = await Promise.all(pages.map(async (pg) => {
    try {
      return {
        page: pg.number,
        mediaType: 'image/png',
        data: await getBase64(`/api/v1/pages/${pg.id}/preview`),
      };
    } catch {
      return null;
    }
  }));
  const pageImages = pageImageResults.filter((img) => img !== null);

  const messages = (annRes.messages || []).map((m) => ({
    datapointId: m.id ?? null, type: m.type, content: m.content,
  }));

  let schemaFields = [];
  let tableColumns = {};
  const schemaId = schemaIdFromUrl(annRes.schema);
  if (schemaId) {
    try {
      const schema = await getJson(`/api/v1/schemas/${schemaId}`);
      schemaFields = flattenSchema(schema.content || []);
      tableColumns = collectSchemaTables(schema.content || []);
    } catch {
      schemaFields = [];
      tableColumns = {};
    }
  }

  const multivalues = collectMultivalues(contentRes.content || []);
  const grids = parseGridInfo(contentRes.content || []);

  return { fields, ocrPages, pageImages, messages, schemaFields, tableColumns, multivalues, grids, contentTree: contentRes.content || [] };
}
