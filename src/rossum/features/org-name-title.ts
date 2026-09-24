import { fetchRossumApi } from '../api.js';

// The organization's name, first in the browser tab title.
//
// Rossum's own title is route-scoped and org-free — "Document List - Rossum",
// "Settings - Rossum" (measured live, 2026-09-23) — so every org's tab looks the
// same. That is the shared-hostname problem one level up: with several orgs open
// the tab strip cannot tell them apart either, and the navbar chip cannot help
// because you have to focus a tab to read it. Unlike that chip this costs no
// screen space, works on every route, and works on every org rather than only a
// dev environment.
//
// The name goes FIRST because browsers truncate a tab title from the right, so a
// suffix is the part that disappears exactly when there are enough tabs to need
// it.
//
// This one has a popup toggle (`orgNameInTitleEnabled`), unlike the navbar chip:
// it applies everywhere rather than self-gating, and a rewritten title reaches
// bookmarks and history entries, which is not a change to make for someone
// silently.
//
// The SPA rewrites the title on every route change, so a MutationObserver on the
// <title> element puts it back. Re-entry is guarded by the prefix test rather
// than a flag — our own write simply finds the title already prefixed, which also
// makes the observer safe to fire on itself.

const SEPARATOR = ' · ';

export async function init(): Promise<void> {
  const name = await resolveOrgName();
  if (!name) return;
  const prefix = name + SEPARATOR;
  const apply = () => {
    if (document.title.startsWith(prefix)) return;
    document.title = prefix + document.title;
  };
  apply();
  const titleEl = document.querySelector('title');
  if (!titleEl) return;
  new MutationObserver(apply).observe(titleEl, {
    childList: true,
    characterData: true,
    subtree: true,
  });
}

async function resolveOrgName(): Promise<string | null> {
  try {
    // Same lookup and cache as the navbar chip, so enabling both costs one request.
    const data = await fetchRossumApi('/api/v1/organizations/?page_size=1');
    return data?.results?.[0]?.name || null;
  } catch {
    return null;
  }
}
