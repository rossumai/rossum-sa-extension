// src/console/orgName.ts
// The connected organization, resolved once at boot and shared by every Console
// app. Both signals stay null until it resolves, and null for good when the
// lookup fails — a connection line then reads exactly as it did before.
import { signal } from '@preact/signals';

export const orgName = signal<string | null>(null);

// Whether that organization is NOT a sandbox. Rossum marks a sandbox in its own
// UI and marks production with nothing, so absence is the only signal it gives —
// which is why this is worth saying out loud next to the name. A MISSING
// `sandbox` flag counts as production: a false alarm is the safe failure here,
// and staying quiet about a live org is not.
export const orgIsProduction = signal<boolean | null>(null);

export type ResolvedOrg = { name: string; production: boolean };

// The Console's token comes from the Rossum tab the popup read, so it is scoped
// to the organization behind that domain and /organizations lists exactly that
// one — the same source Galaxy names its org node from. /auth/user is NOT usable
// here: it returns the signed-in user's HOME org, which is org 1 for a system
// user. Failure is silent by design (a missing name is not worth an error bar),
// hence null on any non-OK, malformed or thrown response.
export async function resolveOrg(domain: string, token: string): Promise<ResolvedOrg | null> {
  try {
    const res = await fetch(`${domain}/api/v1/organizations/?page_size=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const org = data?.results?.[0];
    if (!org?.name) return null;
    return { name: org.name, production: !org.sandbox };
  } catch {
    return null;
  }
}
