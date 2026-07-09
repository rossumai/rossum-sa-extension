// The refine-turn prompt: after the reading is applied and validated, remaining
// validation errors go back to Fabry (same chat) as targeted datapoint_id-keyed
// fixes. The main document turn is the READING (see reading.js) — Fabry never
// does geometry; boxes are located client-side from verbatim quotes (align.js).

export function buildFixPrompt({ errors, fields, schemaFields, maxChars = 40000 }) {
  void schemaFields;
  const byId = Object.fromEntries((fields || []).map((f) => [f.datapointId, f]));
  const errLines = (errors || []).map((e) => {
    const f = e.datapointId != null ? byId[e.datapointId] : null;
    const cur = f ? ` (current value=${JSON.stringify(f.value)}${f.inLineItem && f.rowIndex != null ? `, row ${f.rowIndex}` : ''})` : '';
    return `- [${e.type}] dp#${e.datapointId ?? '?'} ${e.schemaId || ''}: ${e.content}${cur}`;
  }).join('\n');
  const out = [
    'Some corrections still fail validation against master data / rules. Fix ONLY these.',
    'Return ONLY a fenced ```json array; each element { "datapoint_id": number, "new_value": string, "reason": string, "confidence": number }.',
    'Use the datapoint_id from each error to target the exact field/row. Do NOT call tools. Output the JSON array and NOTHING else; keep "reason" under 6 words.',
    '', '## Remaining validation errors', errLines || '(none)',
  ].join('\n');
  return out.length > maxChars ? out.slice(0, maxChars) : out;
}
