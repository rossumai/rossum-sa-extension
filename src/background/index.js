// MV3 service worker. Two jobs: let a content script open the Dataset
// Management tab, and proxy "Annotate for me" Fabry turns over a long-lived
// port. A content script can't chrome.tabs.create an extension page, and
// opening console/console.html via window.open would require
// web_accessible_resources; doing it here (a privileged extension context)
// avoids that — same launch contract the popup uses (single-use
// consoleAuth_<uuid>, consumed + purged on boot). Likewise, a content script
// can't call the cross-origin Fabry host under MV3 CORS, so it opens an
// `annotate-fabry` port to the worker, which has the host permission.

import { runFabryTurn as realRunFabryTurn, AGENT_BASE } from './fabryProxy.js';

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

export function handleFabryPort(port, { extensionId, runFabryTurn }) {
  if (port.name !== 'annotate-fabry') return;
  if (!port.sender || port.sender.id !== extensionId) return; // only our own content scripts
  const ctrl = new AbortController();
  port.onDisconnect.addListener(() => ctrl.abort());
  port.onMessage.addListener(async (msg) => {
    if (!msg || msg.type !== 'start') return;
    try {
      const { chatId } = await runFabryTurn({
        fetchImpl: fetch, base: AGENT_BASE,
        headers: { 'X-Rossum-Token': msg.token, 'X-Rossum-Api-Url': `${msg.domain}/api/v1` },
        chatId: msg.chatId, content: msg.content, images: msg.images,
        onChunk: (text) => { try { port.postMessage({ type: 'chunk', text }); } catch { /* port closed */ } },
        signal: ctrl.signal,
      });
      try { port.postMessage({ type: 'done', chatId }); } catch { /* port closed */ }
    } catch (e) {
      try { port.postMessage({ type: 'error', message: e.message, status: e.status }); } catch { /* closed */ }
    }
  });
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

if (typeof chrome !== 'undefined' && chrome.runtime?.onConnect) {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'annotate-fabry') return;
    handleFabryPort(port, { extensionId: chrome.runtime.id, runFabryTurn: realRunFabryTurn });
  });
}
