// Shared helpers used by the popup root and MDH provenance panel.

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

// Stages the auth payload under a single-use mdhAuth_<uuid> key, then opens
// the Dataset Management tab pointing at it. Persists across page reload via
// sessionStorage in mdh/index.jsx; cleaned up by purgeStaleAuthEntries on
// subsequent boots.
export function openMdhTab(tab, authData) {
  const authId = crypto.randomUUID();
  chrome.storage.local.set(
    { [`mdhAuth_${authId}`]: { ...authData, createdAt: Date.now() } },
    () => {
      chrome.tabs.create({
        url: chrome.runtime.getURL(`mdh/mdh.html?authId=${authId}`),
        index: tab.index + 1,
      });
    },
  );
}

// Same staging pattern for the Audit Logs SPA. The audit page reads
// auditAuth_<uuid> on boot and purges stale entries on subsequent loads.
export function openAuditTab(tab, authData) {
  const authId = crypto.randomUUID();
  chrome.storage.local.set(
    { [`auditAuth_${authId}`]: { ...authData, createdAt: Date.now() } },
    () => {
      chrome.tabs.create({
        url: chrome.runtime.getURL(`audit/audit.html?authId=${authId}`),
        index: tab.index + 1,
      });
    },
  );
}
