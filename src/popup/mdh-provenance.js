// MDH provenance — pure cascade replay engine + parsing helpers.
// No DOM access; consumers (Preact components) render based on returned data.

import { evalCondition } from './actionCondition.js';
import { reEscape } from '../mdh/reEscape.js';
import { VAR_RE, VAR_RE_G } from '../mdh/placeholderSyntax.js';

// ── API ─────────────────────────────────────────────

export async function fetchJson(url, token) {
  const resp = await fetch(url, {
    headers: { Authorization: `token ${token}`, Accept: 'application/json' },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

// Single write helper for the popup (the reviewing-lock force-release).
// Same auth + error contract as fetchJson above.
export async function apiPatch(url, token, body) {
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `token ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

async function runAggregate(domain, token, dataset, pipeline, externalSignal, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  if (externalSignal) {
    if (externalSignal.aborted) ctrl.abort();
    else externalSignal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  try {
    const resp = await fetch(`${domain}/svc/data-storage/api/v1/data/aggregate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ collectionName: dataset, pipeline }),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      let detail = '';
      try {
        const body = await resp.clone().json();
        detail = body?.message || body?.detail || body?.error || '';
      } catch {
        try { detail = await resp.text(); } catch { /* ignore */ }
      }
      detail = (detail || '').toString().trim();
      throw new Error(detail ? `${resp.status}: ${detail}` : `${resp.status}`);
    }
    return resp.json();
  } finally {
    clearTimeout(timer);
  }
}

