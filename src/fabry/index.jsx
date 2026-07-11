import { effect } from '@preact/signals';
import * as agentApi from '../agent/agentApi.js';
import * as store from './store.js';
import { loadChats, openChat } from './chat.js';
import { resolveTabState, writeTabState } from '../console/tabState.js';

let wired = false;

export async function initFabry() {
  // Sidebar preferences hydrate independently of agent availability.
  try {
    const pref = await chrome.storage.local.get(['fabrySidebarOpen', 'fabrySidebarWidth']);
    if (pref.fabrySidebarOpen === false) store.sidebarOpen.value = false;
    if (pref.fabrySidebarWidth) store.sidebarWidth.value = store.clampSidebarWidth(pref.fabrySidebarWidth);
  } catch { /* pref is best-effort */ }

  store.agentAvailable.value = await agentApi.probeAgent();
  if (!store.agentAvailable.value) return;

  agentApi.listCommands().then((cmds) => { store.commands.value = cmds; });
  await loadChats();

  // Per-tab restore of the open conversation (id only — content stays server-side).
  try {
    const stored = await chrome.storage.local.get('fabryActiveChat');
    const saved = resolveTabState(['fabryActiveChat'], stored).fabryActiveChat;
    if (saved && typeof saved === 'string') openChat(saved).catch(() => {});
  } catch { /* restore is best-effort */ }

  if (!wired) {
    wired = true;
    effect(() => { writeTabState('fabryActiveChat', store.activeChatId.value); });
    effect(() => { if (!store.deepVerifyAllowed.value) store.deepMode.value = false; });
  }
}
