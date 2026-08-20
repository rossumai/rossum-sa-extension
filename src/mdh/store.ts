// src/mdh/store.js
import { signal } from '@preact/signals';
import { visibleCollections } from './hiddenCollections.js';

export const domain = signal('');
export const token = signal('');
// Organization id of the connected project (resolved at connect via
// api.getOrgId). null until resolved, or if the lookup failed.
export const orgId = signal<string | null>(null);
export const collections = signal<string[]>([]);
// The collection list EXACTLY as Data Storage returned it. `collections` above is the
// filtered, sorted view the UI renders — this extension's own collections are hidden from
// Dataset Management (owner, 2026-08-18; see hiddenCollections.js). Kept separate so the
// expandable group costs no refetch, and so the group's header can say how many there are.
export const rawCollections = signal<string[]>([]);
// This extension's own collections, kept OUT of `collections` and listed separately in an
// expandable group under it (owner, 2026-08-18) rather than merged in on reveal. Sorted the
// same way; a member is selectable exactly like any other collection once the group is open.
export const hiddenCollections = signal<string[]>([]);
// Whether that group is expanded. Global pref, persisted as `mdhShowHiddenCollections`
// (hydrated in index.jsx like the Stages options). Collapsed by default.
export const showHiddenCollections = signal(false);

