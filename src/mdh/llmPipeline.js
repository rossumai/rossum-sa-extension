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

// Candidate angles — the two generation strategies run in parallel. Diversity
// targets the exact-vs-tolerant axis (CA/California, NET30/"net 30" misses),
// since llmchat ignores temperature so identical prompts give identical output.
export const ANGLES = {
  exact: 'Approach: translate the request directly and minimally. Use exact equality on the stored values and the simplest stages that answer it.',
  tolerant: 'Approach: be resilient to format and phrasing differences. Use case-insensitive or regex matching (or $search when a text index fits) for free text, $toInt inside $expr for digit-string fields, and broader matching so real-world value variants still match.',
};

// Concise schema-hint blocks (shared by initial + fix prompts). Each is emitted
// only when its data is present. Verified live to improve precision: known
// values fix coded-field misses (roll→RL, "pieces"→PC); numeric-string fields
// fix string-vs-number comparisons; search-index awareness unlocks the
// purpose-built $search synonym/analyzer indexes the model can't otherwise use.
function schemaHintParts({ knownValues = null, numericStringFields = null, searchIndexes = null,
  fieldTypes = null, ranges = null, arrayPaths = null, topValues = null } = {}) {
  const parts = [];
  if (fieldTypes && Object.keys(fieldTypes).length > 0) {
    const items = Object.keys(fieldTypes).sort().map((f) => `${f}:${fieldTypes[f]}`);
    let line = `Field types — ${items.join(', ')}.`;
    const EXT = new Set(['date', 'objectId', 'timestamp', 'binary', 'uuid', 'regex']);
    if (Object.values(fieldTypes).some((t) => EXT.has(t))) {
      line += ' Fields typed date/objectId/timestamp are stored as MongoDB extended JSON (e.g. {"$date": ...}); reference them by the field name and treat them as that type — there is no ".$date" sub-field.';
    }
    parts.push(line);
  }
  if (knownValues && Object.keys(knownValues).length > 0) {
    const items = Object.entries(knownValues).map(([f, vals]) => `${f} ∈ {${vals.join(', ')}}`);
    parts.push(`Known values (use the EXACT stored form) — ${items.join('; ')}`);
  }
  if (topValues && Object.keys(topValues).length > 0) {
    const items = Object.entries(topValues).map(([f, v]) => `${f} often ∈ {${v.values.join(', ')}}${v.more ? ` (+${v.more} more)` : ''}`);
    parts.push(`Most common values (not exhaustive; match the stored form) — ${items.join('; ')}`);
  }
  if (ranges && Object.keys(ranges).length > 0) {
    const items = Object.entries(ranges).map(([f, r]) => `${f}: ${r.min}…${r.max}`);
    parts.push(`Numeric ranges — ${items.join('; ')}.`);
  }
  if (Array.isArray(arrayPaths) && arrayPaths.length > 0) {
    parts.push(`Array fields (use $unwind to reach elements) — ${arrayPaths.join(', ')}.`);
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

export function buildPipelineMessages({ fields = [], currentPipeline = '', request = '', samples = null,
  collection = '', angle = null, knownValues = null, numericStringFields = null, searchIndexes = null,
  fieldTypes = null, ranges = null, arrayPaths = null, topValues = null } = {}) {
  const parts = [MONGO_SYSTEM_INSTRUCTION];
  if (collection) parts.push(`Collection: ${collection}`);
  if (fields.length > 0) parts.push(`Available fields: ${fields.join(', ')}`);
  // A few real documents up front so the model uses stored value forms (e.g.
  // `NET30`/`EA`, not `net 30`/`each`) on the first try — verified to fix
  // value-format misses with no regressions (a customer dev org, 2026-06-23).
  if (Array.isArray(samples) && samples.length > 0) {
    parts.push(`Sample documents (showing how values are actually stored):\n${JSON.stringify(samples)}`);
  }
  parts.push(...schemaHintParts({ knownValues, numericStringFields, searchIndexes, fieldTypes, ranges, arrayPaths, topValues }));
  parts.push(`Current pipeline:\n${currentPipeline && currentPipeline.trim() ? currentPipeline : '[]'}`);
  if (angle && ANGLES[angle]) parts.push(ANGLES[angle]);
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
// or replayed turns). `problem` is { type:'error', message }, { type:'mismatch', message },
// or { type:'empty' }.
// On an empty retry, pass `samples` (a few real docs) so the model can see how
// values are actually stored (e.g. state:"CA" not "California").
// Correction angles — the two parallel strategies a correction round tries.
// Diversity must come from the prompt (llmchat ignores temperature).
export const FIX_ANGLES = {
  minimal: 'Approach: make the SMALLEST change to the most recent attempt that fixes the problem; keep whatever already worked.',
  rethink: 'Approach: disregard the previous structure and rebuild the query from scratch with a different strategy that answers the request.',
};

// Build a correction prompt that carries the FULL failure history: every prior
// pipeline that was tried and why it failed (`attempts`, ordered oldest→newest;
// each { pipelineText, reason }). The model is told not to repeat them. `angle`
// (a FIX_ANGLES key) biases this candidate's strategy. Single user-role message
// (llmchat is stateless — no replayed turns).
export function buildFixMessages({ fields = [], request = '', attempts = [], angle = null, samples = null,
  collection = '', knownValues = null, numericStringFields = null, searchIndexes = null,
  fieldTypes = null, ranges = null, arrayPaths = null, topValues = null } = {}) {
  const parts = [MONGO_SYSTEM_INSTRUCTION];
  if (collection) parts.push(`Collection: ${collection}`);
  if (fields.length > 0) parts.push(`Available fields: ${fields.join(', ')}`);
  if (Array.isArray(samples) && samples.length > 0) {
    parts.push(`Sample documents from the collection (showing how values are actually stored):\n${JSON.stringify(samples)}`);
  }
  parts.push(...schemaHintParts({ knownValues, numericStringFields, searchIndexes, fieldTypes, ranges, arrayPaths, topValues }));
  const list = (Array.isArray(attempts) ? attempts : []).filter((a) => a && a.pipelineText);
  if (list.length > 0) {
    const prev = (a) => (typeof a.pipelineText === 'string' ? a.pipelineText : JSON.stringify(a.pipelineText));
    const block = list.map((a, i) => `${i + 1}. ${prev(a)}\n   → ${a.reason || 'did not answer the request'}`).join('\n');
    parts.push(`These pipelines were already tried and did NOT work — do not repeat them:\n${block}`);
  }
  if (angle && FIX_ANGLES[angle]) parts.push(FIX_ANGLES[angle]);
  parts.push(`Return a corrected pipeline that fixes those problems and answers the request. Original request: ${request}`);
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
// MongoDB extended-JSON wrappers — the Data Storage REST API serializes dates,
// ObjectIds, and high-precision numbers this way (e.g. {"$date": …}, {"$oid": …},
// {"$numberDecimal": …}). Treat such a wrapper as a SCALAR of its semantic type
// rather than a nested object, so the model sees `createdAt:date` instead of a
// confusing `createdAt.$date` sub-path it tries to query.
const EXT_JSON_TYPES = {
  $oid: 'objectId', $date: 'date', $timestamp: 'timestamp',
  $numberLong: 'number', $numberInt: 'number', $numberDouble: 'number', $numberDecimal: 'number',
  $binary: 'binary', $uuid: 'uuid', $regularExpression: 'regex',
};
// Semantic type if `o` is a clean single-key extended-JSON wrapper, else null.
export function extendedJsonType(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const keys = Object.keys(o);
  return keys.length === 1 && EXT_JSON_TYPES[keys[0]] ? EXT_JSON_TYPES[keys[0]] : null;
}

// Leaf string-field paths (dot notation), excluding _id*. Used as candidates
// for distinct-value extraction. Extended-JSON wrappers are typed values, not
// string fields, so they are not descended into.
export function leafStringFields(records) {
  const fields = new Set();
  const walk = (o, p) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return;
    for (const k of Object.keys(o)) {
      const path = p ? `${p}.${k}` : k;
      const v = o[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) { if (!extendedJsonType(v)) walk(v, path); continue; }
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
      if (v && typeof v === 'object' && !Array.isArray(v)) { if (!extendedJsonType(v)) walk(v, path); continue; }
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

// ---- Field-shape extraction (pure, from in-memory sample records) ----------
// Per scalar-leaf-path type ('string'/'number'/'boolean'/'null'), arrays →
// 'array', a path seen with >1 non-null type → 'mixed'. Descends plain objects;
// excludes _id*. Tells the model which fields are numeric vs text.
export function leafFieldTypes(records) {
  const seen = new Map(); // path -> Set<type>
  const objectPaths = new Set();
  const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  const walk = (o, p) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return;
    for (const k of Object.keys(o)) {
      const path = p ? `${p}.${k}` : k;
      const v = o[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const ej = extendedJsonType(v);
        if (ej) { if (!seen.has(path)) seen.set(path, new Set()); seen.get(path).add(ej); continue; }
        objectPaths.add(path); walk(v, path); continue;
      }
      if (!seen.has(path)) seen.set(path, new Set());
      seen.get(path).add(typeOf(v));
    }
  };
  for (const r of Array.isArray(records) ? records : []) walk(r, '');
  const out = {};
  for (const [path, types] of seen) {
    if (path === '_id' || path.startsWith('_id.')) continue;
    if (objectPaths.has(path)) continue;
    const nonNull = [...types].filter((t) => t !== 'null');
    out[path] = nonNull.length === 0 ? 'null' : nonNull.length === 1 ? nonNull[0] : 'mixed';
  }
  return out;
}

// ---- Semantic verifier (the judge that also selects) -----------------------
// One user-role message asking the model to judge whether each candidate's
// RESULTS answer the request, and pick the best. Output is JSON (a different
// contract from generation), parsed by parseVerification.
export function buildVerifyMessages({ request = '', collection = '', fields = [], candidates = [], compact = false } = {}) {
  const parts = ['You are a MongoDB expert reviewing candidate aggregation pipelines for whether their RESULTS correctly answer a user request.'];
  if (collection) parts.push(`Collection: ${collection}`);
  if (fields.length > 0) parts.push(`Available fields: ${fields.join(', ')}`);
  parts.push(`Request: ${request}`);
  candidates.forEach((c, i) => {
    const sample = Array.isArray(c.sample) ? c.sample : [];
    parts.push(`Candidate ${i + 1} pipeline:\n${c.pipelineText}\nIt returned ${c.rowCount ?? 0} row(s)${c.error ? ` (ERROR: ${c.error})` : ''}. Sample results:\n${JSON.stringify(sample)}`);
  });
  if (compact) {
    parts.push(
      'For EACH candidate decide whether its results answer the request. Output ONLY compact JSON — '
      + 'no markdown, no commentary, NO issue or reasoning text: '
      + '{"candidates":[{"index":<1-based>,"answersRequest":<true|false>,"score":<0-100>}],"best":<1-based index>}.');
  } else {
    parts.push(
      'For EACH candidate decide whether its results actually answer the request. Output ONLY JSON, no markdown, '
      + 'no commentary. Put the decision fields FIRST and keep every string SHORT: '
      + '{"candidates":[{"index":<1-based>,"answersRequest":<true|false>,"score":<0-100>,"issue":"<short, empty if fine>"}],'
      + '"best":<1-based index of the best candidate>,"reasoning":"<short>"}.');
  }
  return [{ role: 'user', content: parts.join('\n\n') }];
}

// Best-effort repair of a truncated/partial JSON object: trim a dangling
// key/value or string, then close any still-open strings/brackets and re-parse.
function recoverPartialJson(s) {
  if (typeof s !== 'string' || !s.trim()) return null;
  let t = s.trim()
    .replace(/:\s*"[^"]*$/, ': ""')   // unterminated string value → empty
    .replace(/,\s*"[^"]*$/, '')        // dangling key with no value
    .replace(/:\s*$/, ': null')         // key with no value yet
    .replace(/,\s*$/, '');              // trailing comma
  const stack = []; let inStr = false, esc = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (inStr) t += '"';
  for (let i = stack.length - 1; i >= 0; i--) t += stack[i] === '{' ? '}' : ']';
  try { return JSON.parse(t); } catch { return null; }
}

// Defensive parse of a verifier reply. Strict first; on failure, recover from a
// truncated/partial response. A single-candidate verdict may omit/null `best`
// (→ defaults to 1); with >1 candidate an integer `best` is required.
export function parseVerification(text) {
  if (typeof text !== 'string') return null;
  const validate = (v, lenient) => {
    if (!v || typeof v !== 'object' || !Array.isArray(v.candidates)) return null;
    let best = v.best;
    if (!Number.isInteger(best)) {
      if (lenient && v.candidates.length === 1) best = 1;
      else return null;
    }
    return { candidates: v.candidates, best, reasoning: v.reasoning };
  };
  for (const t of [text, stripFences(text)]) {
    try { const ok = validate(JSON.parse(t), false); if (ok) return ok; } catch { /* try next */ }
  }
  const recovered = recoverPartialJson(stripFences(text));
  return recovered ? validate(recovered, true) : null;
}

// Array-valued field paths. For arrays of objects, their element leaf paths in
// `path[].sub` form (so the model knows what to $unwind); for scalar arrays a
// bare `path[]`. Excludes _id*. Sorted, de-duplicated.
export function arrayLeafPaths(records) {
  const out = new Set();
  const leafPathsOf = (o, prefix) => {
    const acc = [];
    for (const k of Object.keys(o)) {
      const path = prefix ? `${prefix}.${k}` : k;
      const v = o[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && !extendedJsonType(v)) acc.push(...leafPathsOf(v, path));
      else acc.push(path); // scalar, array, or extended-JSON wrapper → leaf
    }
    return acc;
  };
  const walk = (o, p) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return;
    for (const k of Object.keys(o)) {
      const path = p ? `${p}.${k}` : k;
      if (path === '_id' || path.startsWith('_id.')) continue;
      const v = o[k];
      if (Array.isArray(v)) {
        // an extended-JSON wrapper element is a scalar, not a real object
        const objEl = v.find((e) => e && typeof e === 'object' && !Array.isArray(e) && !extendedJsonType(e));
        if (objEl) for (const sub of leafPathsOf(objEl, '')) out.add(`${path}[].${sub}`);
        else out.add(`${path}[]`);
      } else if (v && typeof v === 'object' && !extendedJsonType(v)) {
        walk(v, path);
      }
    }
  };
  for (const r of Array.isArray(records) ? records : []) walk(r, '');
  return [...out].sort();
}

// ---- Run trace (pure, serializable; rendered by AiRunTrace.jsx) ------------
function traceTruncate(s, n) { s = String(s); return s.length > n ? `${s.slice(0, n - 1)}…` : s; }
function verdictStatus(verdict) {
  if (verdict === 'ok') return 'ok';
  if (verdict === 'empty') return 'empty';
  if (verdict === 'error' || verdict === 'invalid') return 'error';
  return 'unverified'; // unrun / unknown
}
function summarizeHints(h = {}) {
  return {
    collection: h.collection,
    fields: h.fieldCount || 0,
    knownValues: h.knownValues ? Object.keys(h.knownValues) : [],
    numericStrings: h.numericStringFields || [],
    searchIndexes: (h.searchIndexes || []).map((i) => i.name),
    typedFields: h.fieldTypes ? Object.keys(h.fieldTypes).length : 0,
    ranges: h.ranges ? Object.keys(h.ranges).length : 0,
    arrayPaths: h.arrayPaths || [],
  };
}
// One candidate → serializable view. `picked` = the verifier's pick THIS round;
// `applied` = the single candidate that became the final applied pipeline.
function mapCandidate(c, picked, applied) {
  return {
    angle: c.angle,
    pipelineText: c.pipelineText,
    verdict: c.verdict,
    rowCount: c.rowCount ?? 0,
    error: c.error || undefined,
    sample: c.sample || undefined,
    answersRequest: c.answersRequest,
    score: c.score,
    issue: c.issue || undefined,
    picked: picked != null && c === picked,
    applied: applied != null && c === applied,
  };
}

// Build the run trace from the FULL ordered round history (not just the last
// round), so the detail view can show everything the loop did. Each `rounds`
// entry is { kind:'initial'|'correction', trigger?, candidates:[…], verification, picked }.
// `chosen` is the final applied candidate; `verification` is the final round's.
export function buildTrace({ request = '', rounds = [], chosen = null, verification = null, hints = {}, corrected = false, calls = [] } = {}) {
  const traceRounds = rounds.map((r, i) => ({
    kind: r.kind || (i === 0 ? 'initial' : 'correction'),
    trigger: r.trigger || undefined,
    reasoning: r.verification?.reasoning || undefined,
    candidates: (r.candidates || []).map((c) => mapCandidate(c, r.picked, chosen)),
  }));
  const status = chosen ? verdictStatus(chosen.verdict) : 'unverified';
  const verified = !!verification;
  const n = rounds[0] && Array.isArray(rounds[0].candidates) ? rounds[0].candidates.length : 0;
  const prefix = `${n > 1 ? `Best of ${n} · ` : ''}${verified ? 'AI-checked · ' : ''}`;
  let summary;
  if (!chosen) summary = 'No usable query produced';
  else if (status === 'error') summary = `Query failed${chosen.error ? `: ${traceTruncate(chosen.error, 60)}` : ''}`;
  else if (status === 'unverified') summary = 'Query ready (not executed)';
  else if (status === 'empty') summary = `${prefix}0 rows`;
  else summary = `${prefix}${chosen.rowCount} row${chosen.rowCount === 1 ? '' : 's'}`;
  return {
    request,
    status,
    summary,
    corrected,
    verifierReasoning: verification?.reasoning || undefined,
    rounds: traceRounds,
    hints: summarizeHints(hints),
    calls,
  };
}
