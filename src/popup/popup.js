function combineUrlWithCustomPath(originalUrl, customPath) {
  const match = originalUrl.match(/^https?:\/\/[^/?#]+/);
  if (!match) return originalUrl;
  const normalizedPath = customPath.startsWith('/') ? customPath : `/${customPath}`;
  return match[0] + normalizedPath;
}

const STORAGE_TOGGLES = [
  'schemaAnnotationsEnabled',
  'resourceIdsEnabled',
  'expandFormulasEnabled',
  'expandReasoningFieldsEnabled',
  'scrollLockEnabled',
  'netsuiteFieldNamesEnabled',
];

const MESSAGE_TOGGLES = [
  { id: 'devFeaturesEnabled', getMessage: 'get-dev-features-enabled-value', toggleMessage: 'toggle-dev-features-enabled' },
  { id: 'devDebugEnabled', getMessage: 'get-dev-debug-enabled-value', toggleMessage: 'toggle-dev-debug-enabled' },
];

document.addEventListener('DOMContentLoaded', async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

  // Dim sections not relevant to the current page
  const url = tab.url || '';
  const isRossum = /localhost:3000|\.rossum\.(ai|app)|\.r8\.lol/.test(url);
  const isNetsuite = /\.netsuite\.com\/app/.test(url);
  if (isRossum) document.querySelector('[data-context="netsuite"]')?.classList.add('dimmed');
  else if (isNetsuite) document.querySelector('[data-context="rossum"]')?.classList.add('dimmed');

  // Master Data Hub button
  document.getElementById('masterDataHub')?.addEventListener('click', () => {
    chrome.tabs.create({
      url: combineUrlWithCustomPath(tab.url, '/svc/data-matching/web/management'),
      index: tab.index + 1,
    });
  });

  // Storage-backed toggles (reload on change)
  const storageValues = await chrome.storage.local.get(STORAGE_TOGGLES);
  for (const key of STORAGE_TOGGLES) {
    const checkbox = document.getElementById(key);
    if (!(checkbox instanceof HTMLInputElement)) continue;
    checkbox.checked = storageValues[key] ?? false;
    checkbox.addEventListener('change', async () => {
      await chrome.storage.local.set({ [key]: checkbox.checked });
      chrome.tabs.reload(tab.id);
    });
  }

  // Message-backed toggles (devFeaturesEnabled, devDebugEnabled)
  for (const { id, getMessage, toggleMessage } of MESSAGE_TOGGLES) {
    chrome.tabs.sendMessage(tab.id, getMessage, (response) => {
      const checkbox = document.getElementById(id);
      if (!(checkbox instanceof HTMLInputElement)) return;
      checkbox.checked = response ?? false;
      checkbox.addEventListener('change', () => {
        chrome.tabs.sendMessage(tab.id, toggleMessage, (resp) => {
          if (resp === true) chrome.tabs.reload(tab.id);
        });
      });
    });
  }
});
