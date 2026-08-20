// src/devtools/catalog.ts
// PURE-ish: curated catalog of the SA-relevant Rossum API surface, plus
// autocomplete + validation helpers. `ENDPOINTS` is mutated only by
// mergeLiveCollections (append-only, dedup by collection+kind).
export const ENDPOINTS = [
  { collection: 'queues', kind: 'list', pathTemplate: '/api/v1/queues', label: 'Queues', description: 'list · filters: workspace · ordering · page_size' },
  { collection: 'queues', kind: 'detail', pathTemplate: '/api/v1/queues/{id}', label: 'Queue', description: 'one queue · fields: schema, hooks, inbox, engine, workspace' },
  { collection: 'schemas', kind: 'list', pathTemplate: '/api/v1/schemas', label: 'Schemas', description: 'list · ordering · page_size' },
  { collection: 'schemas', kind: 'detail', pathTemplate: '/api/v1/schemas/{id}', label: 'Schema', description: 'one schema (content tree)' },
  { collection: 'hooks', kind: 'list', pathTemplate: '/api/v1/hooks', label: 'Hooks', description: 'list · filters: active, queue · page_size' },
  { collection: 'hooks', kind: 'detail', pathTemplate: '/api/v1/hooks/{id}', label: 'Hook', description: 'one hook/extension' },
  { collection: 'hooks', kind: 'sub', pathTemplate: '/api/v1/hooks/logs', label: 'Hook logs', description: 'hook execution logs · filters: hook, log_level' },
  { collection: 'engines', kind: 'list', pathTemplate: '/api/v1/engines', label: 'Engines', description: 'list of extraction engines' },
  { collection: 'engines', kind: 'detail', pathTemplate: '/api/v1/engines/{id}', label: 'Engine', description: 'one engine' },
  { collection: 'rules', kind: 'list', pathTemplate: '/api/v1/rules', label: 'Rules', description: 'list · filters: queue, enabled' },
  { collection: 'rules', kind: 'detail', pathTemplate: '/api/v1/rules/{id}', label: 'Rule', description: 'one business rule' },
  { collection: 'annotations', kind: 'list', pathTemplate: '/api/v1/annotations', label: 'Annotations', description: 'list · filters: queue, status, document, id · sideload: document, modifier · ordering' },
  { collection: 'annotations', kind: 'detail', pathTemplate: '/api/v1/annotations/{id}', label: 'Annotation', description: 'one annotation · sideload: document, modifier' },
  { collection: 'annotations', kind: 'sub', pathTemplate: '/api/v1/annotations/{id}/content', label: 'Annotation content', description: 'datapoint tree (read-only here)' },
  { collection: 'documents', kind: 'detail', pathTemplate: '/api/v1/documents/{id}', label: 'Document', description: 'one document' },
  { collection: 'documents', kind: 'sub', pathTemplate: '/api/v1/documents/{id}/content', label: 'Document content', description: 'original file (preview)' },
  { collection: 'pages', kind: 'detail', pathTemplate: '/api/v1/pages/{id}', label: 'Page', description: 'one page · page_data?granularity=words' },
  { collection: 'relations', kind: 'list', pathTemplate: '/api/v1/relations', label: 'Relations', description: 'annotation relations' },
  { collection: 'workspaces', kind: 'list', pathTemplate: '/api/v1/workspaces', label: 'Workspaces', description: 'list · filters: organization' },
  { collection: 'workspaces', kind: 'detail', pathTemplate: '/api/v1/workspaces/{id}', label: 'Workspace', description: 'one workspace' },
  { collection: 'organizations', kind: 'list', pathTemplate: '/api/v1/organizations', label: 'Organizations', description: 'list (usually one)' },
  { collection: 'organizations', kind: 'detail', pathTemplate: '/api/v1/organizations/{id}', label: 'Organization', description: 'one organization' },
  { collection: 'users', kind: 'list', pathTemplate: '/api/v1/users', label: 'Users', description: 'list · filters: username, email, is_active' },
  { collection: 'users', kind: 'detail', pathTemplate: '/api/v1/users/{id}', label: 'User', description: 'one user' },
  { collection: 'groups', kind: 'list', pathTemplate: '/api/v1/groups', label: 'Groups', description: 'permission groups' },
  { collection: 'connectors', kind: 'list', pathTemplate: '/api/v1/connectors', label: 'Connectors', description: 'legacy connectors' },
  { collection: 'email_templates', kind: 'list', pathTemplate: '/api/v1/email_templates', label: 'Email templates', description: 'list · filters: queue' },
  { collection: 'emails', kind: 'list', pathTemplate: '/api/v1/emails', label: 'Emails', description: 'list · filters: queue, thread' },
  { collection: 'email_threads', kind: 'list', pathTemplate: '/api/v1/email_threads', label: 'Email threads', description: 'list · filters: queue' },
  { collection: 'inboxes', kind: 'detail', pathTemplate: '/api/v1/inboxes/{id}', label: 'Inbox', description: 'one inbox' },
  { collection: 'workflows', kind: 'list', pathTemplate: '/api/v1/workflows', label: 'Workflows', description: 'approval workflows' },
  { collection: 'workflow_steps', kind: 'list', pathTemplate: '/api/v1/workflow_steps', label: 'Workflow steps', description: 'ordered steps · filter: workflow' },
  { collection: 'workflow_runs', kind: 'list', pathTemplate: '/api/v1/workflow_runs', label: 'Workflow runs', description: 'runs · filters: annotation, status' },
  { collection: 'workflow_activities', kind: 'list', pathTemplate: '/api/v1/workflow_activities', label: 'Workflow activities', description: 'assignee activity · filter: workflow_run' },
  { collection: 'audit_logs', kind: 'list', pathTemplate: '/api/v1/audit_logs', label: 'Audit logs', description: 'cursor pagination · filters: user, action, object' },
  { collection: 'tasks', kind: 'detail', pathTemplate: '/api/v1/tasks/{id}', label: 'Task', description: 'async operation status' },
  { collection: 'auth', kind: 'sub', pathTemplate: '/api/v1/auth/user', label: 'Auth user', description: 'the current user + home org' },
];

