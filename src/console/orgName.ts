// The connected organization's name, by the same rule as the Rossum header
// (currentOrgName), so the two can never name different organizations. `get` is an
// initialised Console API client's GET — its timeout and auth, not a second transport.
// Silent by design: a missing name is not worth an error bar.
import { currentOrgName } from '../rossum/orgName.js';

export async function resolveOrgName(
  get: (path: string) => Promise<unknown>,
): Promise<string | null> {
  try {
    return currentOrgName(await get('/api/v1/organizations'));
  } catch {
    return null;
  }
}
