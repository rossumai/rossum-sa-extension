import { signal } from '@preact/signals';

// Shared connection (set by the console shell before initFabry runs).
export const domain = signal('');
export const token = signal('');
export const connected = signal(null); // null = booting; true/false after
export const agentAvailable = signal(null); // null = probing; false = agent offline

// Sidebar (mirrors GET /chats — the server owns chat state; nothing persisted).
export const chats = signal([]);
export const chatsTotal = signal(null);
export const chatsLoading = signal(false);

// Open conversation.
export const activeChatId = signal(null);
export const thread = signal([]); // Turn[] (src/fabry/thread.js)
export const threadLoading = signal(false);
export const files = signal([]); // FileInfo[] from ChatDetail
export const liveTurn = signal(null); // streaming fold acc, or null
export const streaming = signal(false);

// Composer context.
export const commands = signal([]); // from GET /commands ([] = hide autocomplete)
export const personaChoice = signal('cautious'); // applies to the NEXT new chat

// Fabry sub-app mode: 'chat' (existing chat app) | 'architect' (SOW checks).
// Per-tab navigation state (persisted via tabState in index.jsx), content-free.
export const fabryMode = signal('chat');
export function setFabryMode(m) {
  fabryMode.value = m === 'architect' ? 'architect' : 'chat';
}

// Deep verify (spec 2026-07-11): per-session mode (never persisted), an
// always-on availability flag (the popup kill-switch was removed 2026-07-14 —
// deep-verify is ON by default), and the live phase indicator for the chips.
export const deepMode = signal(false);
export const deepVerifyAllowed = signal(true);
export const deepPhase = signal(null); // null | {phase: 'verify'|'refine', round}

// Architect implement surface availability — ON by default (its popup kill-switch
// was removed 2026-07-14). Kept as an enablement flag so the components can still
// gate on it (and tests can toggle it); no external control writes it in prod.
export const implementAllowed = signal(true);

// Errors: `error` is app-level (auth/offline); `sendError` is per-send, inline.
export const error = signal(null);
export const sendError = signal(null);

// Layout preference: sidebar width (drag-resize). Persisted globally (like
// mdhSidebarWidth) — a genuine preference, not per-tab navigation. The sidebar
// is always expanded (collapse was removed).
export function clampSidebarWidth(w) {
  return Math.max(200, Math.min(420, Number(w) || 280));
}
export const sidebarWidth = signal(280);
export function setSidebarWidth(w) {
  const width = clampSidebarWidth(w);
  sidebarWidth.value = width;
  try { chrome.storage.local.set({ fabrySidebarWidth: width }); } catch { /* pref is best-effort */ }
}

export function resetChatView() {
  activeChatId.value = null;
  thread.value = [];
  files.value = [];
  liveTurn.value = null;
  sendError.value = null;
}
