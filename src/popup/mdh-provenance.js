// MDH provenance — pure cascade replay engine + parsing helpers.
// No DOM access; consumers (Preact components) render based on returned data.

import { evalCondition } from './actionCondition.js';
import { reEscape } from '../mdh/reEscape.js';

// ── API ─────────────────────────────────────────────

export async function fetchJson(url, token) {
  const resp = await fetch(url, {
    headers: { Authorization: `token ${token}`, Accept: 'application/json' },
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
      target: target || '(no target)',
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

// Matches `{name}`, `{name | modifier}`, or `{name | modifier(arg)}`.
// Whitespace around the name, pipe, and parens is tolerated. Names are
// simple identifiers — `{secrets.foo}` is not matched (the popup can't
// resolve secrets, so leaving them literal mirrors current behavior).
const PLACEHOLDER_RE = /\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\|\s*([a-zA-Z_]+)(?:\s*\(\s*([^)]*?)\s*\))?\s*)?\}/g;
const PLACEHOLDER_EXACT_RE = /^\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\|\s*([a-zA-Z_]+)(?:\s*\(\s*([^)]*?)\s*\))?\s*)?\}$/;

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
    for (const m of node.matchAll(PLACEHOLDER_RE)) set.add(m[1]);
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
    const exact = node.match(PLACEHOLDER_EXACT_RE);
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
    return node.replace(PLACEHOLDER_RE, (_, name, modifier, arg) => {
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
export function flattenContent(content) {
  const headerValues = {};
  const rowValues = {};
  const types = {};
  let rowCount = 0;
  const walk = (node, rowIdx) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const c of node) walk(c, rowIdx);
      return;
    }
    if (node.category === 'multivalue' && Array.isArray(node.children)) {
      const tuples = node.children.filter((c) => c?.category === 'tuple');
      if (tuples.length > rowCount) rowCount = tuples.length;
      tuples.forEach((tuple, idx) => walk(tuple, idx));
      return;
    }
    const sid = node.schema_id;
    const c = node?.content;
    const isNumber = isNumberContent(c);
    const val = isNumber ? c.normalized_value : c?.value;
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
    if (Array.isArray(node.children)) for (const c of node.children) walk(c, rowIdx);
  };
  walk(content?.content || content, null);
  return { headerValues, rowValues, rowCount, types };
}

export function valuesForRow(headerValues, rowValues, rowIdx) {
  const out = { ...headerValues };
  for (const [sid, arr] of Object.entries(rowValues)) {
    out[sid] = arr[rowIdx] != null ? arr[rowIdx] : '';
  }
  return out;
}

export function configUsesLineItems(cfg, rowValues) {
  for (const q of cfg.queries) {
    for (const sid of q.placeholders) if (sid in rowValues) return true;
  }
  return false;
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

export async function loadAnnotationValues(domain, token, annotationId, placeholders) {
  if (!annotationId || placeholders.size === 0) {
    return { headerValues: {}, rowValues: {}, rowCount: 0, types: {} };
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
