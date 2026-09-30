// Labels and links for a changelog row. Pure.
import type { ChangelogEntry } from './api.js';

export function modifierLabel(id: number | null, users: Map<number, string>): string {
  if (id == null) return 'System';
  return users.get(id) || `User ${id}`;
}

export function versionPageUrl(domain: string, e: ChangelogEntry): string {
  return `${domain}/settings/configuration-changelog/${e.version_id}?objectType=${e.object_type}&objectId=${e.object_id}`;
}
