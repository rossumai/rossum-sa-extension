// The only usage-reporting API feature code sees. Fire-and-forget by
// construction: never awaited, never throws, always returns undefined — a fault
// must not alter, delay or break a feature. The service worker validates the
// name and params and may drop the event (e.g. when consent is absent).
const sentOnce = new Set();

// Cached consent, so a user who declined does not pay a service-worker wake plus
// a storage read for every instrumented action. The worker remains the
// authority; this is purely a short-circuit. `null` means "not known yet", in
// which case we still send and let the worker decide — dropping those would lose
// the first events of a consenting user.
let consentKnown = null;
try {
  if (typeof chrome !== 'undefined') {
    const get = chrome.storage?.local?.get;
    if (get) {
      Promise.resolve(chrome.storage.local.get(['usageConsent']))
        .then((v) => { consentKnown = v?.usageConsent === true; })
        .catch(() => {});
    }
    chrome.storage?.onChanged?.addListener?.((changes, area) => {
      if (area === 'local' && changes && changes.usageConsent) {
        consentKnown = changes.usageConsent.newValue === true;
      }
    });
  }
} catch {
  // A context without storage access — fall back to always messaging the worker.
}

export function track(name, params) {
  if (consentKnown === false) return undefined;
  try {
    const msg = { type: 'sa-usage', name };
    if (params) msg.params = params;
    const p = chrome.runtime.sendMessage(msg);
    // No receiver (worker asleep mid-teardown, page closing) rejects; ignore.
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    // chrome.runtime missing, or this context is being torn down.
  }
  return undefined;
}

// For features driven by the MutationObserver: they act per DOM node, so this
// collapses a whole page's activity into one event. The set lives for the
// content script instance, i.e. one page load.
export function trackOnce(name, params) {
  if (sentOnce.has(name)) return undefined;
  sentOnce.add(name);
  return track(name, params);
}
