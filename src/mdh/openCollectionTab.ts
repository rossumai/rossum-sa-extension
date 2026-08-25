// src/mdh/openCollectionTab.ts
//
// Open an MDH collection in a NEW Console tab. Reuses the existing single-use
// consoleAuth_<uuid> staging + the `pendingCollection` boot override in initMdh,
// so the new tab opens focused on the collection and restores ITS last-used
// pipeline (mdhLastPipeline::<scope>::<collection>) via the normal boot path —
// no pipeline is staged here. The Console page is an extension-page context, so
// chrome.tabs.create works without the "tabs" permission (the popup does the
// same). deps are injected so the chrome/crypto surface is mockable in tests.
import { token, domain } from './store.js';

// Pure + testable: the staging entry and target URL for opening `collection`.
export function buildOpenTabRequest({
  token,
  domain,
  collection,
  uuid,
  now,
}: {
  token: string;
  domain: string;
  collection: string;
  uuid: string;
  now: number;
}) {
  return {
    authKey: `consoleAuth_${uuid}`,
    authEntry: { token, domain, app: 'mdh', pendingCollection: collection, createdAt: now },
    url: `console/console.html?authId=${uuid}`,
  };
}

const realDeps = {
  // Annotated `string`: randomUUID() is typed as a branded template literal, and a
  // `typeof realDeps` seam would otherwise demand that brand from a test stub.
  uuid: (): string => crypto.randomUUID(),
  now: () => Date.now(),
  getURL: (p: string) => chrome.runtime.getURL(p),
  storageSet: (obj: Record<string, unknown>) => chrome.storage.local.set(obj),
  // Only index and windowId are read (both guarded), so that is what the seam promises.
  getCurrentTab: (): Promise<{ index?: number; windowId?: number } | undefined> =>
    chrome.tabs.getCurrent(),
  tabsCreate: (opts: chrome.tabs.CreateProperties) => chrome.tabs.create(opts),
};

// Stage single-use auth carrying the target collection, then open a new Console
// tab next to the current one. No-op when not connected. Positioning is
// best-effort; the staged entry is consumed on boot (or swept by the 24h purge).
export async function openCollectionTab(collection: string, deps = realDeps): Promise<void> {
  if (!collection || !token.value || !domain.value) return;
  const req = buildOpenTabRequest({
    token: token.value,
    domain: domain.value,
    collection,
    uuid: deps.uuid(),
    now: deps.now(),
  });
  await deps.storageSet({ [req.authKey]: req.authEntry });
  const opts: chrome.tabs.CreateProperties = { url: deps.getURL(req.url) };
  try {
    const cur = await deps.getCurrentTab();
    if (cur && typeof cur.index === 'number') {
      opts.index = cur.index + 1;
      opts.windowId = cur.windowId;
    }
  } catch {
    /* positioning is optional */
  }
  deps.tabsCreate(opts);
}
