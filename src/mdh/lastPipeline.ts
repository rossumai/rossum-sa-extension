import { scopeSuffix } from './store.js';

// Per-organization, per-collection key for the most recent Data-panel pipeline
// (editor text + placeholder variables): a reload restores the query for that
// collection, and neither projects nor collections share it. scopeSuffix prefers
// the org id, falling back to the origin; the collection is the final segment.
export function lastPipelineKey(collection: string | null | undefined): string {
  return `mdhLastPipeline::${scopeSuffix()}::${collection || ''}`;
}

// Persist the current editor text + placeholder variables for a specific
// collection. Best-effort: a storage hiccup must never break editing.
export function saveLastPipeline(
  collection: string | null | undefined,
  pipelineText: string,
  variables?: Record<string, string> | null,
  placeholderTypes?: Record<string, string | undefined> | null,
): void {
  try {
    chrome.storage.local.set({
      [lastPipelineKey(collection)]: {
        pipelineText,
        variables: { ...(variables || {}) },
        placeholderTypes: { ...(placeholderTypes || {}) },
      },
    });
  } catch { /* storage unavailable — non-fatal */ }
}

// Pure decision for the boot path: given the stored entry, the collection that
// was restored on boot, and whether a popup prefill already claimed the
// one-shot pendingPipelineLoad slot, return the value to restore (text +
// variables for that collection) or null.
export function bootPrefillFor(
  stored: any,
  selectedCollection: string | null | undefined,
  hasPendingPrefill: boolean,
) {
  if (hasPendingPrefill) return null;
  if (!selectedCollection) return null;
  if (!stored || !stored.pipelineText) return null;
  return {
    collection: selectedCollection,
    pipelineText: stored.pipelineText,
    variables: { ...(stored.variables || {}) },
    placeholderTypes: { ...(stored.placeholderTypes || {}) },
  };
}
