import { scopeSuffix } from './store.js';

// Per-organization key for the most recent Data-panel pipeline (editor text +
// placeholder variables): a reload restores the query and projects don't share
// it. scopeSuffix prefers the org id, falling back to the origin.
export function lastPipelineKey() {
  return `mdhLastPipeline::${scopeSuffix()}`;
}

// Persist the current editor text + placeholder variables. Best-effort: a
// storage hiccup must never break editing, so failures are swallowed.
export function saveLastPipeline(pipelineText, variables) {
  try {
    chrome.storage.local.set({
      [lastPipelineKey()]: { pipelineText, variables: { ...(variables || {}) } },
    });
  } catch { /* storage unavailable — non-fatal */ }
}

// Pure decision for the boot path: given the stored entry, the collection that
// was restored on boot, and whether a popup prefill already claimed the
// one-shot pendingPipelineLoad slot, return the value to restore (text +
// variables for that collection) or null.
export function bootPrefillFor(stored, selectedCollection, hasPendingPrefill) {
  if (hasPendingPrefill) return null;
  if (!selectedCollection) return null;
  if (!stored || !stored.pipelineText) return null;
  return {
    collection: selectedCollection,
    pipelineText: stored.pipelineText,
    variables: { ...(stored.variables || {}) },
  };
}
