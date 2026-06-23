// Pure (DOM-free, network-free) helpers for the AI pipeline input.
// The Rossum internal /llmchat endpoint accepts ONLY user-role messages and
// gives no system-prompt control (verified live on a customer dev org 2026-06-23), so
// all instructions are folded into a single user message.

// Maximum rows the generated pipeline may return — instructed to the model AND
// enforced as the loop's probe cap (see PROBE_LIMIT below).
export const MAX_ROWS = 50;

// MongoDB-expert instruction prepended to every request. Single source of truth
// so the live prompt-evaluation phase can tune it in one place.
export const MONGO_SYSTEM_INSTRUCTION =
  'You are a MongoDB expert. You are given the available fields, the current ' +
  'aggregation pipeline, and a request. Modify the pipeline according to the ' +
  'request — add, remove, or change stages as needed. If the request describes a ' +
  'completely new query, replace the pipeline entirely. ' +
  `Always limit the output to at most ${MAX_ROWS} documents: end the pipeline with a ` +
  `\`$limit\` stage of ${MAX_ROWS} or fewer (use a smaller value when the request asks for ` +
  "fewer, e.g. 'top 5'). A `$count` pipeline is exempt. Never return more than " +
  `${MAX_ROWS} documents. ` +
  'Output ONLY valid JSON — an array of aggregation pipeline stages. ' +
  'No explanation, no markdown, no code fences, no trailing text.';

// Concise schema-hint blocks (shared by initial + fix prompts). Each is emitted
// only when its data is present. Verified live to improve precision: known
// values fix coded-field misses (roll→RL, "pieces"→PC); numeric-string fields
// fix string-vs-number comparisons; search-index awareness unlocks the
// purpose-built $search synonym/analyzer indexes the model can't otherwise use.
function schemaHintParts({ knownValues = null, numericStringFields = null, searchIndexes = null } = {}) {
  const parts = [];
  if (knownValues && Object.keys(knownValues).length > 0) {
    const items = Object.entries(knownValues).map(([f, vals]) => `${f} ∈ {${vals.join(', ')}}`);
    parts.push(`Known values (use the EXACT stored form) — ${items.join('; ')}`);
  }
  if (Array.isArray(numericStringFields) && numericStringFields.length > 0) {
    parts.push(`Fields stored as strings of digits — to compare them numerically, convert with $toInt inside $expr (e.g. {$expr:{$gt:[{$toInt:"$field"},N]}}): ${numericStringFields.join(', ')}.`);
  }
  if (Array.isArray(searchIndexes) && searchIndexes.length > 0) {
    const items = searchIndexes.map((i) => `'${i.name}' (${i.fields === 'all' ? 'all fields' : i.fields.join(', ')}${i.synonyms ? '; synonyms' : ''})`);
    parts.push(`Atlas Search indexes available: ${items.join('; ')}. For free-text / fuzzy / description matching prefer $search as the FIRST stage with the matching index (e.g. {$search:{index:"<name>",text:{query:"...",path:"<field>"}}}); for exact value filters use $match.`);
  }
  return parts;
}

export function buildPipelineMessages({ fields = [], currentPipeline = '', request = '', samples = null, knownValues = null, numericStringFields = null, searchIndexes = null } = {}) {
  const parts = [MONGO_SYSTEM_INSTRUCTION];
  if (fields.length > 0) parts.push(`Available fields: ${fields.join(', ')}`);
  // A few real documents up front so the model uses stored value forms (e.g.
  // `NET30`/`EA`, not `net 30`/`each`) on the first try — verified to fix
  // value-format misses with no regressions (a customer dev org, 2026-06-23).
  if (Array.isArray(samples) && samples.length > 0) {
    parts.push(`Sample documents (showing how values are actually stored):\n${JSON.stringify(samples)}`);
  }
  parts.push(...schemaHintParts({ knownValues, numericStringFields, searchIndexes }));
  parts.push(`Current pipeline:\n${currentPipeline && currentPipeline.trim() ? currentPipeline : '[]'}`);
  parts.push(`Request: ${request}`);
  return [{ role: 'user', content: parts.join('\n\n') }];
}

export function extractReply(response) {
  const msgs = response && response.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) return '';
  return msgs[msgs.length - 1]?.content ?? '';
}

export function stripFences(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
}

// Availability probe classifier: POST {} returns 400 ("messages required") when
// llmchat is reachable/enabled; 403/other when feature-flagged off.
export function classifyProbe(status) {
  return status === 400;
}

// ---- Agentic self-correction loop helpers ----------------------------------
// Verdict for one probe execution: backend error → 'error'; ran but 0 rows →
// 'empty' (the only auto-detectable "suspect" signal); otherwise 'ok'.
export function verdictFor({ ok, rowCount } = {}) {
  if (!ok) return 'error';
  if (!rowCount) return 'empty';
  return 'ok';
}

