// On the legacy Master Data Hub web app (…/svc/master-data-hub/web/…) the
// extension offers a one-click jump into its enhanced Dataset Management. The
// content script already runs on *.rossum.app, so this just self-gates on the
// path and injects a non-blocking floating card pinned to the bottom-right — it
// never reserves layout space, so it doesn't shift the page or hide app controls
// under the fold. The "Open" button reads the
// session token from the page and asks the background worker to open the
// Dataset Management tab (the worker can chrome.tabs.create an extension page
// without web_accessible_resources — same as the popup). A × button dismisses
// the card for the rest of the browser session (remembered in sessionStorage, so
// it stays closed across reloads in the same tab and returns in a new session).

const STYLE_ID = 'rossum-sa-extension-dm-suggest-style';
const BANNER_ID = 'rossum-sa-extension-dm-suggest-banner';
const DISMISS_KEY = 'rossum-sa-extension-dm-suggest-dismissed';

export function isMdhWebApp(pathname) {
  return typeof pathname === 'string' && pathname.includes('/svc/master-data-hub/web/');
}

export function init(loc = (typeof window !== 'undefined' ? window.location : null)) {
  if (!loc || !isMdhWebApp(loc.pathname)) return;
  injectBanner();
}

function injectBanner() {
  if (document.getElementById(BANNER_ID)) return; // already shown this view
  // Respect a session dismissal (the × button). sessionStorage can throw in
  // sandboxed/blocked contexts; if so, fall through and show the card.
  try { if (window.sessionStorage.getItem(DISMISS_KEY)) return; } catch { /* ignore */ }

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
#${BANNER_ID} {
  position: fixed; bottom: 16px; right: 16px; z-index: 2147483646;
  display: flex; align-items: center; gap: 10px;
  max-width: min(480px, calc(100vw - 32px)); box-sizing: border-box;
  padding: 10px 12px;
  background: linear-gradient(90deg, #4270db, #5b8af0);
  color: #fff;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 12px; font-weight: 600; line-height: 1.35;
  border-radius: 10px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28);
}
#${BANNER_ID} .rossum-sa-extension-dm-msg { flex: 1; min-width: 0; }
#${BANNER_ID} .rossum-sa-extension-dm-open {
  flex-shrink: 0; background: #fff; color: #2b4eb8; border: none; border-radius: 6px;
  padding: 5px 10px; font: inherit; font-weight: 700; cursor: pointer;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
}
#${BANNER_ID} .rossum-sa-extension-dm-open:hover { background: #eef2ff; }
#${BANNER_ID} .rossum-sa-extension-dm-close {
  flex-shrink: 0; background: transparent; color: #fff; border: none;
  font-size: 17px; line-height: 1; cursor: pointer; padding: 0 2px; opacity: 0.8;
}
#${BANNER_ID} .rossum-sa-extension-dm-close:hover { opacity: 1; }`;
    (document.head || document.documentElement)?.appendChild(style);
  }

  const banner = document.createElement('div');
  banner.id = BANNER_ID;

  const msg = document.createElement('span');
  msg.className = 'rossum-sa-extension-dm-msg';
  // No innerHTML — keep it Trusted-Types-safe on strict CSP pages.
  msg.textContent = '✨ Rossum SA extension — open your data in the enhanced Dataset Management.';

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'rossum-sa-extension-dm-open';
  openBtn.textContent = 'Open Dataset Management';
  openBtn.addEventListener('click', () => {
    const token = window.localStorage.getItem('secureToken');
    const domain = window.location.origin;
    chrome.runtime.sendMessage({ type: 'openDatasetManagement', token, domain });
  });

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'rossum-sa-extension-dm-close';
  closeBtn.setAttribute('aria-label', 'Dismiss');
  closeBtn.title = 'Dismiss for this session';
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => {
    try { window.sessionStorage.setItem(DISMISS_KEY, '1'); } catch { /* ignore */ }
    banner.remove();
  });

  banner.appendChild(msg);
  banner.appendChild(openBtn);
  banner.appendChild(closeBtn);
  document.body.appendChild(banner);
}
