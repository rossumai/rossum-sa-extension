// MDH provenance — pure cascade replay engine + parsing helpers.
// No DOM access; consumers (Preact components) render based on returned data.

import { evalCondition } from './actionCondition.js';
import { reEscape } from '../mdh/reEscape.js';
import { VAR_RE, VAR_RE_G, lookupVarName } from '../mdh/placeholderSyntax.js';

// ── API ─────────────────────────────────────────────

export async function fetchJson(url: string, token: string): Promise<any> {
  const resp = await fetch(url, {
    headers: { Authorization: `token ${token}`, Accept: 'application/json' },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

// Single write helper for the popup (the reviewing-lock force-release).
// Same auth + error contract as fetchJson above.
export async function apiPatch(url: string, token: string, body: any): Promise<any> {
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

async function runAggregate(
  domain: string,
  token: string,
  dataset: string,
  pipeline: any[],
  externalSignal?: AbortSignal | null,
  timeoutMs = 8000,
): Promise<any> {
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
        try {
          detail = await resp.text();
        } catch {
          /* ignore */
        }
      }
      detail = (detail || '').toString().trim();
      throw new Error(detail ? `${resp.status}: ${detail}` : `${resp.status}`);
    }
    return resp.json();
  } finally {
    clearTimeout(timer);
  }
}

export function extractIdFromUrl(url: unknown): string | null {
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
export function describeQuery(q: any): string {
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
export function queryToPipeline(q: any, { withLimit }: { withLimit?: boolean } = {}): any[] | null {
  let pipeline: any[] | null = null;
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
export function hookConfigs(hook: any): any[] {
  const c = hook?.settings?.configurations ?? hook?.settings?.configs;
  return Array.isArray(c) ? c : [];
}

// Display sentinel for a cfg with no `mapping.target_schema_id`. Shared so the
// producer and rowScopeForConfig (which must NOT look it up as a real field)
// cannot drift apart.
export const NO_TARGET = '(no target)';

export function extractConfigsFromHook(hook: any): any[] {
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
    const conditionPhSet = new Set<string>();
    if (actionCondition) collectPlaceholders(actionCondition, conditionPhSet);
    const additionalMappings = Array.isArray(cfg?.additional_mappings)
      ? cfg.additional_mappings
          .map((m: any) => ({
            target: m?.target_schema_id || '',
            datasetKey: m?.dataset_key || '',
          }))
          .filter((m: any) => m.target || m.datasetKey)
      : [];
    out.push({
      source: 'hook',
      name: cfg?.name || '',
      target: target || NO_TARGET,
      dataset: dataset || '(no dataset)',
      datasetKey,
      queueIds,
      actionCondition,
      // Array (not Set) so the structure survives chrome.storage.session JSON serialization.
      actionConditionPlaceholders: [...conditionPhSet],
      additionalMappings,
      queries: queries.map((q: any) => {
        const set = new Set<string>();
        collectPlaceholders(q, set);
        return { label: describeQuery(q), raw: q, placeholders: [...set] };
      }),
    });
  }
  return out;
}

function isMdhHook(hook: any): boolean {
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

function unquoteArg(raw: string): string {
  if (raw == null) return '';
  const t = raw.trim();
  if (
    t.length >= 2 &&
    ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"')))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

// Returns the modifier-applied value. The result type is dictated by the
// modifier: `split` → array of strings, `re` → string (Python re.escape
// parity, see mdh/reEscape.js), no modifier → pass-through string. Unknown
// modifiers fall back to the raw value.
function applyModifier(value: any, modifier: string, arg: string): any {
  if (modifier == null) return value;
  const s = value == null ? '' : String(value);
  if (modifier === 'split') return s.split(unquoteArg(arg));
  if (modifier === 're') return reEscape(s);
  return value;
}

export function collectPlaceholders(node: any, set: Set<string>): void {
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
export function substitutePlaceholders(
  node: any,
  values: Record<string, any>,
  types?: Record<string, string>,
): any {
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
    const out: Record<string, any> = {};
    for (const [k, val] of Object.entries(node)) {
      const newK = substitutePlaceholders(k, values, types);
      out[typeof newK === 'string' ? newK : JSON.stringify(newK)] = substitutePlaceholders(
        val,
        values,
        types,
      );
    }
    return out;
  }
  return node;
}

// ── Schema types (authoritative placeholder types) ───

// Walk a queue schema's `content` tree and classify each datapoint's placeholder
// type. MDH substitution only distinguishes number-vs-string.
export function buildSchemaTypes(content: any): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (nodes: any[]): void => {
    if (Array.isArray(nodes)) {
      for (const n of nodes) walkNode(n);
      return;
    }
    if (nodes && typeof nodes === 'object') walkNode(nodes);
  };
  const walkNode = (node: any): void => {
    if (!node || typeof node !== 'object') return;
    if (node.category === 'datapoint' && node.id) {
      const isNumber =
        node.type === 'number' || (node.type === 'enum' && node.enum_value_type === 'number');
      out[node.id] = isNumber ? 'number' : 'string';
    }
    if (node.children != null) walk(node.children);
  };
  walk(content);
  return out;
}

// Schema types are authoritative; the normalized_value heuristic fills any field
// the schema does not cover (or when the schema fetch failed → schemaTypes {}).
export function mergeSchemaTypes(
  heuristicTypes: Record<string, string>,
  schemaTypes: Record<string, string>,
): Record<string, string> {
  return { ...(heuristicTypes || {}), ...(schemaTypes || {}) };
}

// Explicit per-placeholder type map for the editor tab. Explicit 'string' (not
// omission) so the editor treats it as an authoritative override and reproduces
// the Provenance replay exactly.
export function buildVariableTypes(
  placeholders: Iterable<string>,
  types: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const t = types || {};
  for (const name of placeholders) out[name] = t[name] === 'number' ? 'number' : 'string';
  return out;
}

async function fetchQueueSchemaContent(
  domain: string,
  token: string,
  queueId: string | number,
): Promise<any[] | null> {
  const queue = await fetchJson(`${domain}/api/v1/queues/${queueId}?fields=schema`, token);
  const schemaUrl = queue?.schema;
  if (!schemaUrl) return null;
  const schema = await fetchJson(`${schemaUrl}?fields=content`, token);
  return schema?.content || [];
}

// Each datapoint's position in the schema, depth-first — the order the document
// renders its fields in, header sections and tables alike.
export function buildSchemaOrder(content: any): Record<string, number> {
  const out: Record<string, number> = {};
  let n = 0;
  const walk = (nodes: any): void => {
    const list = Array.isArray(nodes) ? nodes : nodes && typeof nodes === 'object' ? [nodes] : [];
    for (const node of list) {
      if (!node || typeof node !== 'object') continue;
      if (node.category === 'datapoint' && node.id && !(node.id in out)) out[node.id] = n++;
      if (node.children != null) walk(node.children);
    }
  };
  walk(content);
  return out;
}

export type QueueSchemaInfo = {
  types: Record<string, string>;
  lookups: any[];
  order: Record<string, number>;
};

// Fetch a queue's schema once and derive its datapoint types, its lookup fields
// and its field order. Best-effort: any failure (403/offline/missing schema)
// yields empty results so callers fall back to the heuristic, to hooks alone and
// to source order.
export async function loadSchemaForQueue(
  domain: string,
  token: string,
  queueId: string | number,
): Promise<QueueSchemaInfo> {
  const empty = { types: {}, lookups: [], order: {} };
  try {
    const content = await fetchQueueSchemaContent(domain, token, queueId);
    if (!content) return empty;
    return {
      types: buildSchemaTypes(content),
      lookups: extractLookupConfigs(content),
      order: buildSchemaOrder(content),
    };
  } catch {
    return empty;
  }
}

// ── Lookup fields ──────────────────────────────────
//
// A lookup field is a schema datapoint with ui_configuration.type "lookup": its
// MDH cascade lives on the datapoint (matching.configuration), not on a hook, and
// its variables are "$$name" bound to formulas. The engine SAVES its result on the
// annotation — every option carries struct.__query_index, the query that produced
// it — so the card reads the cascade's outcome instead of replaying it. See
// docs/superpowers/specs/2026-09-24-mdh-provenance-lookup-fields-design.md.

function collectLookupVars(node: any, set: Set<string>): void {
  if (typeof node === 'string') {
    const name = lookupVarName(node);
    if (name) set.add(name);
  } else if (Array.isArray(node)) {
    for (const c of node) collectLookupVars(c, set);
  } else if (node && typeof node === 'object') {
    for (const v of Object.values(node)) collectLookupVars(v, set);
  }
}

// One cfg per master_data_hub lookup datapoint, shaped like a hook cfg so the
// filter, the row picker and QueryItem reuse it. `tableSchemaId` is the multivalue
// the datapoint sits in, null for a header field.
export function extractLookupConfigs(content: any): any[] {
  const out: any[] = [];
  const walk = (nodes: any, table: string | null): void => {
    const list = Array.isArray(nodes) ? nodes : nodes && typeof nodes === 'object' ? [nodes] : [];
    for (const n of list) {
      if (!n || typeof n !== 'object') continue;
      if (n.category === 'multivalue') {
        walk(n.children, n.id || null);
        continue;
      }
      const m = n.matching;
      if (
        n.category === 'datapoint' &&
        n.ui_configuration?.type === 'lookup' &&
        m?.type === 'master_data_hub'
      ) {
        const conf = m.configuration || {};
        const queries = Array.isArray(conf.queries) ? conf.queries : [];
        out.push({
          source: 'lookup',
          name: n.label || '',
          target: n.id,
          dataset: conf.dataset || '(no dataset)',
          datasetKey: '',
          queueIds: [],
          actionCondition: null,
          actionConditionPlaceholders: [],
          additionalMappings: [],
          variables: conf.variables && typeof conf.variables === 'object' ? conf.variables : {},
          tableSchemaId: table,
          queries: queries.map((q: any) => {
            const set = new Set<string>();
            collectLookupVars(q, set);
            return { label: describeQuery(q), raw: q, placeholders: [...set] };
          }),
        });
      }
      if (n.children != null) walk(n.children, table);
    }
  };
  walk(content, null);
  return out;
}

// The engine's saved result on one lookup datapoint. `winnerIndex` is the
// __query_index of the option holding the datapoint's value (every option of one
// result carries the same index — live-verified — but a hand-picked value decides),
// null when nothing matched: a computed no-match has no `options` key at all.
export type LookupResult = {
  value: string;
  winnerIndex: number | null;
  optionCount: number;
  noRecalculation: boolean;
};

function lookupResultOf(node: any): LookupResult {
  const value = node?.content?.value == null ? '' : String(node.content.value);
  const options = Array.isArray(node?.options) ? node.options : [];
  const chosen = options.find((o: any) => o?.value === value) || options[0];
  const idx = chosen?.struct?.__query_index;
  return {
    value,
    winnerIndex: Number.isInteger(idx) ? idx : null,
    optionCount: options.length,
    noRecalculation: node?.no_recalculation === true,
  };
}

// Query statuses for a lookup cfg, derived from the saved result: queries before
// the winner found nothing, the ones after never ran.
export function lookupStatuses(cfg: any, result: LookupResult | null | undefined): any[] {
  const w = result?.winnerIndex;
  return (cfg?.queries || []).map((_: unknown, i: number) => {
    if (w == null || i < w) return { status: 'empty' };
    if (i === w) {
      const n = result!.optionCount;
      return { status: 'winner', hint: `${n} option${n === 1 ? '' : 's'}` };
    }
    return { status: 'skipped', hint: 'an earlier query already matched' };
  });
}

// The saved result for the cfg's target on the given row (header lookups ignore
// the row).
export function lookupResultFor(
  lookupResults: Record<string, any> | null | undefined,
  cfg: any,
  rowIdx: number,
): LookupResult | null {
  const r = lookupResults?.[cfg?.target];
  if (r == null) return null;
  return Array.isArray(r) ? r[rowIdx] || null : r;
}

// Substitute a lookup's "$$name" — WHOLE strings only, as the engine does. Values
// come from evaluate_formulas as strings, so they substitute as strings.
export function substituteLookupVars(node: any, values: Record<string, string>): any {
  if (typeof node === 'string') {
    const name = lookupVarName(node);
    return name && name in values ? values[name] : node;
  }
  if (Array.isArray(node)) return node.map((c) => substituteLookupVars(c, values));
  if (node && typeof node === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(node)) out[k] = substituteLookupVars(v, values);
    return out;
  }
  return node;
}

const VAR_PREFIX = '__var__';

// Insert a `__var__<name>` formula datapoint per variable beside the lookup's
// target (inside its tuple for a row-level lookup) — the dashboard's own "Test
// lookup" technique. Returns a new schema content; the input is not mutated.
export function withVariableDatapoints(schemaContent: any[], cfg: any): any[] {
  const vars = Object.entries(cfg?.variables || {}).map(([name, v]: [string, any]) => ({
    category: 'datapoint',
    id: `${VAR_PREFIX}${name}`,
    label: name,
    type: 'string',
    rir_field_names: [],
    constraints: { required: false },
    default_value: null,
    hidden: true,
    can_export: false,
    formula: typeof v?.__formula === 'string' ? v.__formula : '',
    ui_configuration: { type: 'formula', edit: 'disabled' },
  }));
  const copy = JSON.parse(JSON.stringify(schemaContent || []));
  const insert = (nodes: any): boolean => {
    const list = Array.isArray(nodes) ? nodes : nodes && typeof nodes === 'object' ? [nodes] : [];
    for (const n of list) {
      if (Array.isArray(n?.children)) {
        const i = n.children.findIndex((c: any) => c?.id === cfg.target);
        if (i >= 0) {
          n.children.splice(i + 1, 0, ...vars);
          return true;
        }
      }
      if (n?.children != null && insert(n.children)) return true;
    }
    return false;
  };
  insert(copy);
  return copy;
}

// Read the `__var__` values back out of evaluate_formulas' annotation content:
// the header occurrence, or the one in row `rowIdx` of the cfg's table.
export function readVariableValues(
  annotationContent: any,
  cfg: any,
  rowIdx: number,
): Record<string, string> {
  const out: Record<string, string> = {};
  const take = (nodes: any[]): void => {
    for (const n of nodes || []) {
      const sid = n?.schema_id;
      const name =
        typeof sid === 'string' && sid.startsWith(VAR_PREFIX) ? sid.slice(VAR_PREFIX.length) : null;
      if (name && !(name in out)) {
        const v = n?.content?.value;
        out[name] = v == null ? '' : String(v);
      }
      if (n?.category !== 'multivalue' && Array.isArray(n?.children)) take(n.children);
    }
  };
  const findTable = (nodes: any[]): any => {
    for (const n of nodes || []) {
      if (n?.category === 'multivalue' && n.schema_id === cfg.tableSchemaId) return n;
      const hit = Array.isArray(n?.children) ? findTable(n.children) : null;
      if (hit) return hit;
    }
    return null;
  };
  const content = Array.isArray(annotationContent) ? annotationContent : [];
  if (cfg?.tableSchemaId) {
    const table = findTable(content);
    const tuples = (table?.children || []).filter((c: any) => c?.category === 'tuple');
    if (tuples[rowIdx]) take(tuples[rowIdx].children);
  } else {
    take(content);
  }
  return out;
}

// Resolve a lookup's variable values for one row: the schema, the annotation
// content, then evaluate_formulas over both with the `__var__` datapoints added.
// Internal endpoint — callers must treat a rejection as "values unavailable".
export async function resolveLookupVariables(
  domain: string,
  token: string,
  queueId: string | number,
  annotationId: string | number,
  cfg: any,
  rowIdx: number,
): Promise<Record<string, string>> {
  const schemaContent = await fetchQueueSchemaContent(domain, token, queueId);
  if (!schemaContent) throw new Error('no schema');
  const ann = await fetchJson(`${domain}/api/v1/annotations/${annotationId}/content`, token);
  const resp = await fetch(`${domain}/api/v1/internal/schemas/evaluate_formulas`, {
    method: 'POST',
    headers: {
      Authorization: `token ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      schema_content: withVariableDatapoints(schemaContent, cfg),
      annotation_content: ann?.content || [],
    }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  return readVariableValues(data?.annotation_content, cfg, rowIdx);
}

// Rossum's annotation-content endpoint does NOT include the schema-defined
// `type` per datapoint, but it does populate `normalized_value` for typed
// fields. type=number canonicalizes to a numeric string ("5552.14");
// type=date canonicalizes to ISO "2026-05-01" (Number() → NaN, so it
// won't match); type=string/enum leaves it null. So a finite-number
// `normalized_value` reliably proxies type=number without an extra
// schema fetch.
function isNumberContent(content: any): boolean {
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
//
// `lookupIds` names the lookup fields whose SAVED results to collect into
// `lookupResults`: one LookupResult for a header field, an array indexed by row
// for a field inside a table.
export function flattenContent(content: any, lookupIds: Iterable<string> = []) {
  const lookupSet = new Set(lookupIds);
  const lookupResults: Record<string, LookupResult | LookupResult[]> = {};
  const headerValues: Record<string, any> = {};
  const rowValues: Record<string, any[]> = {};
  const types: Record<string, string> = {};
  const tables: any[] = [];
  const tableBySchemaId = new Map();
  let rowCount = 0;
  // `schema_id` on a multivalue is live-verified present (elis 2026-08-10);
  // the numeric-id fallback only keeps a nameless table from collapsing into
  // its neighbours.
  const tableFor = (node: any) => {
    const key =
      typeof node.schema_id === 'string' && node.schema_id !== '' ? node.schema_id : `#${node.id}`;
    let rec = tableBySchemaId.get(key);
    if (!rec) {
      rec = { schemaId: key, rowCount: 0, columns: [] };
      tableBySchemaId.set(key, rec);
      tables.push(rec);
    }
    return rec;
  };
  const walk = (node: any, rowIdx: number | null, table: any): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const c of node) walk(c, rowIdx, table);
      return;
    }
    if (node.category === 'multivalue' && Array.isArray(node.children)) {
      const tuples = node.children.filter((c: any) => c?.category === 'tuple');
      const rec = tableFor(node);
      if (tuples.length > rec.rowCount) rec.rowCount = tuples.length;
      if (tuples.length > rowCount) rowCount = tuples.length;
      tuples.forEach((tuple: any, idx: number) => walk(tuple, idx, rec));
      return;
    }
    const sid = node.schema_id;
    const c = node?.content;
    const isNumber = isNumberContent(c);
    const val = isNumber ? c.normalized_value : c?.value;
    if (sid && node.category === 'datapoint' && table && !table.columns.includes(sid)) {
      table.columns.push(sid);
    }
    if (sid && node.category === 'datapoint' && lookupSet.has(sid)) {
      if (rowIdx == null) {
        if (!(sid in lookupResults)) lookupResults[sid] = lookupResultOf(node);
      } else {
        const arr = (lookupResults[sid] as LookupResult[] | undefined) || [];
        arr[rowIdx] = lookupResultOf(node);
        lookupResults[sid] = arr;
      }
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
  return { headerValues, rowValues, rowCount, types, tables, lookupResults };
}

export function valuesForRow(
  headerValues: Record<string, any>,
  rowValues: Record<string, any>,
  rowIdx: number | null,
): Record<string, any> {
  const out = { ...headerValues };
  for (const [sid, arr] of Object.entries(rowValues)) {
    out[sid] = arr[rowIdx as number] != null ? arr[rowIdx as number] : '';
  }
  return out;
}

// Every schema_id a config substitutes: query placeholders AND the
// action_condition's. The condition is evaluated against the SELECTED row
// (see evaluateCfgCondition in ConfigBlock), so a config gated only on a
// row-level field is row-scoped just as much as one whose query uses it.
function configPlaceholderNames(cfg: any): Set<string> {
  const out = new Set<string>();
  for (const q of cfg?.queries || []) {
    for (const sid of q?.placeholders || []) out.add(sid);
  }
  for (const sid of cfg?.actionConditionPlaceholders || []) out.add(sid);
  return out;
}

export function configUsesLineItems(cfg: any, rowValues: Record<string, any>): boolean {
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
// The guard below is the contract — an absent list scopes to nothing.
export function rowScopeForConfig(cfg: any, tables: any[] | null | undefined) {
  const list = Array.isArray(tables) ? tables : [];
  if (list.length === 0) return null;
  const scope = (t: any) => ({ tableSchemaId: t.schemaId, rowCount: t.rowCount });
  const target = cfg?.target;
  if (typeof target === 'string' && target !== '' && target !== NO_TARGET) {
    const owner = list.find((t) => t.columns.includes(target));
    if (owner) return scope(owner);
  }
  const names = configPlaceholderNames(cfg);
  let best = null;
  let bestHits = 0;
  for (const t of list) {
    const hits = t.columns.reduce((n: number, c: string) => (names.has(c) ? n + 1 : n), 0);
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
function missingPlaceholders(placeholders: string[], values: Record<string, any>): string[] {
  const missing = [];
  for (const key of placeholders) {
    if (!(key in values)) missing.push(key);
  }
  return missing;
}

// ── Queue → MDH hooks resolver ─────────────────────

export async function loadMdhHooksForQueue(
  domain: string,
  token: string,
  queueId: string | number,
): Promise<any[]> {
  const hooksResp = await fetchJson(`${domain}/api/v1/hooks?queue=${queueId}&page_size=100`, token);
  return (hooksResp?.results || [])
    .filter((h: any) => h.active !== false && h.type === 'webhook')
    .filter(isMdhHook);
}

export function buildHookEntries(mdhHooks: any[], queueId: string | number): any[] {
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

// Case-insensitive substring match against the primary `cfg.target` OR any
// `cfg.additionalMappings[].target`.
function matchesTargetFilter(cfg: any, q: string): boolean {
  if (
    String(cfg?.target || '')
      .toLowerCase()
      .includes(q)
  )
    return true;
  const adds = Array.isArray(cfg?.additionalMappings) ? cfg.additionalMappings : [];
  return adds.some((m: any) =>
    String(m?.target || '')
      .toLowerCase()
      .includes(q),
  );
}

// One row of the card: a cfg and where it came from (`hook` null = a lookup field).
export type ProvenanceItem = { key: string; cfg: any; hook: { id: any; name?: string } | null };

// Every cfg the card shows, from both sources, as ONE list in the order their
// target fields appear in the schema — the order the document reads in, so a
// lookup and a hook matching the same thing sit side by side. The sort is stable,
// so a hook's own configurations keep their array order among equals, and a
// target the schema does not know (a typo, NO_TARGET) sinks to the end in its
// original place. `key` comes from the UNFILTERED position, so the replay cache
// entry for a cfg does not change when the filter does.
export function provenanceItems(
  hookEntries: any[] | null | undefined,
  lookupCfgs: any[] | null | undefined,
  order: Record<string, number> | null | undefined,
  query?: unknown,
): ProvenanceItem[] {
  const items: ProvenanceItem[] = [];
  for (const { hook, cfgs } of hookEntries || []) {
    (cfgs || []).forEach((cfg: any, i: number) =>
      items.push({ key: `${hook.id}::${i}`, cfg, hook }),
    );
  }
  for (const cfg of lookupCfgs || []) items.push({ key: `lookup::${cfg.target}`, cfg, hook: null });
  const q = (query == null ? '' : String(query)).trim().toLowerCase();
  const kept = q ? items.filter((it) => matchesTargetFilter(it.cfg, q)) : items;
  const pos = (it: ProvenanceItem) => {
    const p = order?.[it.cfg?.target];
    return typeof p === 'number' ? p : Number.MAX_SAFE_INTEGER;
  };
  return kept
    .map((it, i) => ({ it, i }))
    .sort((a, b) => pos(a.it) - pos(b.it) || a.i - b.i)
    .map((x) => x.it);
}

// LIVE-VERIFIED 2026-08-10 (elis): `?schema_id=…` is SILENTLY IGNORED by this
// endpoint — a bogus id still returns the whole tree, and `results` is a
// duplicate of `content`. So the response always carries EVERY section, table
// and column, which is what lets flattenContent's `tables` locate the table
// behind a config's target field without a second request. The parameter is
// kept because it costs nothing and documents intent, but nothing may DEPEND on
// it narrowing the payload.
export async function loadAnnotationValues(
  domain: string,
  token: string,
  annotationId: string | number,
  placeholders: Set<string>,
  lookupIds: Set<string> = new Set(),
) {
  if (!annotationId || (placeholders.size === 0 && lookupIds.size === 0)) {
    return {
      headerValues: {},
      rowValues: {},
      rowCount: 0,
      types: {},
      tables: [],
      lookupResults: {},
    };
  }
  const ids = [...placeholders, ...lookupIds];
  const url = `${domain}/api/v1/annotations/${annotationId}/content?schema_id=${ids.join(',')}`;
  const cdata = await fetchJson(url, token);
  return flattenContent(cdata, lookupIds);
}

// ── Status metadata (consumed by QueryItem renderer) ──

// Keyed by the replay status string, which the popup reads from a value it does not
// control — so the lookup is by string rather than by the literal union.
export const STATUS_GLYPH: Record<
  string,
  { glyph: string; cls: string; title: string; showHint: boolean }
> = {
  pending: { glyph: '…', cls: 'mdh-q-status--pending', title: 'Replaying…', showHint: false },
  winner: { glyph: '✓', cls: 'mdh-q-status--winner', title: 'Winning query', showHint: false },
  empty: { glyph: '—', cls: 'mdh-q-status--empty', title: 'No results', showHint: false },
  skipped: {
    glyph: '·',
    cls: 'mdh-q-status--skipped',
    title: 'Cascade short-circuited before this query',
    showHint: true,
  },
  gated: {
    glyph: '⊘',
    cls: 'mdh-q-status--gated',
    title: 'Skipped — action_condition gates this configuration',
    showHint: true,
  },
  error: { glyph: '!', cls: 'mdh-q-status--error', title: 'Replay failed', showHint: true },
};

// Evaluates a cfg's `action_condition` against the supplied annotation values.
// Returns `{ hasCondition, result, error, substituted }` where:
//   - `hasCondition` is false iff the cfg has no condition (cfg always runs)
//   - `result` is true | false | null (null on parse/eval error)
//   - `substituted` is the post-substitution expression (for UI display)
// A null result is treated as "don't gate" by replayConfig (the user sees the
// underlying error in the UI; gating on a broken expression would be worse).
export function evaluateCfgCondition(
  cfg: any,
  values: Record<string, any>,
  types?: Record<string, string>,
) {
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
export async function replayConfig(
  domain: string,
  token: string,
  cfg: any,
  values: Record<string, any>,
  signal?: AbortSignal | null,
  onStatus?: (i: number, status: string, hint?: string) => void,
  types?: Record<string, string>,
) {
  const statuses = new Array(cfg.queries.length).fill(null);
  const record = (i: number, status: string, hint?: string) => {
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
      record(
        i,
        'skipped',
        `missing field${missing.length === 1 ? '' : 's'} in annotation: ${missing.join(', ')}`,
      );
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
      if (signal?.aborted || (e as any)?.name === 'AbortError') return null;
      record(i, 'error', (e as any)?.message || 'request failed');
    }
  }
  return statuses;
}
