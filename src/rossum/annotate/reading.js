// The READ phase contract: Fabry reports WHAT IS PRINTED (values + verbatim
// quotes) and never does geometry — locating quotes on the page is the client's
// job (align.js). Pure: prompt builder + tolerant reply parser.
import { stripFences } from '../../mdh/llmPipeline.js';

// Find the first balanced JSON object in free text (fenced or not), tolerant of
// prose around it. Returns the parsed object or null.
function firstJsonObject(text) {
  if (typeof text !== 'string') return null;
  const fenceRe = /```(?:json)?\s*\n?([\s\S]*?)```/gi;
  let m;
  while ((m = fenceRe.exec(text))) {
    try { return JSON.parse(m[1].trim()); } catch { /* try next fence */ }
  }
  try { return JSON.parse(stripFences(text).trim()); } catch { /* scan below */ }
  for (let i = text.indexOf('{'); i !== -1; i = text.indexOf('{', i + 1)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let k = i; k < text.length; k++) {
      const ch = text[k];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(text.slice(i, k + 1)); } catch { break; }
        }
      }
    }
  }
  return null;
}

// The reading prompt: schema inventory + the JSON reading contract. Table
// columns come from `tableColumns` (schema-sourced — survives emptied tables),
// falling back to columns observed on the current fields.
export function buildReadPrompt({ fields, schemaFields, multivalues, tableColumns, maxChars = 40000 }) {
  const sfBy = Object.fromEntries((schemaFields || []).map((s) => [s.schemaId, s]));
  const headerIds = [...new Set((fields || []).filter((f) => !f.inLineItem).map((f) => f.schemaId))];
  const headerLine = (id) => {
    const sf = sfBy[id];
    return sf && Array.isArray(sf.options) && sf.options.length
      ? `${id} (one of: ${sf.options.map((o) => o.value).join(' | ')})`
      : id;
  };
  const observedCols = {};
  for (const f of (fields || []).filter((x) => x.inLineItem)) {
    (observedCols[f.mvSchemaId] = observedCols[f.mvSchemaId] || new Set()).add(f.schemaId);
  }
  const tables = Object.keys(multivalues || {}).map((t) => {
    const cols = (tableColumns && tableColumns[t]) || [...(observedCols[t] || [])];
    return `${t}: ${cols.length ? cols.join(', ') : '(columns unknown)'}`;
  });
  const out = [
    'READ the attached document page image(s). Report what is PRINTED. Do not correct anything. Do NOT call any tools.',
    'Return ONLY a fenced ```json object:',
    '{"headers":[{"schema_id":string,"value":string,"printed":string|null,"page":number}],',
    ' "tables":[{"table":string,"rows":[{"cells":[{"schema_id":string,"value":string,"printed":string|null}]}]}]}',
    'Rules:',
    '- Include a header entry ONLY when its value is visible on the page.',
    '- "printed" = the EXACT characters as printed for that value alone, verbatim, no surrounding labels; null when the value is inferred rather than printed (e.g. a language, a computed total).',
    '- "value" = the normalized value for the field.',
    '- Report EVERY table row printed on the page, top to bottom, with every readable cell.',
    '- No prose.',
    '## Header fields',
    headerIds.map(headerLine).join(', ') || '(none)',
    '## Tables (columns)',
    tables.join('\n') || '(none)',
  ].join('\n');
  return out.length > maxChars ? out.slice(0, maxChars) : out;
}

// Parse the reading reply into a normalized shape. Rows are numbered by array
// order (1-based); malformed entries are dropped, never guessed at.
export function parseReading(replyText) {
  const doc = firstJsonObject(replyText);
  if (!doc || typeof doc !== 'object') return null;
  const headers = (Array.isArray(doc.headers) ? doc.headers : [])
    .filter((h) => h && typeof h.schema_id === 'string')
    .map((h) => ({
      schemaId: h.schema_id,
      value: h.value ?? null,
      printed: typeof h.printed === 'string' && h.printed.trim() !== '' ? h.printed : null,
      page: typeof h.page === 'number' ? h.page : null,
    }));
  const tables = (Array.isArray(doc.tables) ? doc.tables : [])
    .filter((t) => t && typeof t.table === 'string' && Array.isArray(t.rows))
    .map((t) => ({
      table: t.table,
      rows: t.rows
        .filter((r) => r && Array.isArray(r.cells))
        .map((r, i) => ({
          row: i + 1,
          cells: r.cells
            .filter((c) => c && typeof c.schema_id === 'string')
            .map((c) => ({
              schemaId: c.schema_id,
              value: c.value ?? null,
              printed: typeof c.printed === 'string' && c.printed.trim() !== '' ? c.printed : null,
            })),
        })),
    }));
  if (!headers.length && !tables.length) return null;
  return { headers, tables };
}
