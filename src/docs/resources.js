// Rossum API resources — the port's stand-in for localpages' source-file viewer
// (spec 2026-08-17, D5).
//
// Upstream's modal previews a repo file (.py/.json/.yaml) linked from the Markdown,
// served by `/__source?path=…` and scoped to a git toplevel with a secret-shaped
// blocklist. There is no filesystem here (D2), so the same modal is re-aimed at the
// thing a Rossum SOW actually references: a resource on the org's own API. Link
// `https://<org>.rossum.app/api/v1/hooks/123` in a deliverable and it opens in the
// modal as highlighted JSON instead of navigating away.
//
// What survives of upstream's security model is its shape: a single outer boundary
// (there, the git root; here, the connected org's origin) plus a path rule. Nothing
// else is reachable — no other host, no non-API path, no traversal.

const API_PREFIX = '/api/v1/';

function sameOrigin(url, origin) {
  try { return new URL(url).origin === new URL(origin).origin; } catch { return false; }
}

// href → a normalized `/api/v1/…` path on the connected org, or null.
// Accepts an absolute URL on that origin, or a root-absolute path.
export function apiPathFromHref(href, origin) {
  const raw = String(href || '').trim();
  if (!raw || !origin) return null;
  let path;
  if (/^https?:\/\//i.test(raw)) {
    if (!sameOrigin(raw, origin)) return null;
    const u = new URL(raw);
    path = u.pathname + (u.search || '');
  } else if (raw.startsWith(API_PREFIX)) {
    path = raw;
  } else {
    return null;
  }
  const [pathname] = path.split('?');
  if (!pathname.startsWith(API_PREFIX)) return null;
  // Traversal can only ever widen the boundary, and no legitimate resource link
  // contains it.
  if (pathname.includes('..')) return null;
  // Strip a fragment and any trailing slash so one resource has one template key.
  return path.split('#')[0].replace(/\/+$/, '');
}

export function isResourceHref(href, origin) {
  return apiPathFromHref(href, origin) !== null;
}

// "hooks/123" — the modal's title, mirroring upstream's use of the basename.
export function resourceLabel(apiPath) {
  const clean = String(apiPath || '').split('?')[0];
  return clean.slice(API_PREFIX.length) || clean;
}

// ── Which PART of a resource a link means (owner, 2026-08-18) ────────────────────────────
//
// A prd2 extension is TWO files: `<hook>.json` (the whole hook definition) and `<hook>.py`
// (its implementation). Both used to resolve to the same modal, and because a code-bearing
// hook prefers its code, the JSON was unreachable — the defect this fixes.
//
// The view rides in the resource KEY as a query parameter, which is the one addressing scheme
// that survives both paths intact: `apiPathFromHref` already preserves a query and strips a
// fragment, and the export's `keyFor` reduces an href to `pathname + search`, so `?view=json`
// keys a `<template>` offline exactly as it keys a fetch live. It is REMOVED before the
// request, so nothing unrecognised ever reaches the Rossum API.
export const VIEW_PARAM = 'view';
// Order matters: it is the order the modal's switcher renders, and `code` leads because a
// function hook's implementation is what an SA usually opens.
export const RESOURCE_VIEWS = ['code', 'json'];

// apiPath -> { path, view }. The marker is claimed ONLY when its value is one of ours, so a
// real `view` query parameter (Rossum has none today) would still be passed through to the
// server rather than silently swallowed.
export function splitResourceView(apiPath) {
  const raw = String(apiPath || '');
  const qi = raw.indexOf('?');
  if (qi < 0) return { path: raw, view: null };
  const params = new URLSearchParams(raw.slice(qi + 1));
  const view = params.get(VIEW_PARAM);
  if (!view || !RESOURCE_VIEWS.includes(view)) return { path: raw, view: null };
  params.delete(VIEW_PARAM);
  const rest = params.toString();
  return { path: raw.slice(0, qi) + (rest ? `?${rest}` : ''), view };
}

