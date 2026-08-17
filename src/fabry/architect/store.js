import { signal } from '@preact/signals';

// Deliverables (Markdown docs) + their last check results live server-side in
// Data Storage. Only content-free navigation is persisted in the browser:
// fabryMode + activeId (the open deliverable id, per-tab via fabryArchitectActive
// so it survives a page refresh — see src/fabry/index.jsx).
export const deliverables = signal([]); // {id, text, order}[]
export const activeId = signal(null);   // open deliverable id, or null
export const loaded = signal(false);
export const loadError = signal(null);
export const running = signal(false);
export const results = signal({}); // { [id]: Result }
export function setResult(id, result) { results.value = { ...results.value, [id]: result }; }
export function clearResults() { results.value = {}; }
export function setActive(id) { activeId.value = id; }

// --- Implement loop (ralph-style) state (spec 2026-07-14-architect-implement-loop) ---
// implement[id] = { status:'idle'|'running'|'passing'|'failed'|'blocked', attempt,
//   writes:[{tool,argsSummary,ok,at}], summary, chatId, journal, running, error }
export const implementRunning = signal(false);
export const implement = signal({});
export function setImplement(id, patch) {
  implement.value = { ...implement.value, [id]: { ...(implement.value[id] || {}), ...patch } };
}
export function clearImplement(id) { const rest = { ...implement.value }; delete rest[id]; implement.value = rest; }

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
export const docView = signal('preview');