// Parse model output to a pipeline array, or null if it isn't a JSON array.
export function safeParseArray(text) {
  if (typeof text !== 'string') return null;
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// Guarantee the pipeline returns at most MAX_ROWS: append a $limit when the
// model omitted one (e.g. an empty/no-op pipeline). A $count, or an existing
// $limit (trusted ≤ MAX_ROWS per the instruction, so 'top 5' keeps its
// $limit:5 and the editor stays clean), is left as-is. Returns the SAME array
// reference when unchanged so callers can detect a no-op.
export function ensureRowLimit(pipeline) {
  if (!Array.isArray(pipeline)) return [{ $limit: MAX_ROWS }];
  const has = (k) => pipeline.some((s) => s && typeof s === 'object' && k in s);
  if (has('$count') || has('$limit')) return pipeline;
  return [...pipeline, { $limit: MAX_ROWS }];
}

// Compare two pipeline texts canonically (ignoring whitespace) to detect a
// no-progress retry. Falls back to trimmed-string equality if unparseable.
export function samePipeline(aText, bText) {
  const a = safeParseArray(aText);
  const b = safeParseArray(bText);
  if (a && b) return JSON.stringify(a) === JSON.stringify(b);
  return String(aText ?? '').trim() === String(bText ?? '').trim();
}

// Build a one-shot correction message (user role only — llmchat rejects system
// or replayed turns). `problem` is { type:'error', message } or { type:'empty' }.
// On an empty retry, pass `samples` (a few real docs) so the model can see how
// values are actually stored (e.g. state:"CA" not "California").
export function buildFixMessages({ fields = [], request = '', previousPipeline = '', problem = {}, samples = null, knownValues = null, numericStringFields = null, searchIndexes = null } = {}) {
  const prev = typeof previousPipeline === 'string' ? previousPipeline : JSON.stringify(previousPipeline);
  const parts = [MONGO_SYSTEM_INSTRUCTION];
  if (fields.length > 0) parts.push(`Available fields: ${fields.join(', ')}`);
  if (Array.isArray(samples) && samples.length > 0) {
    parts.push(`Sample documents from the collection (showing how values are actually stored):\n${JSON.stringify(samples)}`);
  }
  parts.push(...schemaHintParts({ knownValues, numericStringFields, searchIndexes }));
  parts.push(`Your previous pipeline was:\n${prev}`);
  if (problem.type === 'error') {
    parts.push(`Running it FAILED with this error:\n${problem.message}\n\nReturn a corrected pipeline that runs without this error.`);
  } else {
    parts.push('Running it executed but returned 0 matching documents — the filter likely does not match how values are stored (e.g. codes or abbreviations rather than full names). Return a corrected pipeline.');
  }
  parts.push(`Original request: ${request}`);
  return [{ role: 'user', content: parts.join('\n\n') }];
}

// ---- AI request comment (shown above an AI-generated pipeline) --------------
export const AI_COMMENT_PREFIX = '// 🤖 AI request: ';

// Remove a leading AI-request comment (and one blank separator line, if any) so
// it doesn't accumulate across runs or get re-sent as prompt context.
export function stripAiComment(text) {
  if (typeof text !== 'string') return '';
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].startsWith(AI_COMMENT_PREFIX)) i += 1;
  if (i > 0 && i < lines.length && lines[i].trim() === '') i += 1;
  return lines.slice(i).join('\n');
}

// Prepend a single-line AI-request comment above the pipeline, replacing any
// existing one. The request is collapsed to one line so it stays a valid
// `//` comment (JSON5 strips it on execution).
export function prependAiComment(pipelineText, request) {
  const body = stripAiComment(typeof pipelineText === 'string' ? pipelineText : '');
  const oneLine = String(request ?? '').replace(/\s+/g, ' ').trim();
  if (!oneLine) return body;
  return `${AI_COMMENT_PREFIX}${oneLine}\n${body}`;
}

// ---- Schema-hint extraction from sample records ----------------------------
// Leaf string-field paths (dot notation), excluding _id*. Used as candidates
// for distinct-value extraction.
export function leafStringFields(records) {
  const fields = new Set();
  const walk = (o, p) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return;
    for (const k of Object.keys(o)) {
      const path = p ? `${p}.${k}` : k;
      const v = o[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) { walk(v, path); continue; }
      if (typeof v === 'string') fields.add(path);
    }
  };
  for (const r of Array.isArray(records) ? records : []) walk(r, '');
  return [...fields].filter((f) => f !== '_id' && !f.startsWith('_id.')).sort();
}

// Leaf fields stored as strings of digits (e.g. vendorId "7440") — the model
// must convert these for numeric comparison. Excludes numbers and mixed strings.
export function detectNumericStringFields(records) {
  const seen = new Map(); // path -> { ok, any }
  const walk = (o, p) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return;
    for (const k of Object.keys(o)) {
      const path = p ? `${p}.${k}` : k;
      const v = o[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) { walk(v, path); continue; }
      if (v == null) continue;
      const cur = seen.get(path) || { ok: true, any: false };
      if (typeof v === 'string' && /^\d+$/.test(v)) cur.any = true;
      else cur.ok = false;
      seen.set(path, cur);
    }
  };
  for (const r of Array.isArray(records) ? records : []) walk(r, '');
  return [...seen.entries()]
    .filter(([f, s]) => s.ok && s.any && f !== '_id' && !f.startsWith('_id.'))
    .map(([f]) => f)
    .sort();
}

// Condense a raw list_search_indexes response to { name, fields, synonyms } for
// queryable/READY indexes. fields = 'all' for a dynamic index, else top-level paths.
export function summarizeSearchIndexes(rawList) {
  if (!Array.isArray(rawList)) return [];
  return rawList
    .filter((i) => i && i.queryable !== false && (i.status === undefined || i.status === 'READY'))
    .map((i) => {
      const def = i.latest_definition || {};
      const mappings = def.mappings || {};
      const fields = mappings.dynamic === true ? 'all' : Object.keys(mappings.fields || {});
      return { name: i.name, fields, synonyms: Array.isArray(def.synonyms) && def.synonyms.length > 0 };
    });
}