// The key for the same resource in another view — how the switcher addresses its sibling.
// `null` clears the marker, giving the plain key an older build would also understand.
export function withResourceView(apiPath, view) {
  const { path } = splitResourceView(apiPath);
  if (!view || !RESOURCE_VIEWS.includes(view)) return path;
  return path + (path.includes('?') ? '&' : '?') + `${VIEW_PARAM}=${view}`;
}

// A serverless hook's IMPLEMENTATION is a string field inside its JSON, so previewing the
// resource as JSON shows the Python as one escaped line — measured at 130 characters for a
// three-line handler, with every newline as a literal `\n`. Unreadable, which is what the
// owner reported.
//
// Shape verified from the Rossum API tool contract (no org access needed): a function hook
// carries `config: { runtime: "python3.12", code: "def rossum_hook_request_handler(...)" }`,
// while a webhook carries `config: { url }` and no code at all. So: if there is code, show
// the code; otherwise show the JSON. `runtime` names the language rather than assuming it.
const RUNTIME_LANG = [[/^python/i, 'python'], [/^node|^js/i, 'javascript']];

export function runtimeLanguage(runtime) {
  for (const [re, lang] of RUNTIME_LANG) if (re.test(String(runtime || ''))) return lang;
  return 'python';   // the only runtime Rossum offers for function hooks today
}

// Raw response text → what the viewer should display.
// Returns { text, language, note, view, views } — `note` names WHICH part of the resource is on
// screen, so a reader is never left wondering whether they are seeing the whole object, and
// `views` is what the resource actually offers, which is what decides whether the modal shows a
// switcher at all.
//
// `view` argument: 'code' | 'json' | null. NULL IS THE LEGACY PATH and is deliberately
// unchanged — code when there is code, otherwise the JSON — so every link written before views
// existed, and every template embedded by an older build, behaves exactly as it did.
export function formatResource(raw, view = null) {
  let obj;
  try { obj = JSON.parse(raw); } catch { return { text: String(raw ?? ''), language: 'plaintext', note: '', view: null, views: [] }; }
  const rawCode = obj && obj.config && obj.config.code;
  const code = typeof rawCode === 'string' && rawCode.trim() ? rawCode : null;
  const views = code ? ['code', 'json'] : ['json'];
  const json = () => ({ text: JSON.stringify(obj, null, 2), language: 'json', view: 'json', views });

  if (view === 'json') {
    // Name it only when there is something to be confused WITH: on a webhook or a queue the
    // JSON is the whole resource and saying "definition" adds nothing.
    return { ...json(), note: code ? 'definition' : '' };
  }
  if (code && (view === 'code' || view === null)) {
    const runtime = (obj.config && obj.config.runtime) || '';
    return {
      text: code,
      language: runtimeLanguage(runtime),
      note: `config.code${runtime ? ` · ${runtime}` : ''}`,
      view: 'code',
      views,
    };
  }
  // Asked for code where there is none: a webhook carries `config.url` and no implementation.
  // Say so rather than showing the definition as if it were the code.
  if (view === 'code') return { ...json(), note: 'no code — this hook is a webhook' };
  return { ...json(), note: '' };
}

// One small fetcher rather than a dependency on another app's client: the Rossum core
// API takes `Token <key>`, unlike Data Storage's Bearer (a difference the training
// code documents the hard way). Read-only by construction — GET, no body.
export function createResourceFetcher({ domain, token, fetchImpl }) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  // The view marker is OURS: it is removed here, so the request is the plain resource URL and
  // the API never sees a parameter it did not define.
  async function fetchRaw(path) {
    if (!doFetch) throw new Error('no fetch available');
    const res = await doFetch(`${domain}${path}`, {
      headers: { Authorization: `Token ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText || ''}`.trim());
    return res.text();
  }
  async function fetchResource(apiPath) {
    const { path, view } = splitResourceView(apiPath);
    return formatResource(await fetchRaw(path), view);
  }
  return fetchResource;
}
