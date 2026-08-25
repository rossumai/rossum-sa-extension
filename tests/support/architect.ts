// Shared fixtures for the Architect tests.
//
// `Deliverable` requires title/titleSource/createdAt/editedAt because api.ts's loader
// NORMALISES them on the way in ("absent on every doc written before titleSource
// existed" — api.ts:144-149), and everything downstream is entitled to that guarantee.
// Tests that assign straight into `store.deliverables.value` skip the loader, so they
// build the same normalised shape here rather than weakening the type to match a
// shortcut. Pass only the fields the assertion is about; the rest default the way the
// loader defaults them.
import type { Deliverable } from '../../src/fabry/architect/collectionPlan.js';

export function deliverable(partial: Partial<Deliverable> & { id: string }): Deliverable {
  return { text: '', order: 0, title: '', titleSource: '', createdAt: null, editedAt: null, ...partial };
}
