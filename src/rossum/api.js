const apiCache = {};

// Resolves to an absolute, same-origin URL on the Rossum API. Rejects anything
// that could redirect a token-bearing fetch elsewhere (absolute URLs, scheme,
// protocol-relative, ../ traversal, paths outside /api/v1/).
function safeApiUrl(path) {
  if (typeof path !== 'string' || !path.startsWith('/api/v1/')) return null;
  if (path.includes('..') || path.includes('//')) return null;
  return new URL(path, window.location.origin).toString();
}

export function fetchRossumApi(path) {
  const url = safeApiUrl(path);
  if (!url) return Promise.reject(new Error(`Invalid API path: ${path}`));
  if (!apiCache[path]) {
    const token = window.localStorage.getItem('secureToken');
    const headers = token ? { Authorization: `Token ${token}` } : {};
    apiCache[path] = fetch(url, { headers })
      .then((r) => {
        if (!r.ok) throw new Error(`API ${r.status}`);
        return r.json();
      })
      .catch((err) => {
        delete apiCache[path];
        throw err;
      });
  }
  return apiCache[path];
}

function authHeaders() {
  const token = window.localStorage.getItem('secureToken');
  return token ? { Authorization: `Token ${token}` } : {};
}

function apiError(status) {
  const e = new Error(`API ${status}`);
  e.status = status;
  return e;
}

// Uncached same-origin GET → parsed JSON. Use when freshness matters (post-write reads).
export function getJson(path) {
  const url = safeApiUrl(path);
  if (!url) return Promise.reject(new Error(`Invalid API path: ${path}`));
  return fetch(url, { headers: authHeaders() }).then((r) => {
    if (!r.ok) throw apiError(r.status);
    return r.json();
  });
}

// Uncached same-origin GET of a binary resource → base64 (no data: prefix).
export function getBase64(path) {
  const url = safeApiUrl(path);
  if (!url) return Promise.reject(new Error(`Invalid API path: ${path}`));
  return fetch(url, { headers: authHeaders() }).then((r) => {
    if (!r.ok) throw apiError(r.status);
    return r.arrayBuffer();
  }).then((buf) => {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  });
}

// Same-origin POST → parsed JSON ({} for 204). Used for annotation writes/validate.
export function postRossumApi(path, body) {
  const url = safeApiUrl(path);
  if (!url) return Promise.reject(new Error(`Invalid API path: ${path}`));
  return fetch(url, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then((r) => {
    if (!r.ok) throw apiError(r.status);
    if (r.status === 204) return {};
    return r.json().catch(() => ({}));
  });
}
