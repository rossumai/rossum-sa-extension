import { collect } from '../usage/collect.js';

// MV3 service worker. Two jobs.
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

export function openDatasetManagement(msg, deps) {
  const { storageSet, tabsCreate, getURL, uuid, now } = deps;
  const authId = uuid();
  const opts = { url: getURL(`console/console.html?authId=${authId}`) };
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

const realDeps = {
  storageSet: (obj, cb) => chrome.storage.local.set(obj, cb),
  tabsCreate: (opts) => chrome.tabs.create(opts),
  getURL: (p) => chrome.runtime.getURL(p),
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
