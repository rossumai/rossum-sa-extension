// Build links into the Rossum UI from the origin the console already holds.
//
// ROUTES maps a reference type to a UI path. These are the conventional Rossum
// UI routes, currently UNVERIFIED — they still need confirmation against the
// live UI (a session the maintainer will run). A wrong path only yields a dead
// link, and unknown types already degrade to plain text (buildDeeplink returns
// null). Keeping them in one place means only this file changes if a route
// differs.
export type RefType = 'annotation' | 'queue' | 'hook';

export const ROUTES: Record<RefType, (id: string | number) => string> = {
  annotation: (id) => `/document/${id}`,
  queue: (id) => `/queues/${id}`,
  hook: (id) => `/settings/extensions/${id}`,
};

// Returns an absolute URL or null (unknown type / no origin / no id).
export function buildDeeplink(
  origin: string | null | undefined,
  type: string,
  id: string | number | null | undefined,
): string | null {
  if (!origin || id == null) return null;
  const route = ROUTES[type as RefType];
  if (!route) return null;
  return `${origin}${route(id)}`;
}
