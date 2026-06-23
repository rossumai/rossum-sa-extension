import { h, Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import Toggle from './Toggle.jsx';
import MdhProvenancePanel from './MdhProvenancePanel.jsx';
import { openConsoleTab, runInTab, detectSite, findRossumTabs, activateTab } from '../utils.js';
import { readAuthInfo, readPageFlag, togglePageFlag } from '../tab-readers.js';

const STORAGE_TOGGLES = [
  'schemaAnnotationsEnabled',
  'resourceIdsEnabled',
  'expandFormulasEnabled',
  'expandReasoningFieldsEnabled',
  'scrollLockEnabled',
  'netsuiteFieldNamesEnabled',
  'coupaFieldNamesEnabled',
];

// Each id is both the React state key and the page-side localStorage key.
const PAGE_FLAG_TOGGLES = ['devFeaturesEnabled', 'devDebugEnabled'];

// Chrome Web Store "Support" tab for this extension. The item id matches the
// install link in README.md.
const SUPPORT_URL = 'https://chromewebstore.google.com/detail/bljkbinljmhdbipklfcljongikhmnneh/support';

function combineUrlWithCustomPath(originalUrl, customPath) {
  const match = originalUrl.match(/^https?:\/\/[^/?#]+/);
  if (!match) return originalUrl;
  const normalizedPath = customPath.startsWith('/') ? customPath : `/${customPath}`;
  return match[0] + normalizedPath;
}

function ExternalIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M7 17L17 7M17 7H7M17 7v10" />
    </svg>
  );
}

function ExternalIconSmall() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M7 17L17 7M17 7H7M17 7v10" />
    </svg>
  );
}

function hostFromUrl(url) {
  try { return new URL(url).host; } catch { return ''; }
}

function UnsupportedSite({ tabs }) {
  // tabs === null means we haven't queried yet — render the static fallback
  // immediately rather than showing a loading flicker; the list will reveal
  // when the query resolves.
  const hasTabs = Array.isArray(tabs) && tabs.length > 0;

  if (hasTabs) {
    return (
      <div class="unsupported-site">
        <p class="unsupported-lede">This tab isn't supported by the extension.</p>
        <p class="unsupported-heading">Switch to one of your open Rossum tabs:</p>
        <ul class="rossum-tab-list">
          {tabs.map((t) => (
            <li>
              <button class="rossum-tab-row" onClick={() => activateTab(t)} title={t.url}>
                {t.favIconUrl ? (
                  <img class="rossum-tab-favicon" src={t.favIconUrl} alt="" />
                ) : (
                  <span class="rossum-tab-favicon rossum-tab-favicon-placeholder" aria-hidden="true" />
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
      <p class="unsupported-lede">This tab isn't supported by the extension.</p>
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

export default function App({ tab }) {
  const site = detectSite(tab?.url || '');
  const version = chrome.runtime.getManifest().version_name || chrome.runtime.getManifest().version;

  const [storageValues, setStorageValues] = useState(null);
  const [messageValues, setMessageValues] = useState({ devFeaturesEnabled: false, devDebugEnabled: false });
  const [authError, setAuthError] = useState(null);
  const [rossumTabs, setRossumTabs] = useState(null);

  useEffect(() => {
    if (site) return;
    findRossumTabs().then(setRossumTabs);
  }, [site]);

  useEffect(() => {
    chrome.storage.local.get(STORAGE_TOGGLES).then((vals) => {
      const filled = {};
      for (const key of STORAGE_TOGGLES) filled[key] = !!vals[key];
      setStorageValues(filled);
    });
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

  const setStorageToggle = async (key, value) => {
    setStorageValues((prev) => ({ ...prev, [key]: value }));
    await chrome.storage.local.set({ [key]: value });
    chrome.tabs.reload(tab.id);
  };

  const setMessageToggle = async (key) => {
    const ok = await runInTab(tab.id, togglePageFlag, [key]);
    if (ok === true) {
      setMessageValues((prev) => ({ ...prev, [key]: !prev[key] }));
      chrome.tabs.reload(tab.id);
    }
  };

  const onMasterDataHub = () => {
    chrome.tabs.create({
      url: combineUrlWithCustomPath(tab.url, '/svc/master-data-hub/web/management'),
      index: tab.index + 1,
    });
  };

  const fetchAuthAndOpen = async (opener) => {
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

  const onRossumConsole = () => fetchAuthAndOpen((tab, auth) => openConsoleTab(tab, auth, 'mdh'));

  const onReloadTab = () => {
    chrome.tabs.reload(tab.id);
    window.close();
  };

  const dimClass = (ctx) => (site && site !== ctx ? ' dimmed' : '');

  if (storageValues === null) {
    // Avoid first-paint flicker before storage has resolved.
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

      {!site ? (
        <UnsupportedSite tabs={rossumTabs} />
      ) : (
        <div id="mainContent">
          <div class="content-row">
            {showMdhPanel ? (
              <div class="content-col content-col-mdh">
                <MdhProvenancePanel tab={tab} />
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
                    <span class="tool-notice-msg">
                      Sign in to Rossum in this tab first.
                    </span>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}

      <footer class="footer">
        <span class="version">{version}</span>
        <span class="footer-links">
          <a
            href={SUPPORT_URL}
            target="_blank"
            rel="noopener noreferrer"
            class="footer-link"
          >
            Support & feedback
            <ExternalIconSmall />
          </a>
          <a
            href="https://solutionarchitecthandbook.mrtnzlml.com/"
            target="_blank"
            class="footer-link"
          >
            SA Handbook
            <ExternalIconSmall />
          </a>
        </span>
      </footer>
    </Fragment>
  );
}
