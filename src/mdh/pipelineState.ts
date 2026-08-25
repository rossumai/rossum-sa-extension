// Per-collection in-memory store for the Data panel's editable state.
// Persisted across tab switches (and within-session collection switches)
// so a user's custom pipeline / variables / pagination position survives
// when they jump to Stats or Indexes and come back.
//
// In-memory only — does NOT persist across page reloads. If session
// persistence is needed, swap the Map for chrome.storage.local.

const stateByCollection = new Map();

/** The Data panel's editable state for one collection. In-memory only. */
export type PipelineState = {
  pipelineText: string;
  variables: Record<string, unknown>;
  skip: number;
  /** Manual per-variable type overrides, restored with the query. */
  placeholderTypes?: Record<string, string | undefined>;
};

export function savePipelineState(collection: string | null, state: PipelineState): void {
  if (!collection) return;
  stateByCollection.set(collection, state);
}

export function getPipelineState(collection: string | null | undefined): PipelineState | null {
  if (!collection) return null;
  return stateByCollection.get(collection) || null;
}

// No production caller: this is the reset seam the tests use to clear the module-level
// Map between cases, like undo.js `_reset`.
export function clearAllPipelineState() {
  stateByCollection.clear();
}