export function extractIdFromUrl(url) {
  if (!url) return null;
  const path = String(url).split(/[?#]/, 1)[0];
  const m = path.match(/\/(\d+)\/?$/);
  return m ? m[1] : null;
}

// ── Hook config parsing ────────────────────────────

// Honor MDH's non-standard naming conventions in priority order:
// `name` (used by some hook authors at the query level), `comment` (the
// docs convention, e.g. "Stage 1: Exact VAT match …"), `//` (JSON-as-comment
// idiom). Fall through to a synthesized stage list otherwise.
export function describeQuery(q) {
  for (const key of ['name', 'comment', '//']) {
    const v = q?.[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  if (q?.find && typeof q.find === 'object') {
    const keys = Object.keys(q.find);
    return keys.length === 0 ? 'find: (empty)' : `find: ${keys.join(', ')}`;
  }
  const pipeline = q?.aggregate || q?.pipeline;
  if (Array.isArray(pipeline)) {
    const stages = pipeline.map((s) => Object.keys(s || {})[0]).filter(Boolean);
    return stages.length === 0 ? 'aggregate: (empty)' : `aggregate: ${stages.join(' → ')}`;
  }
  return '(unknown query type)';
}

// withLimit=true appends $limit:1 — used for replay (existence check).
// withLimit=false preserves the user's original query — used for clipboard copy.
export function queryToPipeline(q, { withLimit } = {}) {
  let pipeline = null;
  if (q?.find && typeof q.find === 'object') {
    pipeline = [{ $match: q.find }];
    if (q.sort) pipeline.push({ $sort: q.sort });
    if (q.skip) pipeline.push({ $skip: q.skip });
    if (!withLimit && q.limit) pipeline.push({ $limit: q.limit });
    if (!withLimit && q.projection) pipeline.push({ $project: q.projection });
  } else if (Array.isArray(q?.aggregate)) pipeline = [...q.aggregate];
  else if (Array.isArray(q?.pipeline)) pipeline = [...q.pipeline];
  if (pipeline && withLimit) pipeline.push({ $limit: 1 });
  return pipeline;
}

// MDH match configs live under `settings.configurations` (the modern key) or
// `settings.configs` (the legacy key — still emitted by some hooks, e.g. ones
// created from older Store templates). Prefer the modern key, fall back to the
// legacy one, so the panel recognizes both. Returns [] when neither is a usable
// array.
export function hookConfigs(hook) {
  const c = hook?.settings?.configurations ?? hook?.settings?.configs;
  return Array.isArray(c) ? c : [];
}

// Display sentinel for a cfg with no `mapping.target_schema_id`. Shared so the
// producer and rowScopeForConfig (which must NOT look it up as a real field)
// cannot drift apart.
export const NO_TARGET = '(no target)';

export function extractConfigsFromHook(hook) {
  const out = [];
  const cfgs = hookConfigs(hook);
  for (const cfg of cfgs) {
    const target = cfg?.mapping?.target_schema_id || '';
    const dataset = cfg?.source?.dataset || '';
    const datasetKey = cfg?.mapping?.dataset_key || '';
    const queueIds = Array.isArray(cfg?.queue_ids) ? cfg.queue_ids : [];
    const queries = cfg?.source?.queries || cfg?.matching?.queries || [];
    const rawCondition = typeof cfg?.action_condition === 'string' ? cfg.action_condition : '';
    const actionCondition = rawCondition.trim() === '' ? null : rawCondition;
    const conditionPhSet = new Set();
    if (actionCondition) collectPlaceholders(actionCondition, conditionPhSet);
    const additionalMappings = Array.isArray(cfg?.additional_mappings)
      ? cfg.additional_mappings
          .map((m) => ({
            target: m?.target_schema_id || '',
            datasetKey: m?.dataset_key || '',
          }))
          .filter((m) => m.target || m.datasetKey)
      : [];
    out.push({
      name: cfg?.name || '',
      target: target || NO_TARGET,
      dataset: dataset || '(no dataset)',
      datasetKey,
      queueIds,
      actionCondition,
      // Array (not Set) so the structure survives chrome.storage.session JSON serialization.
      actionConditionPlaceholders: [...conditionPhSet],
      additionalMappings,
      queries: queries.map((q) => {
        const set = new Set();
        collectPlaceholders(q, set);
        return { label: describeQuery(q), raw: q, placeholders: [...set] };
      }),
    });
  }
  return out;
}

function isMdhHook(hook) {
  if (!hook) return false;
  return hookConfigs(hook).some(
    (c) => Array.isArray(c?.source?.queries) || Array.isArray(c?.matching?.queries),
  );
}

// ── Placeholder substitution ───────────────────────

// The grammar — `{name}`, `{name | modifier}`, `{name | modifier(arg)}`, with
// whitespace tolerated around the name, pipe and parens, and names restricted to
// simple identifiers so `{secrets.foo}` stays literal — is shared with the MDH
// pipeline editor via mdh/placeholderSyntax.js. This engine used to keep an
// identical private pair; both model the SAME server-side substitution, so a
// change to one that missed the other would be a silent divergence.
// VAR_RE matches a WHOLE string, VAR_RE_G finds embedded occurrences. Both are
// only ever used with matchAll/replace here (never a stateful exec loop), so
// sharing the /g instance carries no lastIndex hazard.

function unquoteArg(raw) {
  if (raw == null) return '';
  const t = raw.trim();
  if (t.length >= 2 && ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"')))) {
    return t.slice(1, -1);
  }
  return t;
}

// Returns the modifier-applied value. The result type is dictated by the
// modifier: `split` → array of strings, `re` → string (Python re.escape
// parity, see mdh/reEscape.js), no modifier → pass-through string. Unknown
// modifiers fall back to the raw value.
function applyModifier(value, modifier, arg) {
  if (modifier == null) return value;
  const s = value == null ? '' : String(value);
  if (modifier === 'split') return s.split(unquoteArg(arg));
  if (modifier === 're') return reEscape(s);
  return value;
}

export function collectPlaceholders(node, set) {
  if (node == null) return;
  if (typeof node === 'string') {
    for (const m of node.matchAll(VAR_RE_G)) set.add(m[1]);
    return;
  }
  if (Array.isArray(node)) {
    for (const c of node) collectPlaceholders(c, set);
    return;
  }
  if (typeof node === 'object') {
    for (const v of Object.values(node)) collectPlaceholders(v, set);
  }
}

// MDH's server-side substitution is type-aware: when the JSON string is
// *exactly* `"{name}"` and the source field is type=number, MDH drops the
// quotes and substitutes the JSON number. The `split` modifier replaces
// the whole string with a JSON array. Mixed substitutions (placeholders
// embedded in larger text) always produce strings.
export function substitutePlaceholders(node, values, types) {
  if (node == null) return node;
  const v = values || {};
  const t = types || {};
  if (typeof node === 'string') {
    const exact = node.match(VAR_RE);
    if (exact) {
      const [, name, modifier, arg] = exact;
      if (!(name in v)) return '';
      const raw = v[name];
      if (modifier) return applyModifier(raw, modifier, arg);
      if (t[name] === 'number') {
        if (raw == null || raw === '') return '';
        const n = typeof raw === 'number' ? raw : Number(raw);
        return Number.isFinite(n) ? n : String(raw);
      }
      return raw == null ? '' : String(raw);
    }
    return node.replace(VAR_RE_G, (_, name, modifier, arg) => {
      if (!(name in v)) return '';
      const out = applyModifier(v[name], modifier || null, arg || null);
      if (out == null) return '';
      return typeof out === 'string' ? out : JSON.stringify(out);
    });
  }
  if (Array.isArray(node)) return node.map((c) => substitutePlaceholders(c, values, types));
  if (typeof node === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(node)) {
      const newK = substitutePlaceholders(k, values, types);
      out[typeof newK === 'string' ? newK : JSON.stringify(newK)] = substitutePlaceholders(val, values, types);
    }
    return out;
  }
  return node;
}

// ── Schema types (authoritative placeholder types) ───

// Walk a queue schema's `content` tree and classify each datapoint's placeholder
// type. MDH substitution only distinguishes number-vs-string.
export function buildSchemaTypes(content) {
  const out = {};
  const walk = (nodes) => {
    if (Array.isArray(nodes)) { for (const n of nodes) walkNode(n); return; }
    if (nodes && typeof nodes === 'object') walkNode(nodes);
  };
  const walkNode = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.category === 'datapoint' && node.id) {
      const isNumber = node.type === 'number'
        || (node.type === 'enum' && node.enum_value_type === 'number');
      out[node.id] = isNumber ? 'number' : 'string';
    }
    if (node.children != null) walk(node.children);
  };
  walk(content);
  return out;
}

// Schema types are authoritative; the normalized_value heuristic fills any field
// the schema does not cover (or when the schema fetch failed → schemaTypes {}).
export function mergeSchemaTypes(heuristicTypes, schemaTypes) {
  return { ...(heuristicTypes || {}), ...(schemaTypes || {}) };
}

// Explicit per-placeholder type map for the editor tab. Explicit 'string' (not
// omission) so the editor treats it as an authoritative override and reproduces
// the Provenance replay exactly.
export function buildVariableTypes(placeholders, types) {
  const out = {};
  const t = types || {};
  for (const name of placeholders) out[name] = t[name] === 'number' ? 'number' : 'string';
  return out;
}

// Fetch a queue's schema and classify its datapoint types. Best-effort: any
// failure (403/offline/missing schema) yields {} so callers fall back to the
// heuristic.
export async function loadSchemaTypesForQueue(domain, token, queueId) {
  try {
    const queue = await fetchJson(`${domain}/api/v1/queues/${queueId}?fields=schema`, token);
    const schemaUrl = queue?.schema;
    if (!schemaUrl) return {};
    const schema = await fetchJson(`${schemaUrl}?fields=content`, token);
    return buildSchemaTypes(schema?.content || []);
  } catch {
    return {};
  }
}

// Rossum's annotation-content endpoint does NOT include the schema-defined
// `type` per datapoint, but it does populate `normalized_value` for typed
// fields. type=number canonicalizes to a numeric string ("5552.14");
// type=date canonicalizes to ISO "2026-05-01" (Number() → NaN, so it
// won't match); type=string/enum leaves it null. So a finite-number
// `normalized_value` reliably proxies type=number without an extra
// schema fetch.
function isNumberContent(content) {
  const nv = content?.normalized_value;
  if (typeof nv !== 'string' || nv.trim() === '') return false;
  return Number.isFinite(Number(nv));
}

// Flattens the annotation content tree into placeholder-friendly maps.
// For type=number datapoints the canonical `normalized_value` is used
// (so "5,552.14" becomes "5552.14"), and the schema_id is recorded in
// `types` so callers can mirror MDH's type-aware substitution.
//
// `tables` describes each multivalue SEPARATELY — one entry per table, with its
// own row count and column list. The flat `rowValues` map cannot answer "how
// many rows does THIS config have", because a document with several tables
// (e.g. a 1-row tax table beside 5 line items — live-verified on elis
// 2026-08-10) collapses them all into one index space. `rowCount` remains the
// maximum across tables for backward compatibility; the row picker uses
// `tables` via rowScopeForConfig instead.
//
// Columns are recorded STRUCTURALLY — a column counts even when its value is
// absent or unusable — because an MDH *target* field is normally empty until
// the hook fills it, and the target is exactly what we look up here.
export function flattenContent(content) {
  const headerValues = {};
  const rowValues = {};
  const types = {};
  const tables = [];
  const tableBySchemaId = new Map();
  let rowCount = 0;
  // `schema_id` on a multivalue is live-verified present (elis 2026-08-10);
  // the numeric-id fallback only keeps a nameless table from collapsing into
  // its neighbours.
  const tableFor = (node) => {
    const key = typeof node.schema_id === 'string' && node.schema_id !== ''
      ? node.schema_id
      : `#${node.id}`;
    let rec = tableBySchemaId.get(key);
    if (!rec) {
      rec = { schemaId: key, rowCount: 0, columns: [] };
      tableBySchemaId.set(key, rec);
      tables.push(rec);
    }
    return rec;
  };
  const walk = (node, rowIdx, table) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const c of node) walk(c, rowIdx, table);
      return;
    }
    if (node.category === 'multivalue' && Array.isArray(node.children)) {
      const tuples = node.children.filter((c) => c?.category === 'tuple');
      const rec = tableFor(node);
      if (tuples.length > rec.rowCount) rec.rowCount = tuples.length;
      if (tuples.length > rowCount) rowCount = tuples.length;
      tuples.forEach((tuple, idx) => walk(tuple, idx, rec));
      return;
    }
    const sid = node.schema_id;
    const c = node?.content;
    const isNumber = isNumberContent(c);
    const val = isNumber ? c.normalized_value : c?.value;
    if (sid && node.category === 'datapoint' && table && !table.columns.includes(sid)) {
      table.columns.push(sid);
    }
    if (sid && (typeof val === 'string' || typeof val === 'number')) {
      if (rowIdx == null) {
        if (!(sid in headerValues)) headerValues[sid] = val;
      } else {
        if (!rowValues[sid]) rowValues[sid] = [];
        while (rowValues[sid].length <= rowIdx) rowValues[sid].push('');
        rowValues[sid][rowIdx] = val;
      }
      if (isNumber && !(sid in types)) types[sid] = 'number';
    }
    if (Array.isArray(node.children)) for (const c of node.children) walk(c, rowIdx, table);
  };
  walk(content?.content || content, null, null);
  return { headerValues, rowValues, rowCount, types, tables };
}

