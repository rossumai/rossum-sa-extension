import { h, Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import Toggle from './Toggle.jsx';
import MdhProvenancePanel from './MdhProvenancePanel.jsx';
import ReviewingLockBanner from './ReviewingLockBanner.jsx';
import UsageStrip, { UsageFooterButton, stripVisible } from './UsageStrip.jsx';
import { track } from '../../usage/track.js';
import { writeConsent } from '../usageConsent.js';
import {
  openConsoleTab,
  runInTab,
  detectSite,
  findRossumTabs,
  activateTab,
  isConsoleTab,
} from '../utils.js';
import { readAuthInfo, readPageFlag, togglePageFlag } from '../tab-readers.js';
import { createUnlockCounter } from '../experimental.js';
import { openPanelForTab } from '../../sidepanel/panelScope.js';

const STORAGE_TOGGLES = [
  'schemaAnnotationsEnabled',
  'resourceIdsEnabled',
  'expandFormulasEnabled',
  'expandReasoningFieldsEnabled',
  'scrollLockEnabled',
  'netsuiteFieldNamesEnabled',
  'coupaFieldNamesEnabled',
  // Not a toggle shown anywhere: the hidden-features gate (5 clicks on the
  // version hash). Loaded with the rest so the click handler can toggle it.
  'experimentalUnlocked',
];

// Each id is both the React state key and the page-side localStorage key.
const PAGE_FLAG_TOGGLES = ['devFeaturesEnabled', 'devDebugEnabled'];

// Chrome Web Store "Support" tab for this extension. The item id matches the
// install link in README.md.
const SUPPORT_URL =
  'https://chromewebstore.google.com/detail/bljkbinljmhdbipklfcljongikhmnneh/support';

function combineUrlWithCustomPath(originalUrl: any, customPath: any) {
  const match = originalUrl.match(/^https?:\/\/[^/?#]+/);
  if (!match) return originalUrl;
  const normalizedPath = customPath.startsWith('/') ? customPath : `/${customPath}`;
  return match[0] + normalizedPath;
}

function ExternalIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M7 17L17 7M17 7H7M17 7v10" />
    </svg>
  );
}

function ExternalIconSmall() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M7 17L17 7M17 7H7M17 7v10" />
    </svg>
  );
}