const API_PREFIX = '/api/v1/';

// The always-assumed /api/v1/ prefix is stripped to a collection-relative
// search term. Handles a full URL's host, a complete /api/v1/ prefix, a
// PARTIAL prefix the user is still typing ("/", "/api", "/api/v1", "/api/v1/"
// → ''), and already-relative input ("queues", "annotations?queue=1").
export function relPath(raw: unknown): string {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/^https?:\/\/[^/]+/i, '');          // drop a full URL's host
  if (s[0] === '/') {                                // absolute-ish input
    const lower = s.toLowerCase();
    if (lower.startsWith(API_PREFIX)) return s.slice(API_PREFIX.length);
    if (API_PREFIX.startsWith(lower)) return '';     // still typing the prefix
    return s.slice(1);                               // some other absolute path
  }
  return s;                                          // already relative
}

// A catalog pathTemplate's collection-relative form (drops /api/v1/) — what
// the bar shows and inserts, since the prefix is assumed.
export function shortPath(pathTemplate: string): string {
  return String(pathTemplate || '').replace(/^\/api\/v1\//, '');
}

export function suggest(raw: unknown): any[] {
  if (!String(raw || '').trim()) return [];
  // Match on the path portion; ignore any ?query the user is composing.
  const t = relPath(raw).toLowerCase().split('?')[0];
  // Empty term = the user is mid-typing the /api/v1/ prefix → offer the
  // common endpoints rather than an empty dropdown (the old "v1" dead spot).
  if (!t) return ENDPOINTS.slice(0, 8);
  const scored = [];
  for (const e of ENDPOINTS) {
    const sp = shortPath(e.pathTemplate).toLowerCase();
    const hay = `${e.collection} ${e.label} ${sp}`.toLowerCase();
    if (!hay.includes(t)) continue;
    const rank = e.collection.startsWith(t) ? 0 : sp.includes(t) ? 1 : 2;
    scored.push({ e, rank });
  }
  scored.sort((a, b) => a.rank - b.rank);
  return scored.slice(0, 8).map((x) => x.e);
}
