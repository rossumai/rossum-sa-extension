import { h, Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import Toggle from './Toggle.jsx';
import MdhProvenancePanel from './MdhProvenancePanel.jsx';
import { openMdhTab, openAuditTab, runInTab } from '../utils.js';
import { readAuthInfo, readPageFlag, togglePageFlag } from '../tab-readers.js';

const STORAGE_TOGGLES = [
  'schemaAnnotationsEnabled',
  'resourceIdsEnabled',
  'mdhProvenanceEnabled',
  'expandFormulasEnabled',
  'expandReasoningFieldsEnabled',
  'scrollLockEnabled',
  'netsuiteFieldNamesEnabled',
  'coupaFieldNamesEnabled',
];

// Each id is both the React state key and the page-side localStorage key.
const PAGE_FLAG_TOGGLES = ['devFeaturesEnabled', 'devDebugEnabled'];

function detectSite(url) {
  if (/localhost:3000|\.rossum\.(ai|app)|\.r8\.lol/.test(url)) return 'rossum';
  if (/\.netsuite\.com\/app/.test(url)) return 'netsuite';
  if (/\.coupa(cloud|host)\.com/.test(url)) return 'coupa';
  return null;
}

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

export default function App({ tab }) {
  const site = detectSite(tab?.url || '');
  const version = chrome.runtime.getManifest().version_name || chrome.runtime.getManifest().version;

  const [storageValues, setStorageValues] = useState(null);
  const [messageValues, setMessageValues] = useState({ devFeaturesEnabled: false, devDebugEnabled: false });
  const [authError, setAuthError] = useState(null);

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

  const showMdhPanel = site === 'rossum' && !!storageValues?.mdhProvenanceEnabled;
  useEffect(() => {
    document.body.classList.toggle('popup-wide', showMdhPanel);
  }, [showMdhPanel]);

  const setStorageToggle = async (key, value) => {
    setStorageValues((prev) => ({ ...prev, [key]: value }));
    await chrome.storage.local.set({ [key]: value });
    if (key === 'mdhProvenanceEnabled') return; // popup-only; no tab reload
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

  const onDataStorage = () => fetchAuthAndOpen(openMdhTab);
  const onAuditLogs = () => fetchAuthAndOpen(openAuditTab);

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
          <button class="mdh-btn" onClick={onMasterDataHub}>
            <span>Master Data Hub</span>
            <ExternalIcon />
          </button>
        ) : null}
      </header>

      {!site ? (
        <div class="unsupported-site">
          <p>Navigate to a supported site to use this extension:</p>
          <div class="supported-sites">
            <span class="supported-site">Rossum</span>
            <span class="supported-site">NetSuite</span>
            <span class="supported-site">Coupa</span>
          </div>
        </div>
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
                  <Toggle
                    id="mdhProvenanceEnabled"
                    label="MDH provenance"
                    beta
                    hint="Show MDH match provenance for the current annotation"
                    checked={storageValues.mdhProvenanceEnabled}
                    onChange={(v) => setStorageToggle('mdhProvenanceEnabled', v)}
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

              <div class={`tools-row${dimClass('rossum')}`} data-context="rossum">
                <button class="tool-btn" onClick={onDataStorage}>
                  <span>Dataset Management</span>
                  <span class="beta-badge">beta</span>
                  <ExternalIconSmall />
                </button>
                <button class="tool-btn" onClick={onAuditLogs}>
                  <span>Audit Logs</span>
                  <span class="beta-badge">beta</span>
                  <ExternalIconSmall />
                </button>
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
        <a
          href="https://solutionarchitecthandbook.mrtnzlml.com/"
          target="_blank"
          class="handbook-link"
        >
          SA Handbook
          <ExternalIconSmall />
        </a>
      </footer>
    </Fragment>
  );
}
