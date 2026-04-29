import { h, Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import Toggle from './Toggle.jsx';
import MdhProvenancePanel from './MdhProvenancePanel.jsx';

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

const MESSAGE_TOGGLES = [
  { id: 'devFeaturesEnabled', getMessage: 'get-dev-features-enabled-value', toggleMessage: 'toggle-dev-features-enabled' },
  { id: 'devDebugEnabled', getMessage: 'get-dev-debug-enabled-value', toggleMessage: 'toggle-dev-debug-enabled' },
];

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

function sendMessage(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(resp ?? null);
    });
  });
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

  useEffect(() => {
    chrome.storage.local.get(STORAGE_TOGGLES).then((vals) => {
      const filled = {};
      for (const key of STORAGE_TOGGLES) filled[key] = !!vals[key];
      setStorageValues(filled);
    });
  }, []);

  useEffect(() => {
    if (!site) return;
    for (const { id, getMessage } of MESSAGE_TOGGLES) {
      sendMessage(tab.id, getMessage).then((resp) => {
        setMessageValues((prev) => ({ ...prev, [id]: !!resp }));
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

  const setMessageToggle = (id, toggleMessage) => {
    chrome.tabs.sendMessage(tab.id, toggleMessage, (resp) => {
      if (resp === true) {
        setMessageValues((prev) => ({ ...prev, [id]: !prev[id] }));
        chrome.tabs.reload(tab.id);
      }
    });
  };

  const onMasterDataHub = () => {
    chrome.tabs.create({
      url: combineUrlWithCustomPath(tab.url, '/svc/master-data-hub/web/management'),
      index: tab.index + 1,
    });
  };

  const onDataStorage = () => {
    chrome.tabs.sendMessage(tab.id, 'get-auth-info', (response) => {
      if (response?.token && response?.domain) {
        const authId = crypto.randomUUID();
        const key = `mdhAuth_${authId}`;
        chrome.storage.local.set(
          { [key]: { token: response.token, domain: response.domain, createdAt: Date.now() } },
          () => {
            chrome.tabs.create({
              url: chrome.runtime.getURL(`mdh/mdh.html?authId=${authId}`),
              index: tab.index + 1,
            });
          },
        );
      }
    });
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
                    onChange={() => setMessageToggle('devFeaturesEnabled', 'toggle-dev-features-enabled')}
                  />
                  <Toggle
                    id="devDebugEnabled"
                    label="Dev debug"
                    hint="devDebugEnabled"
                    checked={messageValues.devDebugEnabled}
                    onChange={() => setMessageToggle('devDebugEnabled', 'toggle-dev-debug-enabled')}
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
              </div>
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
