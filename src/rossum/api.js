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
