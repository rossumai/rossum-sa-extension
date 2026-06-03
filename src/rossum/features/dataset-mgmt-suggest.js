// On the legacy Master Data Hub web app (…/svc/master-data-hub/web/…) the
// extension offers a one-click jump into its enhanced Dataset Management. The
// content script already runs on *.rossum.app, so this just self-gates on the
// path and injects a non-blocking top banner. The "Open" button reads the
// session token from the page and asks the background worker to open the
// Dataset Management tab (the worker can chrome.tabs.create an extension page
// without web_accessible_resources — same as the popup).

const STYLE_ID = 'rossum-sa-extension-dm-suggest-style';
const BANNER_ID = 'rossum-sa-extension-dm-suggest-banner';

export function isMdhWebApp(pathname) {
  return typeof pathname === 'string' && pathname.includes('/svc/master-data-hub/web/');
}

export function init(loc = (typeof window !== 'undefined' ? window.location : null)) {
  if (!loc || !isMdhWebApp(loc.pathname)) return;
  injectBanner();
}

function injectBanner() {
  if (document.getElementById(BANNER_ID)) return; // already shown this view

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
#${BANNER_ID} {
  position: fixed; top: 0; left: 0; right: 0; z-index: 2147483646;
  display: flex; align-items: center; gap: 10px;
  padding: 6px 14px; box-sizing: border-box;
  background: linear-gradient(90deg, #4270db, #5b8af0);
  color: #fff;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 12px; font-weight: 600;
  border-bottom: 2px solid #2b4eb8;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.22);
}
#${BANNER_ID} .rossum-sa-extension-dm-msg { flex: 1; min-width: 0; }
#${BANNER_ID} .rossum-sa-extension-dm-open {
  flex-shrink: 0; background: #fff; color: #2b4eb8; border: none; border-radius: 4px;
  padding: 4px 10px; font: inherit; font-weight: 700; cursor: pointer;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
}
#${BANNER_ID} .rossum-sa-extension-dm-open:hover { background: #eef2ff; }`;
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

  banner.appendChild(msg);
  banner.appendChild(openBtn);
  document.body.appendChild(banner);

  // Shift the page down so the fixed banner doesn't cover the app's header.
  document.body.style.paddingTop = (banner.offsetHeight || 32) + 'px';
}
