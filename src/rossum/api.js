const apiCache = {};

export function fetchRossumApi(path) {
  if (!apiCache[path]) {
    const token = window.localStorage.getItem('secureToken');
    const headers = token ? { Authorization: `Token ${token}` } : {};
    apiCache[path] = fetch(path, { headers })
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
