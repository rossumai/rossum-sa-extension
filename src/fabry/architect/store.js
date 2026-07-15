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

// Deliverable-pane action console (the bottom tabbed panel) — a FIXED height so it
// doesn't jump between tabs, drag-resizable via its top edge. Global layout pref,
// persisted in chrome.storage.local (fabryArchConsoleHeight).
export const CONSOLE_MIN = 140;
export const CONSOLE_MAX = 620;
export const consoleHeight = signal(260);
export function setConsoleHeight(px) {
  const h = Math.max(CONSOLE_MIN, Math.min(CONSOLE_MAX, Math.round(px)));
  consoleHeight.value = h;
  try { chrome.storage?.local?.set({ fabryArchConsoleHeight: h }); } catch { /* no storage (tests) */ }
}
try {
  chrome.storage?.local?.get('fabryArchConsoleHeight').then((v) => {
    const h = v && v.fabryArchConsoleHeight;
    if (typeof h === 'number') consoleHeight.value = Math.max(CONSOLE_MIN, Math.min(CONSOLE_MAX, h));
  }).catch(() => {});
} catch { /* no storage */ }
