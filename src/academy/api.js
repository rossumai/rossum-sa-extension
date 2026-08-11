// Reads only. The Console already holds the token from the consoleAuth flow.
// MUST accept the same options the content-script fetcher does. mint.js calls
// `get(path, check)`, and one check (collectionAdded) carries method/body/auth
// on the check object because Data Storage is a POST authenticated with Bearer,
// unlike everything under /api/v1/. Taking only `path` here would make mint's
// re-verification of that check fail every time, so the receipt could never be
// issued — the same defect this project already shipped once on the content
// script's default `get`.
export function fetchAcademyApi(path, { method = 'GET', body, auth = 'token' } = {}) {
  const domain = sessionStorage.getItem('consoleDomain');
  const token = sessionStorage.getItem('consoleToken');
  const scheme = auth === 'bearer' ? 'Bearer' : 'Token';
  const headers = { Authorization: `${scheme} ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`${domain}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((r) => {
    if (!r.ok) throw new Error(`API ${r.status}`);
    return r.json();
  });
}

export function whoami() {
  return fetchAcademyApi('/api/v1/auth/user/');
}
