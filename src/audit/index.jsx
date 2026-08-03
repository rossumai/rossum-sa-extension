import { effect } from '@preact/signals';
import * as api from './api.js';
import { track } from '../usage/track.js';
import * as store from './store.js';
import { activeApp } from '../console/store.js';
import { SOURCE_ORDER } from './sources/index.js';
import { fetchActive } from './query.js';
import * as agentApi from '../agent/agentApi.js';
import { runAuditQuery, continueAuditQuery, refreshAuditSummary, DEFAULT_QUESTION } from './fabry.js';

// Restore persisted per-source state, merging only known sources/keys over the
// defaults so a stale stored shape can't corrupt the store.
function restore(stored) {
  if (SOURCE_ORDER.includes(stored.auditActiveSource)) {
    store.activeSource.value = stored.auditActiveSource;
  }
  const saved = stored.auditFiltersBySource;
  if (saved && typeof saved === 'object') {
    const merged = { ...store.filtersBySource.value };
    for (const key of SOURCE_ORDER) {
      if (saved[key] && typeof saved[key] === 'object') {
        // Page size is fixed (no user control); always force it back to the default.
        merged[key] = { ...merged[key], ...saved[key], cursor: null, page: 1, pageSize: 100 };
      }
    }
    store.filtersBySource.value = merged;
  }
}

// Ship mode for Fabry's grounding. A live spike proved the Rossum Agent API
// has no audit-log tool, so 'autonomous' fetch-your-own-logs grounding is
// dead; we seed the currently-loaded rows into the prompt instead.
const FABRY_MODE = 'seeded';

let fabryController = null;
function currentFilters() { return store.filtersBySource.value[store.activeSource.value] || {}; }
function currentRows() { return store.rows.value || []; }

// Identity of the loaded view the summary describes: source + its filter
// fields + paging. Captured when a summary starts; a mismatch later = stale.
export function viewSignature() {
  const key = store.activeSource.value;
  const st = store.filtersBySource.value[key] || {};
  const { object_type, action, object_id, username, timestamp_after, timestamp_before, page, cursor } = st;
  return JSON.stringify([key, object_type, action, object_id, username, timestamp_after, timestamp_before, page, cursor]);
}

// Immutably patch the turn with the given id in store.fabry.
function patchTurn(id, fn) {
  const cur = store.fabry.value;
  const turns = cur.turns.map((t) => (t.id === id ? { ...t } : t));
  const target = turns.find((t) => t.id === id);
  if (target) fn(target);
  store.fabry.value = { ...cur, turns };
}

// Run the default "latest activity" summary (turn 0). Auto-triggered by
// initAudit's effect once the agent is reachable and rows have loaded;
// FabryPanel's toggle keeps an idle fallback. Its first line doubles as the
// collapsed-bar preview. No-ops unless the agent is available and the
// conversation is idle.
export async function runDefaultSummary() {
  if (!store.aiAvailable.value) return;
  if (store.fabry.value.status !== 'idle') return;
  if (fabryController) fabryController.abort();
  fabryController = new AbortController();
  const signal = fabryController.signal;
  const forView = viewSignature();
  store.fabry.value = { status: 'running', chatId: null, error: null, forView: null,
    turns: [{ id: 1, question: null, text: '', reasoning: '', tools: [], state: 'streaming' }] };
  try {
    const res = await runAuditQuery({
      agentApi, question: DEFAULT_QUESTION, filters: currentFilters(), rows: currentRows(), mode: FABRY_MODE, signal,
      onText: (t) => { if (!signal.aborted) patchTurn(1, (turn) => { turn.text = t; }); },
    });
    if (signal.aborted) return;
    store.fabry.value = { status: 'done', chatId: res.chatId, error: null, forView,
      turns: [{ id: 1, question: null, text: res.text, reasoning: res.reasoning, tools: res.tools, state: 'done' }] };
  } catch (e) {
    if (signal.aborted || e?.name === 'AbortError') return;
    patchTurn(1, (turn) => { turn.state = 'error'; });
    store.fabry.value = { ...store.fabry.value, status: 'error', error: e?.message || 'failed', forView: null };
  }
}

// Ask a question. Continues the session chat if one exists; otherwise (default
// summary failed / was cleared) starts a fresh chat. Appends one Q&A turn.
export async function askAuditFabry(question) {
  const q = String(question || '').trim();
  if (!q) return;
  track('sa_audit_fabry_ask');
  const cur = store.fabry.value;
  if (cur.turns.some((t) => t.state === 'streaming')) return; // one at a time
  if (fabryController) fabryController.abort();
  fabryController = new AbortController();
  const signal = fabryController.signal;
  const id = (cur.turns[cur.turns.length - 1]?.id || 0) + 1;
  store.fabry.value = { ...cur, status: 'running',
    turns: [...cur.turns, { id, question: q, text: '', reasoning: '', tools: [], state: 'streaming' }] };
  const onText = (t) => { if (!signal.aborted) patchTurn(id, (turn) => { turn.text = t; }); };
  try {
    const hasChat = !!cur.chatId;
    const res = hasChat
      ? await continueAuditQuery({ agentApi, chatId: cur.chatId, question: q, signal, onText })
      : await runAuditQuery({ agentApi, question: q, filters: currentFilters(), rows: currentRows(), mode: FABRY_MODE, signal, onText });
    if (signal.aborted) return;
    patchTurn(id, (turn) => { turn.text = res.text; turn.reasoning = res.reasoning; turn.tools = res.tools; turn.state = 'done'; });
    const next = { ...store.fabry.value, status: 'done' };
    if (!hasChat && res.chatId) next.chatId = res.chatId;
    store.fabry.value = next;
  } catch (e) {
    if (signal.aborted || e?.name === 'AbortError') return;
    patchTurn(id, (turn) => { turn.state = 'error'; });
    store.fabry.value = { ...store.fabry.value, status: 'error', error: e?.message || 'failed' };
  }
}

