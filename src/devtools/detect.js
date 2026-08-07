// src/devtools/detect.js
// PURE: identify the Rossum config resource behind the current detail page.
// URL is authoritative on detail routes. Only rows whose route + apiPath are
// verified are listed here. Do NOT add schema/workspace/engine/rule/org routes
// from memory — they arrive via the live-verification task (see plan Task 12).
import { ANNOTATION_PATH_RE } from '../rossum/annotationUrl.js';

const ROUTES = [
  // Rule detail is nested UNDER a queue path (/queues/{q}/settings/rules/{ruleId}/detail),
  // so it must precede the queue row — first match wins. Capture group = ruleId.
  { type: 'rule',   re: /\/queues\/\d+\/settings\/rules\/(\d+)\/detail(?:[/?#]|$)/, api: (id) => `/api/v1/rules/${id}`, label: 'Rule' },
  { type: 'queue',  re: /\/queues\/(\d+)(?:[/?#]|$)/,                    api: (id) => `/api/v1/queues/${id}`, label: 'Queue' },
  { type: 'hook',   re: /\/extensions\/my-extensions\/(\d+)(?:[/?#]|$)/, api: (id) => `/api/v1/hooks/${id}`, label: 'Hook' },
  { type: 'user',   re: /\/settings\/users\/(\d+)(?:[/?#]|$)/,          api: (id) => `/api/v1/users/${id}`, label: 'User' },
  // schema route verified live 2026-07-10 (queue.schema=/v1/schemas/{id}).
  // engine/rule dashboard routes are derived from the Rossum SPA route table
  // (authoritative for the route; id→API-id mapping follows Rossum's universal convention,
  // same as queue/hook/user). Bundle-derived, not directly verified.
  { type: 'schema', re: /\/settings\/field-manager\/detail\/(\d+)(?:[/?#]|$)/, api: (id) => `/api/v1/schemas/${id}`, label: 'Schema' },
  { type: 'engine', re: /\/automation\/engines\/(\d+)(?:[/?#]|$)/,      api: (id) => `/api/v1/engines/${id}`, label: 'Engine' },
  // Annotation OBJECT (editable metadata; datapoint content is NOT edited here — that
  // uses the content-operations API). Both /document/<id> and /annotation/<id> carry the
  // ANNOTATION id (the 'document' path segment is historical). A trailing ?query (e.g.
  // ?datapointPath=...) is tolerated by the boundary group.
  { type: 'annotation', re: ANNOTATION_PATH_RE, api: (id) => `/api/v1/annotations/${id}`, label: 'Annotation' },
];

// Extract a single queue id from the /documents `filtering` query param, only
// when level=queue and exactly one queue value is selected (else null — no guess).
// Shape from owner example; verified live 2026-07-10.
function queueFromDocumentsSearch(search) {
  const params = new URLSearchParams(search || '');
  if (params.get('level') !== 'queue') return null;
  const filtering = params.get('filtering'); // URLSearchParams.get already percent-decodes
  if (!filtering) return null;
  let parsed;
  try { parsed = JSON.parse(filtering); } catch { return null; }
  const items = parsed && parsed.items;
  if (!Array.isArray(items)) return null;
  const qf = items.find((it) => it && it.field === 'queue' && Array.isArray(it.value));
  if (!qf || qf.value.length !== 1) return null;
  const id = String(qf.value[0]);
  return /^\d+$/.test(id) ? id : null;
}

export function detectResource(location /*, document */) {
  const path = (location && location.pathname) || '';
  const search = (location && location.search) || '';

  // Read-only collection (list) pages — drill into items via links.
  // Verified live 2026-07-10: /hooks|/users|/labels return 200 {pagination,results}.
  if (/^\/extensions\/my-extensions\/?$/.test(path)) return { type: 'hook', apiPath: '/api/v1/hooks', label: 'Hooks', readOnly: true };
  if (/^\/settings\/users\/?$/.test(path)) return { type: 'user', apiPath: '/api/v1/users', label: 'Users', readOnly: true };
  if (/^\/settings\/labels\/?$/.test(path)) return { type: 'label', apiPath: '/api/v1/labels', label: 'Labels', readOnly: true };

  // Documents dashboard filtered to a single queue (level=queue) → that queue, or
  // documents page with level=all → organization. Verified live 2026-07-10:
  // /api/v1/organizations results[0].url=/v1/organizations/{id}.
  if (/^\/documents\/?$/.test(path)) {
    const params = new URLSearchParams(search || '');
    if (params.get('level') === 'all') return { type: 'organization', via: 'org', label: 'Organization' };
    const q = queueFromDocumentsSearch(search);
    if (q) return { type: 'queue', id: q, apiPath: `/api/v1/queues/${q}`, label: 'Queue' };
  }

  // Queue "Emails" tab = the inbox editor. The URL carries only the queue id,
  // so return an unresolved descriptor; loadResource fetches queue.inbox.
  const emails = path.match(/\/queues\/(\d+)\/settings\/emails(?:[/?#]|$)/);
  if (emails) {
    const q = emails[1];
    return { type: 'inbox', via: 'queue-inbox', queueId: q, queueApiPath: `/api/v1/queues/${q}`, label: 'Inbox' };
  }

  // Queue "Fields" tab = the schema editor. The URL carries only the queue id,
  // so return an unresolved descriptor; loadResource fetches queue.schema.
  const fields = path.match(/\/queues\/(\d+)\/settings\/fields(?:[/?#]|$)/);
  if (fields) {
    const q = fields[1];
    return { type: 'schema', via: 'queue', queueId: q, queueApiPath: `/api/v1/queues/${q}`, label: 'Schema' };
  }
  for (const r of ROUTES) {
    const m = path.match(r.re);
    if (m) return { type: r.type, id: m[1], apiPath: r.api(m[1]), label: r.label };
  }
  return null;
}

// Exported for the live-verification task to extend + unit-test new rows.
export { ROUTES };
