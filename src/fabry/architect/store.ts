import { signal } from '@preact/signals';

// Deliverables (Markdown docs) + their last check results live server-side in
// Data Storage. Only content-free navigation is persisted in the browser:
// fabryMode + activeId (the open deliverable id, per-tab via fabryArchitectActive
// so it survives a page refresh — see src/fabry/index.jsx).
import { createArchitectAssetStore } from './assetApi.js';
import type { Deliverable } from './collectionPlan.js';
import type { CheckResult, ImplementState } from './api.js';

export const deliverables = signal<Deliverable[]>([]);
export const activeId = signal<string | null>(null); // open deliverable id, or null
export const loaded = signal(false);
export const loadError = signal<string | null>(null);
export const running = signal(false);
export const results = signal<Record<string, CheckResult>>({});
export function setResult(id: string, result: CheckResult) {
  results.value = { ...results.value, [id]: result };
}
export function clearResults() {
  results.value = {};
}
export function setActive(id: string | null) {
  activeId.value = id;
}

// --- Implement loop (ralph-style) state (spec 2026-07-14-architect-implement-loop) ---
// implement[id] = { status:'idle'|'running'|'passing'|'failed'|'blocked', attempt,
//   writes:[{tool,argsSummary,ok,at}], summary, chatId, journal, running, error }
export const implementRunning = signal(false);
export const implement = signal<Record<string, Partial<ImplementState> & Record<string, any>>>({});
export function setImplement(id: string, patch: Record<string, any>) {
  implement.value = { ...implement.value, [id]: { ...(implement.value[id] || {}), ...patch } };
}
export function clearImplement(id: string) {
  const rest = { ...implement.value };
  delete rest[id];
  implement.value = rest;
}

// The bottom action console was removed with the deliverable pane (2026-08-19); its height pref
// (`fabryArchConsoleHeight`) is orphaned in storage and read by nothing.

// ── Document view: Edit | Preview ──────────────────────────────────────────────
// How the specification's text renders — and only that: the switch changes neither the
// chrome around it nor which deliverables are shown. It began as a WebStorm-style
// three-way switch over one deliverable's pane (the localpages port, spec 2026-08-17 §5);
// the combined "Editor and Preview" mode went with that pane on 2026-08-19, since the
// unified view already shows every deliverable at once (a stored 'split' migrates to
// 'preview' below).
//
// A global preference, persisted like the widths above, and deliberately NOT reset when the
// reader moves between deliverables: a mode somebody chose should outlive that.
export const DOC_VIEWS = ['edit', 'preview'];
// Reading is the default, and that is not a preference: Cmd+F only reaches the whole specification in
// Preview (spec 2026-08-19 F5 — a live CodeMirror renders 52 of 600 lines).
export type DocView = 'edit' | 'preview';
export const docView = signal<DocView>('preview');

// A profile written by an older build can hold 'split'. It maps to 'preview' rather than being
// ignored, so the reader lands in a mode that still exists. An older build reading 'edit' or
// 'preview' understands both, so the pref degrades in BOTH directions.
export function migrateDocView(stored: unknown): DocView {
  if (stored === 'edit' || stored === 'preview') return stored;
  return 'preview';
}
export function setDocView(mode: string) {
  if (!DOC_VIEWS.includes(mode)) return;
  docView.value = mode as DocView;
  try {
    chrome.storage?.local?.set({ fabryArchDocView: mode });
  } catch {
    /* no storage (tests) */
  }
}

// ── Unified view layout + targeting (2026-08-19) ───────────────────────────────
// The inspector collapses; the deliverable list does NOT (owner, 2026-08-19 — it is the navigation,
// and navigation that can disappear is a trap). Measured at a 1280px window: the reading column is
// 646px with the inspector open and 906px without it.
export const railOpen = signal(true);
// Drag-resizable inspector (owner). Clamped so it can neither vanish nor crowd out the document;
// live signal during the drag, persisted once on release — the sidebarWidth / consoleHeight pattern.
export const RAIL_MIN = 260;
export const RAIL_MAX = 620;
export const railWidth = signal(322);
export function clampRailWidth(px: unknown): number {
  const n = Number(px);
  if (!Number.isFinite(n)) return 322;
  return Math.max(RAIL_MIN, Math.min(RAIL_MAX, Math.round(n)));
}
function persistBool(key: string, sig: { value: boolean }) {
  return (v: boolean) => {
    sig.value = !!v;
    try {
      chrome.storage?.local?.set({ [key]: !!v });
    } catch {
      /* no storage (tests) */
    }
  };
}
export const setRailOpen = persistBool('fabryArchRailOpen', railOpen);
export function setRailWidth(px: unknown) {
  const w = clampRailWidth(px);
  railWidth.value = w;
  try {
    chrome.storage?.local?.set({ fabryArchRailWidth: w });
  } catch {
    /* no storage (tests) */
  }
}

