// Collections this extension owns, hidden from Dataset Management (owner, 2026-08-18).
//
// The Architect keeps its deliverables and their version history in a Data Storage
// collection on the customer's own org, so it shows up in the MDH sidebar beside their
// real datasets. `_SA_EXTENSION__` is the agreed marker for "ours, not theirs".
//
// Hiding is NOT a security boundary and must not read as one: the collection is plainly
// visible to anything else with the org's token, and the reveal toggle exists precisely
// because the MDH record editor is today the only way to hand-edit a deliverable or read
// a stored revision. It is decluttering.
import { LEGACY_COLLECTION } from '../fabry/architect/collectionNames.js';

export const HIDDEN_PREFIX = '_SA_EXTENSION__';

// The legacy Architect collection predates the prefix and cannot be renamed on every org
// (see collectionPlan.js), so it is named explicitly rather than left as the one visible
// artifact of a half-migrated fleet.
export const HIDDEN_NAMES = new Set([LEGACY_COLLECTION]);

export function isHiddenCollection(name) {
  const n = String(name ?? '');
  return n.startsWith(HIDDEN_PREFIX) || HIDDEN_NAMES.has(n);
}

// `showHidden` comes from the sidebar toggle. Order is preserved — the caller sorts.
export function visibleCollections(names, showHidden = false) {
  const list = Array.isArray(names) ? names : [];
  return showHidden ? [...list] : list.filter((n) => !isHiddenCollection(n));
}

export function hiddenCount(names) {
  return (Array.isArray(names) ? names : []).filter(isHiddenCollection).length;
}