export function valuesForRow(headerValues, rowValues, rowIdx) {
  const out = { ...headerValues };
  for (const [sid, arr] of Object.entries(rowValues)) {
    out[sid] = arr[rowIdx] != null ? arr[rowIdx] : '';
  }
  return out;
}

// Every schema_id a config substitutes: query placeholders AND the
// action_condition's. The condition is evaluated against the SELECTED row
// (see evaluateCfgCondition in ConfigBlock), so a config gated only on a
// row-level field is row-scoped just as much as one whose query uses it.
function configPlaceholderNames(cfg) {
  const out = new Set();
  for (const q of cfg?.queries || []) {
    for (const sid of q?.placeholders || []) out.add(sid);
  }
  for (const sid of cfg?.actionConditionPlaceholders || []) out.add(sid);
  return out;
}

export function configUsesLineItems(cfg, rowValues) {
  const rv = rowValues || {};
  for (const sid of configPlaceholderNames(cfg)) if (sid in rv) return true;
  return false;
}

// Which table's rows does this config's Row picker walk, and how many are there?
//
// The TARGET field's own table governs (owner's rule, 2026-08-10): a config
// writing into a VAT-rate row is about VAT rows, so it offers the VAT row
// count — never the line-item count just because that table is bigger. This
// also settles a config whose queries reference more than one table.
//
// When the target is a header field (MDH's header-level configs) there is no
// target table, so we fall back to the table the config's own row placeholders
// come from — the most-referenced one, document order breaking ties. Returns
// null when nothing about the config is row-scoped.
export function rowScopeForConfig(cfg, tables) {
  const list = Array.isArray(tables) ? tables : [];
  if (list.length === 0) return null;
  const scope = (t) => ({ tableSchemaId: t.schemaId, rowCount: t.rowCount });
  const target = cfg?.target;
  if (typeof target === 'string' && target !== '' && target !== NO_TARGET) {
    const owner = list.find((t) => t.columns.includes(target));
    if (owner) return scope(owner);
  }
  const names = configPlaceholderNames(cfg);
  let best = null;
  let bestHits = 0;
  for (const t of list) {
    const hits = t.columns.reduce((n, c) => (names.has(c) ? n + 1 : n), 0);
    if (hits > bestHits) {
      best = t;
      bestHits = hits;
    }
  }
  return best ? scope(best) : null;
}

