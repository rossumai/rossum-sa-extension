import { formatTime } from './relativeTime.js';

// Pure presentation logic for MDH V2 search indexes. The panel is a thin layer
// over these; none of them makes a request.

// V2's `definition` is already valid input to a PUT — a definition read back and
// fed straight to putSearchIndex round-trips (verified live), and an index that
// exists only on the engine comes back in the engine's camelCase, which V2 also
// accepts. So there is nothing left to convert: this is a guard, not a transform.
export function toSearchIndexDefinition(idx: any): Record<string, any> {
  if (!idx || typeof idx !== 'object') return {};
  const def = idx.definition;
  return def && typeof def === 'object' ? def : {};
}

// The registry can be ahead of the engine (PENDING_*), or the engine can be
// working (PENDING, BUILDING, DELETING). Anything else — including a status this
// build has never seen — counts as settled, so an unknown value can only stop the
// reconcile poll early, never spin it forever. DELETING is here even though it is
// absent from the OpenAPI enum, because the deprecated list emits it.
const TRANSITIONAL = new Set([
  'PENDING_CREATE',
  'PENDING_UPDATE',
  'PENDING_DELETE',
  'PENDING',
  'BUILDING',
  'DELETING',
]);

export function isTransitional(status: any): boolean {
  return TRANSITIONAL.has(String(status || '').toUpperCase());
}

// The API's vocabulary is faithful but not self-explanatory, so the badge keeps
// the API's word and the tooltip carries the meaning — a badge and a support
// answer then use the same term.
const STATUS_TITLES: Record<string, string> = {
  PENDING_CREATE: 'Declared — the engine has not started building it yet',
  PENDING_UPDATE: 'A new definition is declared — the engine is still serving the previous one',
  PENDING_DELETE: 'Removed from the declaration — the engine is still dropping it',
  DELETING: 'Removed from the declaration — the engine is still dropping it',
  PENDING: 'Declared — waiting on the engine',
  BUILDING: 'The engine is building this index',
  READY: 'Built and queryable',
  FAILED: 'The engine rejected this definition',
  STALE: "The engine's index no longer matches the declaration",
};

export function statusBadge(status: any): { text: string; cls: string; title: string } | null {
  if (!status) return null;
  const upper = String(status).toUpperCase();
  const cls =
    upper === 'READY'
      ? 'index-badge-ready'
      : isTransitional(upper)
        ? 'index-badge-pending'
        : upper === 'FAILED' || upper === 'STALE'
          ? 'index-badge-failed'
          : '';
  return { text: upper.toLowerCase().replace(/_/g, ' '), cls, title: STATUS_TITLES[upper] || '' };
}

// The collection-level answer the per-index badges cannot give. V2 is the first
// version to separate "the registry is ahead" (PENDING_*) from "the engine is
// working" (BUILDING), so this line had no source before. "in progress" covers
// creating, updating, deleting and building alike — the indicator beside it
// carries the urgency, and four different words for one idea would not help.
// The timestamp is the poll's own last-look time, never a claim about the engine.
export function syncSummary(
  rows: any[],
  lastCheckedAt: number | null,
): { text: string; working: boolean } {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return { text: 'no indexes', working: false };
  const moving = list.filter((r) => isTransitional(r?.status)).length;
  const count = `${list.length} ${list.length === 1 ? 'index' : 'indexes'}`;
  const state = moving ? `${moving} in progress` : 'in sync';
  const checked = lastCheckedAt ? ` · checked ${formatTime(lastCheckedAt)}` : '';
  return { text: `${count} · ${state}${checked}`, working: moving > 0 };
}

// A one-line answer to "what does this index cover?", so a collapsed card still
// says which index is which. Built here rather than in JSX because \uXXXX does
// not work in JSX raw text and the em dash would render as six characters.
const NAMED_FIELDS = 3;

export function summarizeDefinition(definition: any): string {
  const mappings = definition && typeof definition === 'object' ? definition.mappings : null;
  if (!mappings || typeof mappings !== 'object') return '';
  const fields =
    mappings.fields && typeof mappings.fields === 'object' ? Object.keys(mappings.fields) : [];
  const label = fields.length === 1 ? 'field' : 'fields';
  if (mappings.dynamic === true) {
    return fields.length ? `dynamic + ${fields.length} ${label}` : 'dynamic — all fields';
  }
  if (!fields.length) return '';
  const shown = fields.slice(0, NAMED_FIELDS).join(', ');
  return fields.length > NAMED_FIELDS
    ? `${fields.length} ${label}: ${shown}…`
    : `${fields.length} ${label}: ${shown}`;
}

// A body carrying `indexName` is a 422 (`extra_forbidden`) — the name lives in
// the URL now. Users have snippets copied from the build that emitted the flat
// {indexName, mappings} shape, so lift the name out rather than reject the paste.
// Additive: it cannot refuse anything the strict form would accept.
export function splitPastedDefinition(parsed: any): { name: string | null; definition: any } {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { name: null, definition: parsed };
  }
  const { indexName, name, ...definition } = parsed;
  const lifted = typeof indexName === 'string' ? indexName : typeof name === 'string' ? name : null;
  return lifted ? { name: lifted, definition } : { name: null, definition: parsed };
}

// A rejected definition returns a string, not structured detail (MessageResponse
// has no `detail`), holding one Python repr per Pydantic error — and one
// unsupported mapping type produces eight, because the type is reported against
// each union branch plus the top level. The first is representative and the count
// is already in the heading. Anything not shaped like that list is returned whole,
// so an unrecognised error is never swallowed.
export function firstValidationLine(message: any): string {
  if (typeof message !== 'string') return '';
  const first = message.indexOf('\n  {');
  if (first === -1) return message;
  const second = message.indexOf('\n  {', first + 1);
  return second === -1 ? message : message.slice(0, second);
}
