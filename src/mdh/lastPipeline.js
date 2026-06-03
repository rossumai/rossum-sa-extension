// Remembers the most recent Data-panel pipeline (editor text + placeholder
// variables) GLOBALLY so a full page reload doesn't lose the user's query.
// One entry — not per-collection — matching the "remember the last query"
// behavior. The in-memory pipelineState Map still handles within-session
// per-collection tab switches; this adds reload durability via
// chrome.storage.local.

export const LAST_PIPELINE_KEY = 'mdhLastPipeline';

// Persist the current editor text and placeholder variables. Best-effort: a
// storage hiccup must never break editing, so failures are swallowed.
export function saveLastPipeline(pipelineText, variables) {
  try {
    chrome.storage.local.set({
      [LAST_PIPELINE_KEY]: { pipelineText, variables: { ...(variables || {}) } },
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
