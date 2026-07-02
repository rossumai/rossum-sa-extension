import { parseNdjson } from '../ndjson.js';

function parse(text) {
  const nd = parseNdjson(text);
  return { docs: nd.docs, columns: [], warnings: nd.warnings, error: nd.error };
}

export default { id: 'jsonl', label: 'JSONL', accept: '.jsonl,.ndjson,application/x-ndjson', read: 'text', defaultOpts: {}, parse };