// What the rail is showing. `spyTarget` is what the scroll says, `pinnedTarget` an explicit lock;
// specTarget.railTarget reconciles them and holds the target while a check runs. Neither persists —
// which paragraph you are reading is not worth carrying between sessions.
export const spyTarget = signal<string | null>(null);
export const pinnedTarget = signal<string | null>(null);
export function setSpyTarget(id: string | null) {
  if (spyTarget.value !== id) spyTarget.value = id;
}

// What the INSPECTOR follows, which is deliberately not the same signal.
//
// `spyTarget` changes as fast as the reader scrolls and drives cheap things (the list highlight). The
// rail is the expensive consumer — switching it remounts a panel and re-parses the check evidence as
// markdown — so it follows a target that SETTLES: measured, a 60-frame scroll produced 44 DOM
// mutations inside the rail, i.e. work on nearly every frame for a panel nobody can read mid-flight.
export const RAIL_SETTLE_MS = 120;
export const settledTarget = signal<string | null>(null);
let settleTimer: ReturnType<typeof setTimeout> | null = null;
export function setSettledTarget(
  id: string | null,
  { immediate = false }: { immediate?: boolean } = {},
) {
  if (settleTimer) {
    clearTimeout(settleTimer);
    settleTimer = null;
  }
  if (immediate || settledTarget.value === null) {
    settledTarget.value = id;
    return;
  }
  if (settledTarget.value === id) return;
  settleTimer = setTimeout(() => {
    settleTimer = null;
    settledTarget.value = id;
  }, RAIL_SETTLE_MS);
}
export function setPinnedTarget(id: string | null) {
  pinnedTarget.value = id || null;
}

// A diff the reader asked to see at document width instead of in the 322px rail:
// { id, kind: 'refine' | 'history' } | null. In-memory only.
export const reviewTarget = signal<any>(null);
export function setReviewTarget(v: any) {
  reviewTarget.value = v || null;
}

// ── Sidebar outline (the document's headings, nested under the active deliverable) ──
// Owner, 2026-08-18: the TOC moved from inside the document to the sidebar, where there is
// always room — upstream's in-page `.toc` needs a 1280px column and the pane is ~936px at a
// 1280px window, so it was hidden in practice.
//
// In-memory only: which heading you are looking at is not worth persisting, and it changes
// on every scroll.
export const activeHeading = signal<string | null>(null);
export function setActiveHeading(slug: string | null) {
  if (activeHeading.value !== slug) activeHeading.value = slug;
}

// The open deliverable's pane registers how to reach a heading; the sidebar calls it. A
// callback rather than a signal because the same slug may be clicked twice in a row, and a
// signal would need a nonce to re-fire.
let outlineNavigator: ((slug: string | null | undefined, docId?: string) => void) | null = null;
export function setOutlineNavigator(fn: unknown) {
  outlineNavigator = (typeof fn === 'function' ? fn : null) as typeof outlineNavigator;
}
// `docId` is optional and only matters in the unified view, where two deliverables can own the same
// heading slug: it tells the navigator which section to resolve the slug inside.
export function navigateOutline(slug: string | null | undefined, docId?: string) {
  if (outlineNavigator) outlineNavigator(slug, docId);
}