function hostFromUrl(url: any) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export function UnsupportedSite({ tabs, isConsole }: { tabs?: any[] | null; isConsole?: boolean }) {
  // tabs === null means we haven't queried yet — render the static fallback
  // immediately rather than showing a loading flicker; the list will reveal
  // when the query resolves.
  const hasTabs = Array.isArray(tabs) && tabs.length > 0;

  if (hasTabs) {
    return (
      <div class="unsupported-site">
        <p class="unsupported-lede">
          {isConsole
            ? "You're on the Rossum Console."
            : "This tab isn't supported by the extension."}
        </p>
        <p class="unsupported-heading">Switch to one of your open Rossum tabs:</p>
        <ul class="rossum-tab-list">
          {tabs.map((t) => (
            <li>
              <button class="rossum-tab-row" onClick={() => activateTab(t)} title={t.url}>
                {t.favIconUrl ? (
                  <img class="rossum-tab-favicon" src={t.favIconUrl} alt="" />
                ) : (
                  <span
                    class="rossum-tab-favicon rossum-tab-favicon-placeholder"
                    aria-hidden="true"
                  />
                )}
                <span class="rossum-tab-text">
                  <span class="rossum-tab-title">{t.title || hostFromUrl(t.url)}</span>
                  <span class="rossum-tab-host">{hostFromUrl(t.url)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <p class="unsupported-footnote">Also works on NetSuite and Coupa.</p>
      </div>
    );
  }

  return (
    <div class="unsupported-site">
      <p class="unsupported-lede">
        {isConsole ? "You're on the Rossum Console." : "This tab isn't supported by the extension."}
      </p>
      <p>It works on:</p>
      <div class="supported-sites">
        <span class="supported-site">Rossum</span>
        <span class="supported-site">NetSuite</span>
        <span class="supported-site">Coupa</span>
      </div>
      <p class="unsupported-footnote">Open one of these sites to get started.</p>
    </div>
  );
}

export default function App({ tab }: { tab?: any }) {
  const site = detectSite(tab?.url || '');
  const isConsole = !site && isConsoleTab(tab?.url || '');
  const version = chrome.runtime.getManifest().version_name || chrome.runtime.getManifest().version;

  const [storageValues, setStorageValues] = useState<any>(null);
  const [messageValues, setMessageValues] = useState<Record<string, any>>({
    devFeaturesEnabled: false,
    devDebugEnabled: false,
  });
  const [authError, setAuthError] = useState<{ kind: string } | null>(null);
  const [rossumTabs, setRossumTabs] = useState<any>(null);
  const [unlockNotice, setUnlockNotice] = useState<string | null>(null);
  const [unlockCounter] = useState(() => createUnlockCounter());
  // Read on its own, NOT via STORAGE_TOGGLES: that loop coerces with !!, which
  // would turn "never answered" into "declined" for every existing install.
  // Three-valued, plus `undefined` for "storage hasn't resolved yet".
  const [consent, setConsent] = useState<boolean | null | undefined>(undefined);
  // Has the overlay ever been shown? Separate from consent so the ask appears
  // exactly ONCE; `undefined` until storage resolves, which is what keeps the
  // overlay from flashing on every popup open.
  const [asked, setAsked] = useState<boolean | undefined>(undefined);
  // Reopened-from-the-footer state. Never persisted: it is a view mode, not a
  // preference.
  const [reviewingUsage, setReviewingUsage] = useState(false);
  // Deliberately WITHOUT `reviewing`: this is "the first ask is on screen", not
  // "the surface is on screen". A footer reopen must not look like a fresh ask.
  const askOnScreen = stripVisible({ consent });

  // Persist "asked" only once the ask has actually PAINTED. Writing it in the
  // storage callback meant a popup dismissed within that tick consumed the single
  // automatic ask without ever showing it — and it never returns.
  //
  // Since 2026-08-19 this no longer gates the ask itself (the strip keys on
  // `consent`, so it persists until answered). It is kept because it is what
  // makes the footer control reachable, and its meaning — "the ask has been
  // shown" — is unchanged.
  // `asked === false` is load-bearing, not defensive: the strip stays on screen
  // for every open until it is answered, so without it this would re-write the
  // flag on each one. undefined = storage unresolved, true = already recorded.
  useEffect(() => {
    if (!askOnScreen || asked !== false) return;
    Promise.resolve(chrome.storage.local.set({ usageAsked: true })).catch(() => {});
  }, [askOnScreen, asked]);

  useEffect(() => {
    if (site) return;
    findRossumTabs().then(setRossumTabs);
  }, [site]);

  useEffect(() => {
    chrome.storage.local
      .get(STORAGE_TOGGLES)
      .then((vals) => {
        const filled: Record<string, boolean> = {};
        for (const key of STORAGE_TOGGLES) filled[key] = !!vals[key];
        setStorageValues(filled);
      })
      .catch(() => {
        // Also gates first paint — degrade to all-off rather than a blank popup.
        const filled: Record<string, boolean> = {};
        for (const key of STORAGE_TOGGLES) filled[key] = false;
        setStorageValues(filled);
      });
  }, []);

  useEffect(() => {
    chrome.storage.local
      .get(['usageConsent', 'usageAsked'])
      .then((vals) => {
        if (vals.usageConsent === true) setConsent(true);
        else if (vals.usageConsent === false) setConsent(false);
        else setConsent(null);
        setAsked(vals.usageAsked === true);
      })
      .catch(() => {
        // This read gates first paint, so a rejection must never leave the popup
        // blank: fall back to "not consented, don't ask" — the footer control is
        // still rendered, so usage data remains reachable.
        setConsent(null);
        setAsked(true);
      });
    track('sa_popup_open');
  }, []);

  useEffect(() => {
    if (!site) return;
    for (const key of PAGE_FLAG_TOGGLES) {
      runInTab(tab.id, readPageFlag, [key]).then((val) => {
        setMessageValues((prev) => ({ ...prev, [key]: !!val }));
      });
    }
  }, [site]);

  const showMdhPanel = site === 'rossum';
  useEffect(() => {
    document.body.classList.toggle('popup-wide', showMdhPanel);
  }, [showMdhPanel]);

  // Written straight to storage, NOT via the worker: the popup can be destroyed
  // immediately after this click, and a message needs the worker to wake first
  // (measured ~50ms, during which a reopened popup read "off").
  const onUsageAnswer = (value: any) => {
    setConsent(value);
    setAsked(true);
    setReviewingUsage(false);
    Promise.resolve(writeConsent(value)).catch(() => {});
  };

  const setStorageToggle = async (key: any, value: any) => {
    setStorageValues((prev: any) => ({ ...prev, [key]: value }));
    await chrome.storage.local.set({ [key]: value });
    chrome.tabs.reload(tab.id);
  };

  // 5 quick clicks on the version hash flip the extension's one hidden-features
  // gate, mirrored live into the Console via chrome.storage.onChanged — no tab
  // reload needed. It hides exactly one thing today: the Academy, badged EXP on
  // the Console rail and reachable only from there. Mr. Fabry is public and no
  // longer sits behind this. Until 2026-08-11 this wrote a second key,
  // `trainingUnlocked`, in the same call; that key is retired.
  const onVersionClick = async () => {
    if (!unlockCounter.click() || !storageValues) return;
    const next = !storageValues.experimentalUnlocked;
    setStorageValues((prev: any) => ({ ...prev, experimentalUnlocked: next }));
    // Written straight to storage, never via the worker — same cold-start
    // race as the usage-consent write above.
    await chrome.storage.local.set({ experimentalUnlocked: next });
    if (next) track('sa_popup_experimental_unlock');
    setUnlockNotice(next ? 'Experimental features unlocked' : 'Experimental features hidden');
    setTimeout(() => setUnlockNotice(null), 2500);
  };

  const setMessageToggle = async (key: any) => {
    // togglePageFlag returns the flag's NEW value. Using it (rather than the
    // locally cached messageValues, which starts false and is filled by a slow
    // executeScript round-trip) keeps the reported direction authoritative and
    // the local state in step with the page.
    const next = await runInTab(tab.id, togglePageFlag, [key]);
    if (typeof next === 'boolean') {
      setMessageValues((prev) => ({ ...prev, [key]: next }));
      chrome.tabs.reload(tab.id);
    }
  };

  const onMasterDataHub = () => {
    chrome.tabs.create({
      url: combineUrlWithCustomPath(tab.url, '/svc/master-data-hub/web/management'),
      index: tab.index + 1,
    });
  };

  const fetchAuthAndOpen = async (opener: any) => {
    setAuthError(null);
    // executeScript runs in the popup's (always-live) extension context, so it
    // survives extension upgrades that orphan content scripts. A null result
    // means the host permission failed or the tab is gone.
    const auth = await runInTab(tab.id, readAuthInfo);
    if (!auth) {
      setAuthError({ kind: 'reload' });
      return;
    }
    if (!auth.token || !auth.domain) {
      setAuthError({ kind: 'login' });
      return;
    }
    opener(tab, auth);
  };

  const onRossumConsole = () =>
    fetchAuthAndOpen((tab: any, auth: any) => openConsoleTab(tab, auth, 'mdh'));

  // Chrome cannot keep a popup open on blur — no API prevents it — so the pin
  // hands the same MDH card to a side panel, which survives clicking and
  // scrolling the page. Opened per TAB, not per window, so the panel stays
  // scoped to Rossum tabs (see src/sidepanel/panelScope.js). open() MUST run
  // inside this click: it is the user gesture Chrome requires. Feature-detected,
  // so a pre-114 Chrome (no chrome.sidePanel) never sees the button.
  const canPinSidePanel = !!chrome.sidePanel?.open;
  const onPinSidePanel = async () => {
    try {
      await openPanelForTab(tab.id, chrome.sidePanel);
      window.close();
    } catch {
      // Gesture refused or the API is unavailable — leave the popup open.
    }
  };

  const onReloadTab = () => {
    chrome.tabs.reload(tab.id);
    window.close();
  };

  const dimClass = (ctx: any) => (site && site !== ctx ? ' dimmed' : '');

  if (storageValues === null || consent === undefined || asked === undefined) {
    // Avoid first-paint flicker before storage has resolved — including consent
    // and the asked flag, so the overlay can never appear to someone who has
    // already seen it.
    return null;
  }

  return (
    <Fragment>
      <div class="accent-bar"></div>

      <header class="header">
        <div class="brand-badge">SA</div>
        <span class="brand-name">Rossum SA</span>
        {site ? (
          <div class="header-actions">
            <button
              class={`mdh-btn${dimClass('rossum')}`}
              onClick={onMasterDataHub}
              title="Open Master Data Hub"
            >
              <span>Master Data Hub</span>
              <ExternalIconSmall />
            </button>
            <button class="console-btn" onClick={onRossumConsole}>
              <span>Rossum Console</span>
              <ExternalIcon />
            </button>
          </div>
        ) : null}
      </header>

      {/* The first ask, IN FLOW rather than over the popup — it blocks nothing,
          so it stays until answered instead of being spent on one showing. Sits
          outside the site branch below for the same reason the overlay used to:
          it must reach people whose current tab isn't Rossum/NetSuite/Coupa. */}
      <UsageStrip consent={consent} reviewing={reviewingUsage} onAnswer={onUsageAnswer} />

      {!site ? (
        <UnsupportedSite tabs={rossumTabs} isConsole={isConsole} />
      ) : (
        <div id="mainContent">
          <div class="content-row">
            {showMdhPanel ? (
              <div class="content-col content-col-mdh">
                <MdhProvenancePanel
                  tab={tab}
                  onPin={canPinSidePanel ? onPinSidePanel : undefined}
                />
              </div>
            ) : null}

            <div class="content-col content-col-toggles">
              <section class={`card${dimClass('rossum')}`} data-context="rossum">
                <h3 class="section-title">Rossum</h3>

                <div class="toggle-group">
                  <span class="group-label">Overlays</span>
                  <Toggle
                    id="schemaAnnotationsEnabled"
                    label="Schema IDs"
                    hint="Overlay schema_id on annotation fields"
                    checked={storageValues.schemaAnnotationsEnabled}
                    onChange={(v) => setStorageToggle('schemaAnnotationsEnabled', v)}
                  />
                  <Toggle
                    id="resourceIdsEnabled"
                    label="Resource IDs"
                    hint="Overlay IDs on queues, hooks, extensions, users"
                    checked={storageValues.resourceIdsEnabled}
                    onChange={(v) => setStorageToggle('resourceIdsEnabled', v)}
                  />
                </div>

                <div class="toggle-group">
                  <span class="group-label">Behavior</span>
                  <Toggle
                    id="expandFormulasEnabled"
                    label="Expand formulas"
                    hint="Auto-open formula source code"
                    checked={storageValues.expandFormulasEnabled}
                    onChange={(v) => setStorageToggle('expandFormulasEnabled', v)}
                  />
                  <Toggle
                    id="expandReasoningFieldsEnabled"
                    label="Expand reasoning"
                    hint="Auto-open reasoning field options"
                    checked={storageValues.expandReasoningFieldsEnabled}
                    onChange={(v) => setStorageToggle('expandReasoningFieldsEnabled', v)}
                  />
                  <Toggle
                    id="scrollLockEnabled"
                    label="Sidebar scroll lock"
                    hint="Keep annotation sidebar scroll position"
                    checked={storageValues.scrollLockEnabled}
                    onChange={(v) => setStorageToggle('scrollLockEnabled', v)}
                  />
                </div>

                <div class="toggle-group toggle-group--cols-2">
                  <span class="group-label">Developer</span>
                  <Toggle
                    id="devFeaturesEnabled"
                    label="Dev features"
                    hint="devFeaturesEnabled"
                    checked={messageValues.devFeaturesEnabled}
                    onChange={() => setMessageToggle('devFeaturesEnabled')}
                  />
                  <Toggle
                    id="devDebugEnabled"
                    label="Dev debug"
                    hint="devDebugEnabled"
                    checked={messageValues.devDebugEnabled}
                    onChange={() => setMessageToggle('devDebugEnabled')}
                  />
                </div>
              </section>

              <div class="card-row">
                <section class={`card${dimClass('netsuite')}`} data-context="netsuite">
                  <h3 class="section-title">NetSuite</h3>
                  <Toggle
                    id="netsuiteFieldNamesEnabled"
                    label="Field names"
                    hint="Show field IDs on form labels"
                    checked={storageValues.netsuiteFieldNamesEnabled}
                    onChange={(v) => setStorageToggle('netsuiteFieldNamesEnabled', v)}
                  />
                </section>

                <section class={`card${dimClass('coupa')}`} data-context="coupa">
                  <h3 class="section-title">
                    Coupa <span class="beta-badge">beta</span>
                  </h3>
                  <Toggle
                    id="coupaFieldNamesEnabled"
                    label="Field names"
                    hint="Show API names on form labels"
                    checked={storageValues.coupaFieldNamesEnabled}
                    onChange={(v) => setStorageToggle('coupaFieldNamesEnabled', v)}
                  />
                </section>
              </div>

              {authError ? (
                <div class={`tool-notice${dimClass('rossum')}`} role="alert">
                  {authError.kind === 'reload' ? (
                    <Fragment>
                      <span class="tool-notice-msg">
                        Reload the Rossum tab — the extension was updated and lost its connection.
                      </span>
                      <button class="tool-notice-action" onClick={onReloadTab}>
                        Reload tab
                      </button>
                    </Fragment>
                  ) : (
                    <span class="tool-notice-msg">Sign in to Rossum in this tab first.</span>
                  )}
                </div>
              ) : null}
            </div>
          </div>
          {site === 'rossum' ? <ReviewingLockBanner tab={tab} /> : null}
        </div>
      )}

      <footer class="footer">
        {/* Version hash with the usage-data control beside it, rather than a
            third item floating in the middle of the footer. */}
        <div class="footer-left">
          <span class="version" onClick={onVersionClick}>
            {version}
          </span>
          <UsageFooterButton
            asked={asked}
            consent={consent}
            onToggle={() => setReviewingUsage((v) => !v)}
          />
        </div>
        {unlockNotice ? <span class="unlock-notice">{unlockNotice}</span> : null}
        <a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer" class="footer-link">
          Support & feedback
          <ExternalIconSmall />
        </a>
      </footer>
    </Fragment>
  );
}
