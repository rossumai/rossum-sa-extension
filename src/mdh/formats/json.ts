import { parseNdjson } from '../ndjson.js';

function parse(text: string) {
  try {
    let parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) parsed = [parsed];
    return {
      docs: parsed,
      columns: [],
      warnings: [],
      error: parsed.length ? null : { message: 'File contains no documents' },
    };
  } catch (jsonErr) {
    const nd = parseNdjson(text);
    if (nd.error)
      return {
        docs: [],
        columns: [],
        warnings: [],
        error: { message: `Couldn't parse as JSON or JSON Lines: ${(jsonErr as Error).message}` },
      };
    return { docs: nd.docs, columns: [], warnings: nd.warnings, error: null };
  }
}

export default {
  id: 'json',
  label: 'JSON',
  accept: '.json,application/json',
  read: 'text',
  defaultOpts: {},
  parse,
};
