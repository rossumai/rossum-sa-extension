// Absolute-URL Rossum API client for the DevTools panel. Unlike the content
// script's same-origin api.js, the panel runs on the extension origin, so it
// targets the inspected tab's origin explicitly with the page's secureToken.
import { filenameFrom } from './contentMeta.js';

let baseDomain = '';
let authHeader = '';

export function init(domain, token) {
  baseDomain = domain || '';
  authHeader = token ? `Token ${token}` : '';
}

function urlFor(apiPath) {
  if (typeof apiPath !== 'string' || !apiPath.startsWith('/api/v1/')) return null;
  if (apiPath.includes('..')) return null;
  return `${baseDomain}${apiPath}`;
}

export function getJson(apiPath) {
  const url = urlFor(apiPath);
  if (!url) return Promise.reject(new Error(`Invalid API path: ${apiPath}`));
  return fetch(url, { headers: authHeader ? { Authorization: authHeader } : {} }).then(async (r) => {
    if (!r.ok) { const e = new Error(`API ${r.status}`); e.status = r.status; e.body = await r.text().catch(() => ''); throw e; }
    return r.json();
  });
}

// Fetch a resource, branching on content-type: JSON → parsed data (editor path);
// anything else → a blob descriptor for PreviewPane. One network round-trip.
export function getResource(apiPath) {
  const url = urlFor(apiPath);
  if (!url) return Promise.reject(new Error(`Invalid API path: ${apiPath}`));
  return fetch(url, { headers: authHeader ? { Authorization: authHeader } : {} }).then(async (r) => {
    if (!r.ok) { const e = new Error(`API ${r.status}`); e.status = r.status; e.body = await r.text().catch(() => ''); throw e; }
    const contentType = r.headers.get('Content-Type') || '';
    if (/\bjson\b/i.test(contentType)) return { kind: 'json', data: await r.json() };
    const blob = await r.blob();
    return {
      kind: 'blob',
      contentType,
      size: blob.size,
      filename: filenameFrom(r.headers.get('Content-Disposition'), apiPath, contentType),
      blob,
    };
  });
}

export function patch(apiPath, body) {
  const url = urlFor(apiPath);
  if (!url) return Promise.reject(new Error(`Invalid API path: ${apiPath}`));
  return fetch(url, {
    method: 'PATCH',
    headers: { ...(authHeader ? { Authorization: authHeader } : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then(async (r) => {
    if (!r.ok) { const e = new Error(`API ${r.status}`); e.status = r.status; e.body = await r.text().catch(() => ''); throw e; }
    if (r.status === 204) return {};
    return r.json().catch(() => ({}));
  });
}
