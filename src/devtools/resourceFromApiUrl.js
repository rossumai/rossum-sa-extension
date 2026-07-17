// PURE: map a Rossum API URL (…/api/v1/<collection>/<id>) to a resource descriptor.
const READONLY_COLLECTIONS = new Set(['organization_groups']);
const LABELS = {
  queues: 'Queue', schemas: 'Schema', hooks: 'Hook', workspaces: 'Workspace',
  engines: 'Engine', rules: 'Rule', annotations: 'Annotation', users: 'User',
  organizations: 'Organization', organization_groups: 'Organization group', inboxes: 'Inbox',
};
const TYPE = {
  queues: 'queue', schemas: 'schema', hooks: 'hook', workspaces: 'workspace',
  engines: 'engine', rules: 'rule', annotations: 'annotation', users: 'user',
  organizations: 'organization', organization_groups: 'organization_group', inboxes: 'inbox',
};
function titleSingular(collection) {
  let s = collection;
  if (/(?:s|x|z|ch|sh)es$/.test(s)) s = s.slice(0, -2);   // boxes→box, inboxes→inbox, batches→batch
  else if (/ies$/.test(s)) s = s.slice(0, -3) + 'y';       // policies→policy
  else if (/s$/.test(s)) s = s.slice(0, -1);               // pages→page, templates→template, queues→queue
  return s.charAt(0).toUpperCase() + s.slice(1);
}
export function resourceFromApiUrl(url) {
  if (typeof url !== 'string') return null;
  // Sub-path segments may be words OR numeric ids (e.g. .../content/<datapointId>).
  const m = url.match(/\/api\/v1\/([a-z_]+)\/(\d+)((?:\/[a-z0-9_]+)*)\/?(?:[?#]|$)/);
  if (!m) return null;
  const collection = m[1];
  const id = m[2];
  const sub = m[3] || '';
  const apiPath = `/api/v1/${collection}/${id}${sub}`;
  if (sub) {
    const parts = sub.slice(1).split('/');
    const last = parts[parts.length - 1];
    const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
    // A trailing numeric segment is a sub-resource id — label it "<Preceding> <id>"
    // (e.g. "Content 19453284337") so it reads clearly and multiples stay distinct.
    const label = /^\d+$/.test(last) && parts.length >= 2 ? `${cap(parts[parts.length - 2])} ${last}` : cap(last);
    return { type: collection, id, apiPath, label, readOnly: true };
  }
  const base = {
    type: TYPE[collection] || collection,
    id,
    apiPath,
    label: LABELS[collection] || titleSingular(collection),
  };
  if (READONLY_COLLECTIONS.has(collection)) base.readOnly = true;
  return base;
}

// A generic READ-ONLY descriptor for list / query / unknown paths (no id).
// Used by the request bar when the input isn't a single editable resource.
export function genericResourceFromPath(apiPath) {
  if (typeof apiPath !== 'string' || !apiPath.startsWith('/api/v1/')) return null;
  const rest = apiPath.slice('/api/v1/'.length);
  const collection = (rest.match(/^([a-z_]+)/) || [])[1] || 'resource';
  const label = rest.length > 40 ? rest.slice(0, 39) + '…' : rest;
  return { type: collection, apiPath, label, readOnly: true };
}