// Every persisted preference in this file, in ONE list, because `chrome.storage.local.get([keys])`
// returns only the keys it was asked for — a read of an unrequested key is silently `undefined`, and
// that is exactly how the inspector's width came to be written but never restored (owner report,
// 2026-08-19). `tests/fabry-architect-store-view.test.js` asserts this list covers every key the
// module writes, so the next preference cannot regress the same way.
export const PREF_KEYS = [
  'fabryArchDocView',
  'fabryArchRailOpen',
  'fabryArchRailWidth',
  'fabryArchPdfOptions',
];

// ── PDF options ────────────────────────────────────────────────────────────────
// What a printed specification includes. Configurable and REMEMBERED (owner, 2026-08-18:
// "consider making this configurable"), so the dialog asks the scope every time but never
// re-asks the same preferences. Content-free, so it persists like the layout prefs above.
// `states` was dropped 2026-08-19 with the manual state; a stored value keeps the key and this
// key-by-key read simply ignores it.
export type PdfOptions = { contents: boolean; verdicts: boolean };
export const PDF_KEYS: (keyof PdfOptions)[] = ['contents', 'verdicts'];
export const pdfOptions = signal<PdfOptions>({ contents: true, verdicts: false });
export function setPdfOptions(next: Partial<PdfOptions>) {
  const clean = {} as PdfOptions;
  for (const k of PDF_KEYS) clean[k] = !!next[k];
  pdfOptions.value = clean;
  try {
    chrome.storage?.local?.set({ fabryArchPdfOptions: clean });
  } catch {
    /* no storage (tests) */
  }
}

try {
  chrome.storage?.local
    ?.get(PREF_KEYS)
    .then((v) => {
      docView.value = migrateDocView(v && v.fabryArchDocView);
      if (v && typeof v.fabryArchRailOpen === 'boolean') railOpen.value = v.fabryArchRailOpen;
      if (v && typeof v.fabryArchRailWidth === 'number')
        railWidth.value = clampRailWidth(v.fabryArchRailWidth);
      if (v && v.fabryArchPdfOptions && typeof v.fabryArchPdfOptions === 'object') {
        const stored = v.fabryArchPdfOptions as Partial<PdfOptions>;
        const clean = { ...pdfOptions.value };
        // Read key by key: a value written by a newer build must not introduce unknown keys,
        // and one written by an older build must keep this build's defaults for what it lacks.
        for (const k of PDF_KEYS)
          if (typeof stored[k] === 'boolean') clean[k] = stored[k] as boolean;
        pdfOptions.value = clean;
      }
    })
    .catch(() => {});
} catch {
  /* no storage */
}

// ── Version history (2026-08-18) ───────────────────────────────────────────────
// Versions live server-side as kind:'revision' docs beside their deliverable, and are
// fetched only when the History tab asks for them. Nothing here is persisted in the
// browser: deliverable text has never touched chrome.storage and a version is just older
// deliverable text.
export const revisions = signal<Record<string, any>>({}); // { [deliverableId]: { loading, items, error } }
export const revisionTexts = signal<Record<string, string>>({}); // { [revisionId]: text } — in-memory cache
export const selectedRevision = signal<any>(null);

export function setRevisions(deliverableId: string, patch: Record<string, any>) {
  revisions.value = {
    ...revisions.value,
    [deliverableId]: { ...(revisions.value[deliverableId] || {}), ...patch },
  };
}
export function cacheRevisionText(revisionId: string, text: string) {
  revisionTexts.value = { ...revisionTexts.value, [revisionId]: text };
}

// Set when this org still has deliverables under the legacy collection name — i.e. both
// collections exist, because an older build recreated the legacy one after we migrated
// (see collectionPlan.js). { count, collection } | null. Purely informational: both are
// read, and each deliverable is written back to wherever it lives.
export const legacyNotice = signal<any>(null);

// ── Assets (2026-08-24) ────────────────────────────────────────────────────────
// ONE instance for the whole Architect, shared by the document column (SpecView → DocView) and
// by the rail's Assets panel.
//
// It MUST be one: `pinned` is a single Set per store, replaced wholesale by whichever syncAssets
// pass ran last (assets.js, ruling 16). Two instances would each unpin what the other has
// painted, and the unbounded fetch/evict loop that ruling closed would come back through a new
// door. The byte cache is the second reason — two instances would fetch and hold every asset
// twice, against a budget each of them believes it owns.
export const assets = createArchitectAssetStore();
