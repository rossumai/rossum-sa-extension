import { signal } from '@preact/signals';
import type { Turn } from './thread.js';

// Shared connection (set by the console shell before initFabry runs).
export const domain = signal('');
export const token = signal('');
export const connected = signal<boolean | null>(null); // null = booting; true/false after
export const agentAvailable = signal<boolean | null>(null); // null = probing; false = agent offline

// Sidebar (mirrors GET /chats — the server owns chat state; nothing persisted).
export const chats = signal<any[]>([]);
export const chatsTotal = signal<number | null>(null);
export const chatsLoading = signal(false);

// Open conversation.
export const activeChatId = signal<string | null>(null);
export const thread = signal<Turn[]>([]);
export const threadLoading = signal(false);
export const files = signal<any[]>([]); // FileInfo[] from ChatDetail
export const liveTurn = signal<any>(null); // streaming fold acc, or null
export const streaming = signal(false);

// Composer context.
export const commands = signal<any[]>([]); // from GET /commands ([] = hide autocomplete)
export const personaChoice = signal<'cautious' | 'default'>('cautious'); // applies to the NEXT new chat

// Fabry sub-app mode: 'chat' (existing chat app) | 'architect' (SOW checks).
// Per-tab navigation state (persisted via tabState in index.jsx), content-free.
export const fabryMode = signal<'chat' | 'architect'>('chat');
export function setFabryMode(m: string): void {
  fabryMode.value = m === 'architect' ? 'architect' : 'chat';
}

// Deep verify (spec 2026-07-11): per-session mode (never persisted), an
// always-on availability flag (the popup kill-switch was removed 2026-07-14 —
// deep-verify is ON by default), and the live phase indicator for the chips.
export const deepMode = signal(false);
export const deepVerifyAllowed = signal(true);
export const deepPhase = signal<{ phase: 'verify' | 'refine'; round: number } | null>(null);

// Architect implement surface availability — ON by default (its popup kill-switch
// was removed 2026-07-14). Kept as an enablement flag so the components can still
// gate on it (and tests can toggle it); no external control writes it in prod.
export const implementAllowed = signal(true);

// Errors: `error` is app-level (auth/offline); `sendError` is per-send, inline.
export const error = signal<string | null>(null);
export const sendError = signal<string | null>(null);

// Layout preference: sidebar width (drag-resize). Persisted globally (like
// mdhSidebarWidth) — a genuine preference, not per-tab navigation. The sidebar
// is always expanded (collapse was removed).
export function clampSidebarWidth(w: unknown): number {
  return Math.max(200, Math.min(420, Number(w) || 280));
}
export const sidebarWidth = signal(280);
export function setSidebarWidth(w: unknown): void {
  const width = clampSidebarWidth(w);
  sidebarWidth.value = width;
  try {
    chrome.storage.local.set({ fabrySidebarWidth: width });
  } catch {
    /* pref is best-effort */
  }
}

export function resetChatView(): void {
  activeChatId.value = null;
  thread.value = [];
  files.value = [];
  liveTurn.value = null;
  sendError.value = null;
}