// A profile written by an older build can hold 'split'. It maps to 'preview' rather than being
// ignored, so the reader lands in a mode that still exists. An older build reading 'edit' or
// 'preview' understands both, so the pref degrades in BOTH directions.
export function migrateDocView(stored) {
  if (stored === 'edit' || stored === 'preview') return stored;
  return 'preview';
}
export function setDocView(mode) {
  if (!DOC_VIEWS.includes(mode)) return;
  docView.value = mode;
  try { chrome.storage?.local?.set({ fabryArchDocView: mode }); } catch { /* no storage (tests) */ }
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
export function clampRailWidth(px) {
  const n = Number(px);
  if (!Number.isFinite(n)) return 322;
  return Math.max(RAIL_MIN, Math.min(RAIL_MAX, Math.round(n)));
}
function persistBool(key, sig) {
  return (v) => {
    sig.value = !!v;
    try { chrome.storage?.local?.set({ [key]: !!v }); } catch { /* no storage (tests) */ }
  };
}
export const setRailOpen = persistBool('fabryArchRailOpen', railOpen);
export function setRailWidth(px) {
  const w = clampRailWidth(px);
  railWidth.value = w;
  try { chrome.storage?.local?.set({ fabryArchRailWidth: w }); } catch { /* no storage (tests) */ }
}

// What the rail is showing. `spyTarget` is what the scroll says, `pinnedTarget` an explicit lock;
// specTarget.railTarget reconciles them and holds the target while a check runs. Neither persists —
// which paragraph you are reading is not worth carrying between sessions.
export const spyTarget = signal(null);
export const pinnedTarget = signal(null);
export function setSpyTarget(id) { if (spyTarget.value !== id) spyTarget.value = id; }

// What the INSPECTOR follows, which is deliberately not the same signal.
//
// `spyTarget` changes as fast as the reader scrolls and drives cheap things (the list highlight). The
// rail is the expensive consumer — switching it remounts a panel and re-parses the check evidence as
// markdown — so it follows a target that SETTLES: measured, a 60-frame scroll produced 44 DOM
// mutations inside the rail, i.e. work on nearly every frame for a panel nobody can read mid-flight.
export const RAIL_SETTLE_MS = 120;
export const settledTarget = signal(null);
let settleTimer = null;
export function setSettledTarget(id, { immediate = false } = {}) {
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
  if (immediate || settledTarget.value === null) { settledTarget.value = id; return; }
  if (settledTarget.value === id) return;
  settleTimer = setTimeout(() => { settleTimer = null; settledTarget.value = id; }, RAIL_SETTLE_MS);
}
export function setPinnedTarget(id) { pinnedTarget.value = id || null; }

// A diff the reader asked to see at document width instead of in the 322px rail:
// { id, kind: 'refine' | 'history' } | null. In-memory only.
export const reviewTarget = signal(null);
export function setReviewTarget(v) { reviewTarget.value = v || null; }

// ── Sidebar outline (the document's headings, nested under the active deliverable) ──
// Owner, 2026-08-18: the TOC moved from inside the document to the sidebar, where there is
// always room — upstream's in-page `.toc` needs a 1280px column and the pane is ~936px at a
// 1280px window, so it was hidden in practice.
//
// In-memory only: which heading you are looking at is not worth persisting, and it changes
// on every scroll.
export const activeHeading = signal(null);
export function setActiveHeading(slug) {
  if (activeHeading.value !== slug) activeHeading.value = slug;
}

// The open deliverable's pane registers how to reach a heading; the sidebar calls it. A
// callback rather than a signal because the same slug may be clicked twice in a row, and a
// signal would need a nonce to re-fire.
let outlineNavigator = null;
export function setOutlineNavigator(fn) { outlineNavigator = typeof fn === 'function' ? fn : null; }
// `docId` is optional and only matters in the unified view, where two deliverables can own the same
// heading slug: it tells the navigator which section to resolve the slug inside.
export function navigateOutline(slug, docId) { if (outlineNavigator) outlineNavigator(slug, docId); }

// Every persisted preference in this file, in ONE list, because `chrome.storage.local.get([keys])`
// returns only the keys it was asked for — a read of an unrequested key is silently `undefined`, and
// that is exactly how the inspector's width came to be written but never restored (owner report,
// 2026-08-19). `tests/fabry-architect-store-view.test.js` asserts this list covers every key the
// module writes, so the next preference cannot regress the same way.
export const PREF_KEYS = [
  'fabryArchDocView', 'fabryArchRailOpen', 'fabryArchRailWidth', 'fabryArchPdfOptions',
];

// ── PDF options ────────────────────────────────────────────────────────────────
// What a printed specification includes. Configurable and REMEMBERED (owner, 2026-08-18:
// "consider making this configurable"), so the dialog asks the scope every time but never
// re-asks the same preferences. Content-free, so it persists like the layout prefs above.
// `states` was dropped 2026-08-19 with the manual state; a stored value keeps the key and this
// key-by-key read simply ignores it.
export const PDF_KEYS = ['contents', 'verdicts'];
export const pdfOptions = signal({ contents: true, verdicts: false });
export function setPdfOptions(next) {
  const clean = {};
  for (const k of PDF_KEYS) clean[k] = !!next[k];
  pdfOptions.value = clean;
  try { chrome.storage?.local?.set({ fabryArchPdfOptions: clean }); } catch { /* no storage (tests) */ }
}

try {
  chrome.storage?.local?.get(PREF_KEYS).then((v) => {
    docView.value = migrateDocView(v && v.fabryArchDocView);
    if (v && typeof v.fabryArchRailOpen === 'boolean') railOpen.value = v.fabryArchRailOpen;
    if (v && typeof v.fabryArchRailWidth === 'number') railWidth.value = clampRailWidth(v.fabryArchRailWidth);
    if (v && v.fabryArchPdfOptions && typeof v.fabryArchPdfOptions === 'object') {
      const stored = v.fabryArchPdfOptions;
      const clean = { ...pdfOptions.value };
      // Read key by key: a value written by a newer build must not introduce unknown keys,
      // and one written by an older build must keep this build's defaults for what it lacks.
      for (const k of PDF_KEYS) if (typeof stored[k] === 'boolean') clean[k] = stored[k];
      pdfOptions.value = clean;
    }
  }).catch(() => {});
} catch { /* no storage */ }

// ── Version history (2026-08-18) ───────────────────────────────────────────────
// Versions live server-side as kind:'revision' docs beside their deliverable, and are
// fetched only when the History tab asks for them. Nothing here is persisted in the
// browser: deliverable text has never touched chrome.storage and a version is just older
// deliverable text.
export const revisions = signal({});        // { [deliverableId]: { loading, items, error } }
export const revisionTexts = signal({});    // { [revisionId]: text } — in-memory cache
export const selectedRevision = signal(null);

export function setRevisions(deliverableId, patch) {
  revisions.value = { ...revisions.value, [deliverableId]: { ...(revisions.value[deliverableId] || {}), ...patch } };
}
export function cacheRevisionText(revisionId, text) {
  revisionTexts.value = { ...revisionTexts.value, [revisionId]: text };
}

// Set when this org still has deliverables under the legacy collection name — i.e. both
// collections exist, because an older build recreated the legacy one after we migrated
// (see collectionPlan.js). { count, collection } | null. Purely informational: both are
// read, and each deliverable is written back to wherever it lives.
export const legacyNotice = signal(null);
