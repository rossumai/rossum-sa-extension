// src/mdh/store.js
import { signal } from '@preact/signals';

export const domain = signal('');
export const token = signal('');
// Organization id of the connected project (resolved at connect via
// api.getOrgId). null until resolved, or if the lookup failed.
export const orgId = signal(null);
export const collections = signal([]);
export const selectedCollection = signal(null);
export const records = signal([]);
export const skip = signal(0);
export const limit = signal(50);
export const activePanel = signal('data');
export const activeView = signal('collection');
export const loading = signal(false);
export const error = signal(null);
// Non-error operation notice (in-progress / inconclusive) shown as a top stripe.
// Shape: { message: string, kind: 'info' | 'warning' } | null
export const opNotice = signal(null);
export { modalContent } from '../ui/Modal.jsx'; // shared modal signal (see src/ui/Modal.jsx)
// Connection state for the Dataset Management app. null = not yet checked
// (shell shows a connecting state), true/false after the healthz probe. The
// shell passes this to <App connected={...}/>.
export const connected = signal(null);
// Rossum Agent API ("Mr. Fabry") reachable — set from probeAgent() (GET /health)
// at MDH init. false until proven → the AI query input stays hidden by default.
// (The AgentBox surface holds its own transient run state locally; each submit is
// a self-contained fresh chat, so no agent session state lives in the store.)
export const aiAvailable = signal(false);
export const statsSummary = signal(null); // { collection, health, label } | null
export const operations = signal([]);
export const operationsLoaded = signal(false);
export const pendingOperations = signal(null); // { ops, changedOps } | null
export const opsSearch = signal('');
export const undoToast = signal(null); // { id, message, action, ts, ttlMs, status, error } | null
// One-shot pipeline prefill consumed by DataPanel's [collection] effect: set by
// the popup's "Open in Dataset Management" button and by boot to restore the
// last remembered query. Cleared after the matching collection's effect applies it.
export const pendingPipelineLoad = signal(null); // { collection, pipelineText, variables?, placeholderTypes? } | null
// Field names sampled from the active collection on select (best-effort $sample).
// Primed in DataPanel's collection-change effect; cleared on switch.
export const sampledFields = signal([]);

// Bulk-op selection state. selectionMode toggles whether RecordCard renders
// checkboxes and whether the RecordList toolbar shows bulk actions instead
// of the default toolbar. selectedIds is a Map<stringKey, originalId> where
// the key is the stringified _id (record._id?.$oid || String(record._id)) for
// fast Set-like lookup, and the value is the original _id (e.g. { $oid: '...' }
// for ObjectId collections, or a plain string for user-supplied ids). The
// original wrapper must round-trip to the server unchanged so $in queries match.
export const selectionMode = signal(false);
export const selectedIds = signal(new Map());
// True once the user has edited the pipeline (sort/filter/$match/load) since
// entering selection mode. Drives the "selection may no longer match the
// current view" banner. Cleared on enter/exit selection, on collection switch,
// and after "View selected only" (which makes the pipeline match the selection
// exactly, so any prior drift is resolved).
export const selectionPipelineDirty = signal(false);

// Results-pane view mode: 'list' | 'table' | 'stages'. A signal (not RecordList
// local state) so the left Aggregate Pipeline Debug panel can switch the right
// pane to the Stages debug view. Persisted as `mdhResultsView`.
export const resultsView = signal('list');
// When a stage row in the debug panel is clicked, the Stages view scrolls to and
// briefly highlights that stage. `{ index }` (active-stage index, -1 = input) |
// null. A fresh object each click so the same stage can be re-targeted.
export const inspectTarget = signal(null);

// Hovered Stages-view stage → draws a connector line to that stage in the pipeline
// editor. `{ entryIndex, el }` (el = the hovered section element, re-measured on
// scroll) | null. Cleared on mouse-leave.
export const hoveredStage = signal(null);

// The stage the POINTER is over inside the pipeline editor — the same link
// again, driven from the editor's own text. `{ entryIndex }` | null. Like
// `caretStage` it carries no `el`; the overlay resolves the section from
// `[data-entry]`. Precedence is hoveredStage > editorHoverStage > caretStage:
// the two hovers are mutually exclusive in practice (one pointer), and either
// beats a resting caret.
export const editorHoverStage = signal(null);

// The stage the pipeline-editor CARET currently sits in — the same link, driven
// from the other end. `{ entryIndex }` | null; no `el`, because the caret knows
// nothing about the DOM, so the overlay resolves the section itself from
// `[data-entry]`. Cleared when the caret leaves every stage or the editor loses
// focus. `hoveredStage` takes precedence while the pointer is over a section: an
// active gesture beats a resting caret, and only one connector is ever drawn.
export const caretStage = signal(null);

// Stages-view options (persisted as mdhStagesAutoscroll / mdhStagesSampleSize).
// `stagesAutoscroll` toggles the automatic scroll-syncing between the pipeline
// editor and the Stages view (editor-follows-hover + Stages-follows-cursor); the
// explicit debug-panel click jump always works regardless. `stagesSampleSize` is
// how many sample records each stage shows (and fetches per stage). Defaults
// reproduce the prior behavior exactly (autoscroll on, 10 records).
export const STAGE_SAMPLE_SIZES = [10, 25, 50];
export const stagesAutoscroll = signal(true);
export const stagesSampleSize = signal(10);
// Whether the Stages view shows each active stage's substituted definition
// (the concrete stage object as sent to the Data Storage API) in a read-only
// block under the stage header. Opt-in — default OFF so the fixed-height stage
// sections keep their full sample-output space until the user asks for it.
// Persisted as mdhStagesShowDef, wired like mdhStagesAutoscroll in index.jsx.
export const stagesShowDef = signal(false);
// Whether the Stages view's SOURCE card (the collection before the pipeline
// runs — what used to render as "stage 0 / input") is expanded to show its
// sample records. Default false: the card is a dimmed, dashed, collapsed strip,
// so the numbered list visibly starts at stage 1 and the source reads as the
// thing the pipeline draws from rather than a step in it. Collapsed also means
// its sample is not fetched at all, saving one aggregate per Stages open — the
// document COUNT still shows, since that comes from the $collStats probe in
// useStageCounts, not from the sample. Persisted as mdhStagesSourceOpen, wired
// like mdhStagesShowDef in index.jsx.
export const stagesSourceOpen = signal(false);
// Coerce a stored/unknown value to one of the allowed sample sizes (default 10).
export function coerceStageSampleSize(v) {
  const n = typeof v === 'number' ? v : parseInt(v, 10);
  return STAGE_SAMPLE_SIZES.includes(n) ? n : 10;
}

// Suffix that namespaces per-org client state (saved/recent/last queries) so it
// isn't shared across projects. Prefers the org id; falls back to the origin so
// the data is still per-project (never global) if the org id is unavailable.
export function scopeSuffix() {
  return orgId.value != null ? `org:${orgId.value}` : `domain:${domain.value}`;
}