// Re-summarize the CURRENT view as a new turn in the same chat (new rows
// re-seeded). Called when the summary is stale: on expand, or automatically
// while the panel is open once the new rows have landed. Falls back to a
// fresh chat when none exists.
export async function refreshSummary() {
  if (!store.aiAvailable.value) return;
  if (store.availability.value !== 'available') return; // rows not landed yet — never seed the old page
  const cur = store.fabry.value;
  if (cur.turns.some((t) => t.state === 'streaming')) return; // one at a time
  if (!cur.chatId) { store.resetFabry(); return runDefaultSummary(); }
  if (fabryController) fabryController.abort();
  fabryController = new AbortController();
  const signal = fabryController.signal;
  const forView = viewSignature();
  const id = (cur.turns[cur.turns.length - 1]?.id || 0) + 1;
  store.fabry.value = { ...cur, status: 'running',
    turns: [...cur.turns, { id, question: null, text: '', reasoning: '', tools: [], state: 'streaming' }] };
  try {
    const res = await refreshAuditSummary({
      agentApi, chatId: cur.chatId, filters: currentFilters(), rows: currentRows(), signal,
      onText: (t) => { if (!signal.aborted) patchTurn(id, (turn) => { turn.text = t; }); },
    });
    if (signal.aborted) return;
    patchTurn(id, (turn) => { turn.text = res.text; turn.reasoning = res.reasoning; turn.tools = res.tools; turn.state = 'done'; });
    // Clear any prior give-up marker — this view now has a good summary.
    store.fabry.value = { ...store.fabry.value, status: 'done', forView, refreshFailedFor: null };
  } catch (e) {
    if (signal.aborted || e?.name === 'AbortError') return;
    patchTurn(id, (turn) => { turn.state = 'error'; });
    // Mark this exact view signature as already attempted so the panel's
    // auto-refresh effect gives up on it (see store.js) instead of re-firing
    // on every render — an explicit expand still retries manually.
    store.fabry.value = { ...store.fabry.value, status: 'error', error: e?.message || 'failed', refreshFailedFor: forView };
  }
}

export async function initAudit() {
  const stored = await chrome.storage.local.get(['auditActiveSource', 'auditFiltersBySource']);
  restore(stored);

  let connected = false;
  try { await api.whoami(); connected = true; }
  catch (err) { connected = false; store.error.value = err.message || 'Failed to verify session'; }
  store.connected.value = connected;
  if (!connected) return;

  agentApi.probeAgent().then((ok) => {
    store.aiAvailable.value = ok;
  }).catch(() => {});

  // Eagerly generate the default summary once the agent is reachable AND the
  // first audit query has landed (rows loaded) — its takeaway line doubles as
  // the collapsed band's preview. Once per app activation; runDefaultSummary
  // no-ops unless idle. Read BOTH signals unconditionally so the effect
  // subscribes to both regardless of evaluation order.
  let fabryKicked = false;
  effect(() => {
    const ai = store.aiAvailable.value;
    const avail = store.availability.value;
    if (ai && avail === 'available' && !fabryKicked) {
      fabryKicked = true;
      runDefaultSummary();
    }
  });

  effect(() => { chrome.storage.local.set({ auditActiveSource: store.activeSource.value }); });
  effect(() => { chrome.storage.local.set({ auditFiltersBySource: store.filtersBySource.value }); });

  let queryController = null;
  // sa_audit_search used to sit in runDefaultSummary, which initAudit auto-runs
  // once per app activation — so it counted opening the app (already covered by
  // sa_console_app_audit) and never a search. It now fires only when the source
  // or filters actually CHANGE, which is a real user action.
  let lastQuerySig = null;
  effect(() => {
    const _src = store.activeSource.value;
    const _f = store.filtersBySource.value;
    const _app = activeApp.value;
    if (activeApp.value !== 'audit') return;
    const sig = JSON.stringify([_src, _f]);
    if (lastQuerySig !== null && sig !== lastQuerySig) track('sa_audit_search');
    lastQuerySig = sig;
    if (queryController) queryController.abort();
    queryController = new AbortController();
    fetchActive({ signal: queryController.signal });
  });
}