// Placeholders whose schema_id wasn't returned by the annotation content fetch.
// An empty-string value still counts as "present" — let the query run and surface
// MDH's actual response, since some operators (e.g. exact $match) accept empties.
function missingPlaceholders(placeholders, values) {
  const missing = [];
  for (const key of placeholders) {
    if (!(key in values)) missing.push(key);
  }
  return missing;
}

// ── Queue → MDH hooks resolver ─────────────────────

export async function loadMdhHooksForQueue(domain, token, queueId) {
  const hooksResp = await fetchJson(
    `${domain}/api/v1/hooks?queue=${queueId}&page_size=100`,
    token,
  );
  return (hooksResp?.results || [])
    .filter((h) => h.active !== false && h.type === 'webhook')
    .filter(isMdhHook);
}

export function buildHookEntries(mdhHooks, queueId) {
  const queueIdNum = Number(queueId);
  return mdhHooks
    .map((hook) => ({
      hook,
      cfgs: extractConfigsFromHook(hook).filter(
        (c) => c.queueIds.length === 0 || c.queueIds.includes(queueIdNum),
      ),
    }))
    .filter((e) => e.cfgs.length > 0);
}

// Case-insensitive substring filter against the primary `cfg.target` OR any
// `cfg.additionalMappings[].target`. Empty/whitespace query returns the input
// array reference unchanged (cheap "no-op" identity check). Hooks left with
// zero matching cfgs are dropped.
export function filterHookEntries(entries, query) {
  const q = (query == null ? '' : String(query)).trim().toLowerCase();
  if (!q) return entries;
  const matches = (cfg) => {
    if (String(cfg?.target || '').toLowerCase().includes(q)) return true;
    const adds = Array.isArray(cfg?.additionalMappings) ? cfg.additionalMappings : [];
    return adds.some((m) => String(m?.target || '').toLowerCase().includes(q));
  };
  const out = [];
  for (const { hook, cfgs } of entries) {
    const filtered = cfgs.filter(matches);
    if (filtered.length > 0) out.push({ hook, cfgs: filtered });
  }
  return out;
}