// The single place the split is applied, so the sidebar, the Overview table and the
// prefetcher can never disagree about what exists. Mirrors loadCollections' own
// normalization: sort naturally, then drop a selection that no longer EXISTS.
export function applyCollectionFilter() {
  const all = [...(rawCollections.value || [])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const visible = visibleCollections(all, false);
  collections.value = visible;
  hiddenCollections.value = all.filter((n) => !visible.includes(n));
  // Existence, not visibility, is the test: a hidden collection can be selected from the
  // expanded group, and clearing it just because it sits below the fold would silently
  // deselect what the user is looking at.
  if (selectedCollection.value && !all.includes(selectedCollection.value)) {
    selectedCollection.value = null;
  }
  // A restored per-tab selection may BE one of ours (mdhSelectedCollection survives a
  // reload). Open the group so the highlight is visible rather than hidden below a collapsed
  // header — deliberately without persisting, so it does not overwrite the user's preference.
  if (selectedCollection.value && hiddenCollections.value.includes(selectedCollection.value)) {
    showHiddenCollections.value = true;
  }
  return visible;
}
export const selectedCollection = signal<string | null>(null);
export const records = signal<any[]>([]);
export const skip = signal(0);
export const limit = signal(50);
export const activePanel = signal<string>('data');
export const activeView = signal<string>('collection');
export const loading = signal(false);
// Only `message` is ever set or read (ErrorBanner renders it, CollectionEmptyState tests
// for presence) — the banner is a message, not a structured error.
export const error = signal<{ message: string } | null>(null);
// Non-error operation notice (in-progress / inconclusive) shown as a top stripe.
// Shape: { message: string, kind: 'info' | 'warning' } | null
export const opNotice = signal<{ message: string; kind: 'info' | 'warning' } | null>(null);
export { modalContent } from '../ui/Modal.jsx'; // shared modal signal (see src/ui/Modal.jsx)
// Connection state for the Dataset Management app. null = not yet checked
// (shell shows a connecting state), true/false after the healthz probe. The
// shell passes this to <App connected={...}/>.
export const connected = signal<boolean | null>(null);
// Rossum Agent API ("Mr. Fabry") reachable — set from probeAgent() (GET /health)
// at MDH init. false until proven → the AI query input stays hidden by default.
// (The AgentBox surface holds its own transient run state locally; each submit is
// a self-contained fresh chat, so no agent session state lives in the store.)
export const aiAvailable = signal(false);
export const statsSummary = signal<any>(null); // { collection, health, label } | null
export const operations = signal<any[]>([]);
export const operationsLoaded = signal(false);
export const pendingOperations = signal<any>(null); // { ops, changedOps } | null
export const opsSearch = signal('');
export type UndoToast = {
  id: number;
  message: string;
  action: () => unknown;
  ts: number;
  ttlMs: number;
  status: 'pending' | 'running' | 'done' | 'error';
  error: string | null;
};
export const undoToast = signal<UndoToast | null>(null);
// One-shot pipeline prefill consumed by DataPanel's [collection] effect: set by
// the popup's "Open in Dataset Management" button and by boot to restore the
// last remembered query. Cleared after the matching collection's effect applies it.
export const pendingPipelineLoad = signal<any>(null); // { collection, pipelineText, variables?, placeholderTypes? } | null
// Field names sampled from the active collection on select (best-effort $sample).
// Primed in DataPanel's collection-change effect; cleared on switch.
export const sampledFields = signal<string[]>([]);

// Bulk-op selection state. selectionMode toggles whether RecordCard renders
// checkboxes and whether the RecordList toolbar shows bulk actions instead
// of the default toolbar. selectedIds is a Map<stringKey, originalId> where
// the key is the stringified _id (record._id?.$oid || String(record._id)) for
// fast Set-like lookup, and the value is the original _id (e.g. { $oid: '...' }
// for ObjectId collections, or a plain string for user-supplied ids). The
// original wrapper must round-trip to the server unchanged so $in queries match.
export const selectionMode = signal(false);
export const selectedIds = signal<Map<string, any>>(new Map());
// True once the user has edited the pipeline (sort/filter/$match/load) since
// entering selection mode. Drives the "selection may no longer match the
// current view" banner. Cleared on enter/exit selection, on collection switch,
// and after "View selected only" (which makes the pipeline match the selection
// exactly, so any prior drift is resolved).
export const selectionPipelineDirty = signal(false);

// Results-pane view mode: 'list' | 'table' | 'stages'. A signal (not RecordList
// local state) so the left Aggregate Pipeline Debug panel can switch the right
// pane to the Stages debug view. Persisted as `mdhResultsView`.
export const resultsView = signal<'list' | 'table' | 'stages'>('list');
// When a stage row in the debug panel is clicked, the Stages view scrolls to and
// briefly highlights that stage. `{ index }` (active-stage index, -1 = input) |
// null. A fresh object each click so the same stage can be re-targeted.
export const inspectTarget = signal<{ index: number } | null>(null);

// Hovered Stages-view stage → draws a connector line to that stage in the pipeline
// editor. `{ entryIndex, el }` (el = the hovered section element, re-measured on
// scroll) | null. Cleared on mouse-leave.
export const hoveredStage = signal<{ entryIndex: number; el: HTMLElement | null } | null>(null);

// The stage the POINTER is over inside the pipeline editor — the same link
// again, driven from the editor's own text. `{ entryIndex }` | null. Like
// `caretStage` it carries no `el`; the overlay resolves the section from
// `[data-entry]`. Precedence is hoveredStage > editorHoverStage > caretStage:
// the two hovers are mutually exclusive in practice (one pointer), and either
// beats a resting caret. Marks the section; never scrolls to it (it did until
// 2026-08-14 — see StageLinkOverlay).
export const editorHoverStage = signal<{ entryIndex: number } | null>(null);

// The stage the pipeline-editor CARET currently sits in — the same link, driven
// from the other end. `{ entryIndex }` | null; no `el`, because the caret knows
// nothing about the DOM, so the overlay resolves the section itself from
// `[data-entry]`. Cleared when the caret leaves every stage or the editor loses
// focus. `hoveredStage` takes precedence while the pointer is over a section: an
// active gesture beats a resting caret, and only one connector is ever drawn.
export const caretStage = signal<{ entryIndex: number } | null>(null);

// Stages-view options (persisted as mdhStagesAutoscroll / mdhStagesSampleSize).
// `stagesAutoscroll` gates ONE automatic scroll: hovering a Stages section
// scrolls the pipeline editor to that stage. It used to gate a second one in the
// opposite direction (the pane following the editor's pointer and caret), which
// was removed 2026-08-14 — the text editor must not move the right pane — so the
// option now governs the editor's movement only. The explicit debug-panel click
// jump still works regardless, gated by nothing. `stagesSampleSize` is
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
export function coerceStageSampleSize(v: unknown): number {
  const n = typeof v === 'number' ? v : parseInt(v as string, 10);
  return STAGE_SAMPLE_SIZES.includes(n) ? n : 10;
}

// Suffix that namespaces per-org client state (saved/recent/last queries) so it
// isn't shared across projects. Prefers the org id; falls back to the origin so
// the data is still per-project (never global) if the org id is unavailable.
export function scopeSuffix() {
  return orgId.value != null ? `org:${orgId.value}` : `domain:${domain.value}`;
}
