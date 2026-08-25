// src/devtools/curl.ts
// PURE: build an equivalent GET curl command for a Rossum API path.
export function buildCurl({
  domain,
  apiPath,
  token,
}: { domain?: string; apiPath?: string; token?: string | null } = {}): string {
  const url = `${domain || ''}${apiPath || ''}`;
  const auth = token ? `Token ${token}` : 'Token $ROSSUM_TOKEN';
  const cmd = `curl -H 'Authorization: ${auth}' \\\n  '${url}'`;
  return token ? cmd : `${cmd}\n# export ROSSUM_TOKEN=<your token>`;
}