// LIVE-VERIFIED 2026-08-10 (elis): `?schema_id=…` is SILENTLY IGNORED by this
// endpoint — a bogus id still returns the whole tree, and `results` is a
// duplicate of `content`. So the response always carries EVERY section, table
// and column, which is what lets flattenContent's `tables` locate the table
// behind a config's target field without a second request. The parameter is
// kept because it costs nothing and documents intent, but nothing may DEPEND on
// it narrowing the payload.
export async function loadAnnotationValues(domain, token, annotationId, placeholders) {
  if (!annotationId || placeholders.size === 0) {
    return { headerValues: {}, rowValues: {}, rowCount: 0, types: {}, tables: [] };
  }
  const url = `${domain}/api/v1/annotations/${annotationId}/content?schema_id=${[...placeholders].join(',')}`;
  const cdata = await fetchJson(url, token);
  return flattenContent(cdata);
}

// ── Status metadata (consumed by QueryItem renderer) ──

export const STATUS_GLYPH = {
  pending: { glyph: '…', cls: 'mdh-q-status--pending', title: 'Replaying…', showHint: false },
  winner: { glyph: '✓', cls: 'mdh-q-status--winner', title: 'Winning query', showHint: false },
  empty: { glyph: '—', cls: 'mdh-q-status--empty', title: 'No results', showHint: false },
  skipped: { glyph: '·', cls: 'mdh-q-status--skipped', title: 'Cascade short-circuited before this query', showHint: true },
  gated: { glyph: '⊘', cls: 'mdh-q-status--gated', title: 'Skipped — action_condition gates this configuration', showHint: true },
  error: { glyph: '!', cls: 'mdh-q-status--error', title: 'Replay failed', showHint: true },
};

