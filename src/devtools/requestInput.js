// src/devtools/requestInput.js
// PURE: normalize free-form request-bar input into a Rossum /api/v1 apiPath.
// Returns { apiPath } | { error } | null (null = empty/no-op).
function hostOf(u) { try { return new URL(u).host; } catch { return ''; } }

export function normalizeRequestInput(raw, currentDomain) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;

  let path = s;
  if (/^https?:\/\//i.test(s)) {
    let u;
    try { u = new URL(s); } catch { return { error: 'Not a valid URL.' }; }
    const cur = hostOf(currentDomain);
    if (!cur || u.host !== cur) return { error: `Only ${cur || 'the current org'} can be queried here.` };
    path = u.pathname + u.search;
  }

  if (!path.startsWith('/')) path = '/' + path;
  if (!/^\/api\/v1(\/|$)/.test(path)) path = '/api/v1' + path;
  if (path.includes('..')) return { error: 'Invalid path.' };
  if (path.includes('{')) return { error: 'Replace the {id} placeholder with a real id.' };
  return { apiPath: path };
}
