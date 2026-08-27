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

type PrintPayload = { html?: string; title?: string };

function fail(message: string) {
  const hint = document.getElementById('hint');
  if (hint) hint.textContent = message;
}

// A ceiling on the wait, not a target. Every image here is a `data:` URI already in memory, so this
// resolves in a frame or two in practice; the timer exists because an image that never settles at
// all would otherwise hold the print dialog shut forever, which is strictly worse than printing a
// page with one picture missing.
const IMAGE_SETTLE_MS = 5000;

/**
 * Resolve once every `<img>` under `root` has either decoded or given up.
 *
 * New with assets, and the only reason it is needed: until this task no image ever reached this page
 * — a relative reference had no bytes and an absolute one was a 401 — so `document.fonts.ready` plus
 * two frames was the whole of "laid out". A multi-megabyte `data:` screenshot decodes on the same
 * renderer, and nothing above awaits it, so the dialog could plausibly open over a document whose
 * pictures had not painted.
 *
 * Both events, because `error` is the one a `data:` URI Chrome cannot decode fires, and waiting only
 * for `load` would hand every such page to the timer instead.
 */
export function whenImagesSettle(
  root: HTMLElement | null,
  timeout: number = IMAGE_SETTLE_MS,
): Promise<void> {
  const pending = [...(root ? root.querySelectorAll('img') : [])].filter((img) => !img.complete);
  if (!pending.length) return Promise.resolve();
  return new Promise<void>((done) => {
    let left = pending.length;
    const finish = () => {
      clearTimeout(timer);
      done();
    };
    const one = () => {
      left -= 1;
      if (left <= 0) finish();
    };
    // Declared after `finish` and read inside it: nothing can call `finish` before the listeners
    // below are attached, which is after this line.
    const timer = setTimeout(finish, timeout);
    for (const img of pending) {
      img.addEventListener('load', one, { once: true });
      img.addEventListener('error', one, { once: true });
    }
  });
}

async function boot() {
  const id = new URLSearchParams(location.search).get('printId');
  if (!id) {
    fail('Nothing to print: this page is opened from the Architect.');
    return;
  }
  const key = PREFIX + id;

  let payload: PrintPayload | null = null;
  try {
    const stored = await chrome.storage.session.get(key);
    payload = stored && (stored[key] as PrintPayload);
    await chrome.storage.session.remove(key); // single use, like the console auth staging
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
  document.getElementById('doc')!.innerHTML = payload.html;

  const openDialog = () => window.print();
  document.getElementById('again')!.addEventListener('click', openDialog);

  // Wait for layout before printing, or the dialog can capture a half-laid-out document.
  // Fonts, then images, then two frames; the manual link stays as the fallback for anything
  // that blocks it.
  const ready = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
  ready
    .catch(() => {})
    .then(() => whenImagesSettle(document.getElementById('doc')))
    .then(() =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          document.getElementById('hint')!.textContent =
            'Choose “Save as PDF” in the print dialog. ';
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.textContent = 'Open it again';
          btn.addEventListener('click', openDialog);
          document.getElementById('hint')!.appendChild(btn);
          openDialog();
        }),
      ),
    );
}

boot();
