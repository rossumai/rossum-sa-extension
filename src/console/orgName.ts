// The connected organization for the Console's connection lines, by the same loader and
// rules as the Rossum header (rossum/orgSource.ts), so the two can never name different
// organizations: its name, then ` · org: <id> [<location>]`. `get` is an initialised
// Console API client's GET — its timeout and auth, not a second transport. `show` gets
// the name as soon as it is known and again with the location. Silent by design: a missing
// name is not worth an error bar, and a group that cannot be read only leaves it out.
import { orgLabel } from '../rossum/orgName.js';
import { loadOrg } from '../rossum/orgSource.js';

export function resolveOrgLabel(
  get: (path: string) => Promise<unknown>,
  show: (label: string) => void,
): Promise<void> {
  return loadOrg({ get, withLocation: true, show: (org) => show(orgLabel(org, ' · org: ')) });
}
