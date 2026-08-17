// The print page (dist/console/print.html). Reads the document staged for it, injects it,
// and opens the print dialog — where "Save as PDF" is Chrome's default destination.
//
// Why a page of our own rather than a blob: URL — measured earlier in this port, a blob:
// document INHERITS the creating page's CSP, so an inline <script> in one would never run.
// A real extension page loads this script from the same package, which `script-src 'self'`
// allows, and it can <link> the stylesheets instead of inlining them.
//
// The payload is staged in chrome.storage.session under a single-use key and removed on
// read — the same pattern as `consoleAuth_<uuid>`, and session storage means a printed
// specification never lands at rest on disk.
const PREFIX = 'docPrint_';

function fail(message) {
  const hint = document.getElementById('hint');
  if (hint) hint.textContent = message;
}

async function boot() {
  const id = new URLSearchParams(location.search).get('printId');
  if (!id) { fail('Nothing to print: this page is opened from the Architect.'); return; }
  const key = PREFIX + id;

  let payload = null;
  try {
    const stored = await chrome.storage.session.get(key);
    payload = stored && stored[key];
    await chrome.storage.session.remove(key);   // single use, like the console auth staging
  } catch (err) {
    fail('Could not read the staged document.');
    return;
  }
  if (!payload || typeof payload.html !== 'string') {
    // Most likely a reload: the key was consumed by the first load.
    fail('This document has already been printed. Start again from the Architect.');
    return;
  }

  if (payload.title) document.title = payload.title;
  // The HTML was sanitized before staging (src/docs/sanitize.js) — the same tree the pane
  // adopts — so this is the already-filtered output, not raw deliverable text.
  document.getElementById('doc').innerHTML = payload.html;

  const openDialog = () => window.print();
  document.getElementById('again').addEventListener('click', openDialog);

  // Wait for layout before printing, or the dialog can capture a half-laid-out document.
  // Two frames plus the font-loading promise is enough in practice; the manual link stays as
  // the fallback for anything that blocks it.
  const ready = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
  ready.catch(() => {}).then(() => requestAnimationFrame(() => requestAnimationFrame(() => {
    document.getElementById('hint').textContent = 'Choose “Save as PDF” in the print dialog. ';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Open it again';
    btn.addEventListener('click', openDialog);
    document.getElementById('hint').appendChild(btn);
    openDialog();
  })));
}

boot();