// Evaluates a cfg's `action_condition` against the supplied annotation values.
// Returns `{ hasCondition, result, error, substituted }` where:
//   - `hasCondition` is false iff the cfg has no condition (cfg always runs)
//   - `result` is true | false | null (null on parse/eval error)
//   - `substituted` is the post-substitution expression (for UI display)
// A null result is treated as "don't gate" by replayConfig (the user sees the
// underlying error in the UI; gating on a broken expression would be worse).
export function evaluateCfgCondition(cfg, values, types) {
  const expr = cfg?.actionCondition;
  if (typeof expr !== 'string' || expr.trim() === '') {
    return { hasCondition: false, result: true, error: null, substituted: null };
  }
  const subst = substitutePlaceholders(expr, values || {}, types || {});
  const sStr = typeof subst === 'string' ? subst : String(subst);
  const ev = evalCondition(sStr);
  return { hasCondition: true, result: ev.result, error: ev.error, substituted: sStr };
}

// ── Cascade replay ─────────────────────────────────

// Runs the cascade: for each query, evaluate against MDH (with $limit:1) until
// one matches. Subsequent queries get marked "skipped". Returns the full
// statuses array (suitable for caching). `onStatus(i, {status, hint})` fires
// as each query resolves, so callers can update UI incrementally.
export async function replayConfig(domain, token, cfg, values, signal, onStatus, types) {
  const statuses = new Array(cfg.queries.length).fill(null);
  const record = (i, status, hint) => {
    statuses[i] = hint == null ? { status } : { status, hint };
    onStatus?.(i, statuses[i]);
  };
  // Honor `action_condition` — when it evaluates to false, MDH skips the cfg
  // entirely, so showing replay results for it would be misleading. A null
  // result (parse/eval error) is surfaced separately in the UI; we proceed
  // with replay in that case so the user still sees what the cascade would do.
  const cond = evaluateCfgCondition(cfg, values, types);
  if (cond.hasCondition && cond.result === false) {
    for (let i = 0; i < cfg.queries.length; i++) {
      record(i, 'gated', 'action_condition is false');
    }
    return statuses;
  }
  let foundWinner = false;
  for (let i = 0; i < cfg.queries.length; i++) {
    if (signal?.aborted) return null;
    if (foundWinner) {
      record(i, 'skipped', 'an earlier query already matched');
      continue;
    }
    const query = cfg.queries[i];
    const missing = missingPlaceholders(query.placeholders, values);
    if (missing.length > 0) {
      record(i, 'skipped', `missing field${missing.length === 1 ? '' : 's'} in annotation: ${missing.join(', ')}`);
      continue;
    }
    const pipeline = queryToPipeline(query.raw, { withLimit: true });
    if (!pipeline) {
      record(i, 'error', 'unknown query type');
      continue;
    }
    const substituted = substitutePlaceholders(pipeline, values, types);
    try {
      const data = await runAggregate(domain, token, cfg.dataset, substituted, signal);
      if (signal?.aborted) return null;
      const hits = Array.isArray(data?.result) ? data.result.length : 0;
      if (hits > 0) {
        record(i, 'winner', `${hits} hit${hits === 1 ? '' : 's'}`);
        foundWinner = true;
      } else {
        record(i, 'empty');
      }
    } catch (e) {
      if (signal?.aborted || e?.name === 'AbortError') return null;
      record(i, 'error', e?.message || 'request failed');
    }
  }
  return statuses;
}
