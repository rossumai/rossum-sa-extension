// Lazy entry point, mirroring initGalaxy/initInspector/initFabry. Auth reuses
// the Console's existing consoleAuth_<uuid> → sessionStorage credentials; the
// Academy adds no new auth path.
import * as store from './store.js';

let progressListenerOn = false;

export async function initAcademy() {
  const domain = sessionStorage.getItem('consoleDomain') || '';
  if (!domain) {
    // Fail closed: a '' origin would silently read and write a shared,
    // un-scoped progress entry instead of one keyed to a real org.
    store.connected.value = false;
    store.error.value = 'Open the Rossum Console from this extension\'s popup on a Rossum tab to access the Academy.';
    return;
  }
  store.setOrigin(domain);
  try {
    await store.refreshProgress();
    store.connected.value = true;
  } catch (e: any) {
    store.error.value = String(e?.message || e);
    store.connected.value = false;
  }
  // Progress is written by the content script too — mirror it live. Guarded
  // against double-registration the way src/inspector/index.jsx guards its own
  // onChanged listener (`viewedListenerOn`): a second initAcademy() would
  // otherwise stack listeners silently, each firing its own refresh per change.
  if (!progressListenerOn) {
    progressListenerOn = true;
    chrome.storage.onChanged?.addListener((changes, area) => {
      if (area === 'local' && changes.trainingProgress) store.refreshProgress();
    });
  }
}
