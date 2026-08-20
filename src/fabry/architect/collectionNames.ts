// The Architect's Data Storage collection names, in a leaf module with no imports.
//
// Two consumers need them and neither should drag in the other's module graph: the
// Architect itself (which owns these documents) and MDH's sidebar filter (which must
// hide them from Dataset Management). One source of truth beats two literals that can
// silently disagree — the `tab-readers.js` duplication exists only because that code is
// serialized into the page by executeScript and cannot close over an import; nothing
// here has that constraint.
//
// `_SA_EXTENSION__` is the extension's hidden-collection convention (owner, 2026-08-18);
// `isHiddenCollection` in src/mdh/hiddenCollections.js is what enforces it. LIVE-VERIFIED
// on the internal org: Data Storage accepts a collection create under this prefix (200 ok),
// which also closes the `__`-prefix gate CLAUDE.md has carried since the Architect shipped.
export const COLLECTION = '_SA_EXTENSION__fabry_architect';

// The name every existing org still uses. Never dropped, never overwritten: a rename
// migrates it (verified: docs survive), and where the rename cannot happen the Architect
// keeps reading and writing it unchanged. See collectionPlan.js for the four states.
export const LEGACY_COLLECTION = '__mrfabry_architect';
