import { effect } from '@preact/signals';
import * as agentApi from '../agent/agentApi.js';
import * as store from './store.js';
import * as architectStore from './architect/store.js';
import { loadChats, openChat } from './chat.js';
import { resolveTabState, writeTabState } from '../console/tabState.js';

let wired = false;

export async function initFabry() {
  // Sidebar width preference hydrates independently of agent availability.
  try {
    const pref = await chrome.storage.local.get(['fabrySidebarWidth']);
    if (pref.fabrySidebarWidth) store.sidebarWidth.value = store.clampSidebarWidth(pref.fabrySidebarWidth);
  } catch { /* pref is best-effort */ }

  try {
    const modePref = await chrome.storage.local.get(['fabryMode', 'fabryArchitectActive']);
    const savedMode = resolveTabState(['fabryMode'], modePref).fabryMode;
    if (savedMode === 'architect') store.fabryMode.value = 'architect';
    // Remember the open deliverable across a refresh (per-tab). Set before the
    // persist effect wires so the effect doesn't clobber it; ArchitectApp shows
    // the editor once loadArchitect populates the matching deliverable.
    const savedActive = resolveTabState(['fabryArchitectActive'], modePref).fabryArchitectActive;
    if (savedActive && typeof savedActive === 'string') architectStore.activeId.value = savedActive;
  } catch { /* restore is best-effort */ }

  store.agentAvailable.value = await agentApi.probeAgent();
  if (!store.agentAvailable.value) return;

  agentApi.listCommands().then((cmds) => { store.commands.value = cmds; });
  await loadChats();

  // Per-tab restore of the open conversation (id only — content stays server-side).
  try {
    const stored = await chrome.storage.local.get('fabryActiveChat');
    const saved = resolveTabState(['fabryActiveChat'], stored).fabryActiveChat;
    if (saved && typeof saved === 'string') openChat(saved, { restore: true }).catch(() => {});
  } catch { /* restore is best-effort */ }

  if (!wired) {
    wired = true;
    effect(() => { writeTabState('fabryActiveChat', store.activeChatId.value); });
    effect(() => { writeTabState('fabryMode', store.fabryMode.value); });
    effect(() => { writeTabState('fabryArchitectActive', architectStore.activeId.value); });
    effect(() => { if (!store.deepVerifyAllowed.value) store.deepMode.value = false; });
  }
}
