// src/devtools/requestInput.ts
// PURE: normalize free-form request-bar input into a Rossum /api/v1 apiPath.
// Returns { apiPath } | { error } | null (null = empty/no-op).
function hostOf(u: string) {
  try {
    return new URL(u).host;
  } catch {
    return '';
  }
}

/** Either an accepted path, or a message to show. `null` means "nothing typed yet". */
/**
 * Discriminated on purpose: declaring the absent key as `?: undefined` on each arm lets a
 * caller read `norm.error` / `norm.apiPath` and have TypeScript narrow from that alone —
 * no `in` test, no guard, and so no emitted code. Same device as DeepOutcome's `skipped?: false`.
 */
export type NormalizedRequest =
  { apiPath: string; error?: undefined } | { apiPath?: undefined; error: string };

export function normalizeRequestInput(
  raw: unknown,
  currentDomain: string,
): NormalizedRequest | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;

  let path = s;
  if (/^https?:\/\//i.test(s)) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      return { error: 'Not a valid URL.' };
    }
    const cur = hostOf(currentDomain);
    if (!cur || u.host !== cur)
      return { error: `Only ${cur || 'the current org'} can be queried here.` };
    path = u.pathname + u.search;
  }

  if (!path.startsWith('/')) path = '/' + path;
  if (!/^\/api\/v1(\/|$)/.test(path)) path = '/api/v1' + path;
  if (path.includes('..')) return { error: 'Invalid path.' };
  if (path.includes('{')) return { error: 'Replace the {id} placeholder with a real id.' };
  return { apiPath: path };
}
