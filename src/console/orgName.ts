// The connected organization, by the same rule as the Rossum header (currentOrg), so the
// two can never name different organizations: its name, then ` · org: <id>`. `get` is an
// initialised Console API client's GET — its timeout and auth, not a second transport.
// Silent by design: a missing name is not worth an error bar.
import { currentOrg, orgLabel } from '../rossum/orgName.js';

export async function resolveOrgLabel(
  get: (path: string) => Promise<unknown>,
): Promise<string | null> {
  try {
    const org = currentOrg(await get('/api/v1/organizations'));
    return org && orgLabel(org, ' · org: ');
  } catch {
    return null;
  }
}
