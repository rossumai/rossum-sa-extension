// Open the specification (or one deliverable) as a print-ready page.
//
// Mirrors src/mdh/openCollectionTab.js: a PURE request builder plus injected deps, so the
// chrome/crypto surface is mockable and the interesting part is testable without a browser.
// The payload rides chrome.storage.SESSION rather than local — a printed specification is
// document content, and this port's standing rule is that deliverable text never lands at
// rest on disk.
export const PRINT_PREFIX = 'docPrint_';

// Pure + testable: the staging entry and the target URL for printing `html`.
export function buildPrintRequest(
  { html, title, uuid, now }: { html: string; title: string; uuid: string; now: number },
) {
  return {
    key: `${PRINT_PREFIX}${uuid}`,
    entry: { html, title, createdAt: now },
    url: `console/print.html?printId=${uuid}`,
  };
}

const realDeps = {
  uuid: () => crypto.randomUUID(),
  now: () => Date.now(),
  getURL: (p: string) => chrome.runtime.getURL(p),
  sessionSet: (obj: Record<string, unknown>) => chrome.storage.session.set(obj),
  getCurrentTab: () => chrome.tabs.getCurrent(),
  tabsCreate: (opts: chrome.tabs.CreateProperties) => chrome.tabs.create(opts),
};

// Stage the document, then open the print page beside the current tab. The page consumes the
// key on read, so a stale entry cannot pile up; session storage is cleared with the browser
// session in any case.
export async function openPrintTab(
  { html, title }: { html: string; title: string },
  deps: typeof realDeps = realDeps,
) {
  if (!html) return null;
  const req = buildPrintRequest({ html, title, uuid: deps.uuid(), now: deps.now() });
  await deps.sessionSet({ [req.key]: req.entry });
  const opts: chrome.tabs.CreateProperties = { url: deps.getURL(req.url) };
  try {
    const cur = await deps.getCurrentTab();
    if (cur && typeof cur.index === 'number') {
      opts.index = cur.index + 1;
      opts.windowId = cur.windowId;
    }
  } catch { /* positioning is best-effort */ }
  await deps.tabsCreate(opts);
  return req.key;
}
