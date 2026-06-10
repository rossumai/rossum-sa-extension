// JSON Lines / NDJSON — pure, native JSON only (no dependency, CSP-clean). Used as
// a fallback by the JSON file importer when a whole-file JSON.parse fails (i.e. the
// file is line-delimited JSON objects rather than one JSON value). Returns the same
// docs/warnings/error shape the import tail expects.
export function parseNdjson(text) {
  const warnings = [];
  const docs = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue; // skip blank lines (incl. trailing newline)
    let v;
    try {
      v = JSON.parse(line);
    } catch {
      warnings.push(`Line ${i + 1}: invalid JSON, skipped`);
      continue;
    }
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      warnings.push(`Line ${i + 1}: not a JSON object, skipped`);
      continue;
    }
    docs.push(v);
  }
  if (docs.length === 0) return { docs: [], warnings, error: { message: 'No JSON or JSON Lines documents found' } };
  return { docs, warnings, error: null };
}
