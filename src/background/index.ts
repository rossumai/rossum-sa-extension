import { collect } from '../usage/collect.js';
import { panelOptionsFor, panelUpdateFor } from '../sidepanel/panelScope.js';

// MV3 service worker. Three jobs.
//
// (1) Let a content script open the Dataset Management tab. A content script can't chrome.tabs.create an extension page,
// and opening console/console.html via window.open would require
// web_accessible_resources; doing it here (a privileged extension context)
// avoids that — same launch contract the popup uses (single-use
// consoleAuth_<uuid>, consumed + purged on boot).
//
// (2) Be the ONLY sender of opt-in usage counts. Every other surface just
// messages us; the consent gate, the client id and the single GA4 fetch all
// live in src/usage/collect.js so there is one place to audit. Spec:
// docs/superpowers/specs/2026-08-03-feature-usage-measurement-design.md.
//
// (3) Keep the side panel scoped to Rossum tabs. Only a privileged context that
// outlives every page can do this: the decision has to be re-made whenever any
// tab navigates, including while no panel and no popup is open.

export function openDatasetManagement(
  msg: { token: string; domain: string; openerTab?: chrome.tabs.Tab },
  deps: typeof realDeps,
) {
  const { storageSet, tabsCreate, getURL, uuid, now } = deps;
  const authId = uuid();
  const opts: chrome.tabs.CreateProperties = { url: getURL(`console/console.html?authId=${authId}`) };
  // Open right next to the tab the request came from (same window).
  const opener = msg.openerTab;
  if (opener && typeof opener.index === 'number') {
    opts.index = opener.index + 1;
    opts.windowId = opener.windowId;
  }
  storageSet(
    { [`consoleAuth_${authId}`]: { token: msg.token, domain: msg.domain, app: 'mdh', createdAt: now() } },
    () => tabsCreate(opts),
  );
  return authId;
}

// Bring every existing tab in line, then set the global default. Order matters:
// switching the default off FIRST would momentarily close a panel already open
// on a Rossum tab whose per-tab option has not been written yet (worker restart).
export async function syncSidePanelTabs(
  deps: {
    queryTabs: () => Promise<chrome.tabs.Tab[]>;
    setOptions: (opts: any) => unknown;
  },
) {
  const { queryTabs, setOptions } = deps;
  const tabs = await queryTabs();
  // Issued together (they are independent) and all awaited before the default is
  // switched off, which also keeps the half-applied window as short as possible.
  await Promise.all(
    tabs
      .filter((tab) => typeof tab?.id === 'number')
      .map((tab) => setOptions(panelOptionsFor(tab.id!, tab.url))),
  );
  await setOptions({ enabled: false });
}

const realDeps = {
  storageSet: (obj: Record<string, unknown>, cb: () => void) => chrome.storage.local.set(obj, cb),
  tabsCreate: (opts: chrome.tabs.CreateProperties) => chrome.tabs.create(opts),
  getURL: (p: string) => chrome.runtime.getURL(p),
  uuid: () => crypto.randomUUID(),
  now: () => Date.now(),
};

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.type !== 'openDatasetManagement') return;
    // Only honor messages from our own extension's content scripts.
    if (sender.id !== chrome.runtime.id) return;
    // sender.tab positions the new tab right next to the requesting tab.
    openDatasetManagement({ ...msg, openerTab: sender.tab }, realDeps);
  });
}

// Side-panel scoping. Runs on every worker wake (cheap: one tabs.query), and
// re-decides for a tab whenever its URL changes — the only moment the answer can
// change. Guarded on chrome.sidePanel so a pre-114 Chrome just skips it.
if (typeof chrome !== 'undefined' && chrome.sidePanel?.setOptions) {
  const panelDeps = {
    queryTabs: () => chrome.tabs.query({}),
    setOptions: (opts: any) => chrome.sidePanel.setOptions(opts),
  };
  syncSidePanelTabs(panelDeps).catch(() => {});
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const options = panelUpdateFor(tabId, changeInfo, tab);
    if (!options) return;
    // A closed/discarded tab rejects; nothing to do about it.
    chrome.sidePanel.setOptions(options).catch(() => {});
  });
}

// Usage counting (opt-in, off by default). A separate listener so the Dataset
// Management path above stays byte-identical.
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Only this extension's own contexts may emit events.
    if (sender.id !== chrome.runtime.id) return undefined;
    if (msg?.type !== 'sa-usage') return undefined;
    // `return true` keeps the message channel open, which keeps this worker
    // alive until the fetch settles. Returning undefined closed the port
    // immediately and let Chrome terminate the worker mid-send.
    collect(msg)
      .catch(() => {})
      .then(() => { try { sendResponse(); } catch { /* receiver gone */ } });
    return true;
  });
}
