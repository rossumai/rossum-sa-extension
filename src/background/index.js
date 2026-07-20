// MV3 service worker. One job: let a content script open the Dataset
// Management tab. A content script can't chrome.tabs.create an extension page,
// and opening console/console.html via window.open would require
// web_accessible_resources; doing it here (a privileged extension context)
// avoids that — same launch contract the popup uses (single-use
// consoleAuth_<uuid>, consumed + purged on boot).

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
