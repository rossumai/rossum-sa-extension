// Shared helpers used by the popup root and MDH provenance panel.

// Single source of truth for which URLs the Rossum content script targets.
// Mirrors the host_permissions / content_scripts entries in manifest.json.
export const ROSSUM_URL_RE = /^https?:\/\/(?:localhost:3000|[^/]+\.rossum\.(?:ai|app)|[^/]+\.r8\.lol)(?:[/?#]|$)/;

// Returns one of 'rossum' | 'netsuite' | 'coupa' | null for the given URL.
export function detectSite(url) {
  if (!url) return null;
  if (ROSSUM_URL_RE.test(url)) return 'rossum';
  if (/^https?:\/\/[^/]+\.netsuite\.com\/app(?:[/?#]|$)/.test(url)) return 'netsuite';
  if (/^https?:\/\/[^/]+\.coupa(?:cloud|host)\.com(?:[/?#]|$)/.test(url)) return 'coupa';
  return null;
}

// Returns Rossum tabs across all windows, most-recently-accessed first.
// Tabs without a visible URL (no host permission, redacted) are filtered out.
export async function findRossumTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    return tabs
      .filter((t) => t.url && ROSSUM_URL_RE.test(t.url))
      .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  } catch {
    return [];
  }
}

// Activates the given tab, focuses its window, and closes the popup. Errors
// (tab closed mid-click, window gone) are swallowed so the popup always closes.
export async function activateTab(tab) {
  try {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    // ignore
  }
  window.close();
}

// Runs `func(...args)` in the target tab's main world via chrome.scripting and
// resolves to its return value. Always runs in the live extension context, so
// it survives extension upgrades that orphan content scripts. Returns null on
// any failure (no host permission, tab closed, function threw).
export async function runInTab(tabId, func, args = []) {
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId }, func, args });
    return results?.[0]?.result ?? null;
  } catch {
    return null;
  }
}

// Stages the auth payload under a single-use consoleAuth_<uuid> key (carrying
// the initial app), then opens the unified console page pointing at it. The
// console reads consoleAuth_<uuid> on boot and consumes it; pending* pipeline
// prefill fields ride along inside authData. Cleaned up by the console's
// purgeStaleAuthEntries on subsequent boots.
export function openConsoleTab(tab, authData, app) {
  const authId = crypto.randomUUID();
  chrome.storage.local.set(
    { [`consoleAuth_${authId}`]: { ...authData, app, createdAt: Date.now() } },
    () => {
      chrome.tabs.create({
        url: chrome.runtime.getURL(`console/console.html?authId=${authId}`),
        index: tab.index + 1,
      });
    },
  );
}
