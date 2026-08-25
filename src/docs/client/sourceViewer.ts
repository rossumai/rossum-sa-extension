// Ported from localpages@4d43f26 `src/client/source-viewer.js` (sha1 485f1b4e…).
//
// Source viewer modal. Intercepts clicks on links to referenced resources and shows
// their content in a popup, fetched through the caller's resolver.
//
// THIRD DELTA (2026-08-20): upstream has two modes — a live resolver and embedded
// <template data-source-path="..."> elements baked into an exported page. The export was
// removed on 2026-08-18, taking the only producer of those templates with it, so the
// offline branch went too rather than staying as a path nothing could reach.
//
// The one delta is what a "source link" IS: upstream matches file extensions
// (.py/.json/.yaml…) under a git root, this matches Rossum API resource URLs (D5).
// Everything else — the modal ids, the Copy flash, Esc/click-outside, the .source-link
// marking — is upstream's.
//
// SECOND DELTA (owner, 2026-08-18): a VIEW SWITCHER. Upstream's two files (`hook.json` and
// `hook.py`) are two separate paths on disk, so one modal per path was enough. Here they are
// two views of ONE API resource, and a code-bearing hook prefers its code — which left the
// JSON definition unreachable. The switcher renders only when the resource offers more than
// one view, and a switch is just this same modal reopened on the sibling KEY (`?view=…`), so
// live and offline take the identical path they already take.
/** Everything this modal needs injected, so the file stays import-free. */
export type SourceViewerOptions = {
  /** Is this href a resource link? Differs between the pane and an exported page. */
  isSourceLink?: (href: string | null) => boolean;
  /** href -> the key a resource is addressed by (path + search), or null if it is not one. */
  keyFor?: (href: string) => string | null;
  /** key -> the resource. The object form is what lets a hook arrive as Python. */
  resolve?: ((key: string) => Promise<any>) | null;
  /** (text, language) -> html string. */
  highlight?: ((text: string, language: string) => string) | null;
  /** Injected from resources.js: peel our `?view=` marker off a key, and put it back. */
  splitView?: (k: string) => { path: string; view: any };
  withView?: (k: any, view: any) => string;
};

export function initSourceViewer(root: HTMLElement, opts?: SourceViewerOptions): () => void {
  var options: SourceViewerOptions = opts || {};
  var doc = root.ownerDocument || document;
  // `isSourceLink` and `keyFor` are injected so the predicate can differ between the
  // pane (org origin known) and the exported page (origin baked into the hrefs).
  var isSourceLink = options.isSourceLink || function () { return false; };
  var keyFor = options.keyFor || function (href: string) { return href; };
  // resolve: (key) => Promise<string | { text, language, note }>. The object form is what
  // lets a hook's implementation arrive as Python while a schema arrives as JSON.
  var resolve = options.resolve || null;
  var highlight = options.highlight || null;  // (text, language) => html string
  // Injected from resources.js so this file stays import-free (it is inlined into exported
  // pages). Defaults make the switcher inert rather than broken when they are absent.
  var splitView = options.splitView || function (k: string) { return { path: k, view: null }; };
  var withView = options.withView || function (k: string) { return k; };
  var VIEW_LABEL: Record<string, string> = { code: 'Code', json: 'Definition' };

  // The modal markup ships with the page, so these resolve. `overlay`/`codeEl` are still
  // checked below (the bail-out predates this port); the casts are here because the guard
  // cannot narrow a `var` for the nested closures that use them.
  var overlay = doc.getElementById('srcOverlay') as HTMLElement;
  var titleEl = doc.getElementById('srcTitle') as HTMLElement;
  var pathEl = doc.getElementById('srcPath') as HTMLElement;
  var codeEl = doc.getElementById('srcCode') as HTMLElement;
  var closeBtn = doc.getElementById('srcClose') as HTMLElement;
  var copyBtn = doc.getElementById('srcCopy') as HTMLElement;
  var viewsEl = doc.getElementById('srcViews') as HTMLElement;
  if (!overlay || !codeEl) return function () {};

  var copyResetTimer: ReturnType<typeof setTimeout> | null = null;
  function flashCopyBtn(state: string, label: string) {
    copyBtn.classList.remove('copied', 'failed');
    copyBtn.classList.add(state);
    copyBtn.textContent = label;
    if (copyResetTimer) clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(function() {
      copyBtn.classList.remove('copied', 'failed');
      copyBtn.textContent = 'Copy';
    }, 1500);
  }
  function fallbackCopy(text: string) {
    var ta = doc.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    doc.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = doc.execCommand('copy'); } catch (err) { ok = false; }
    doc.body.removeChild(ta);
    flashCopyBtn(ok ? 'copied' : 'failed', ok ? 'Copied!' : 'Failed');
  }
  function onCopy(e: Event) {
    e.preventDefault();
    var text = codeEl.textContent || '';
    if (!text) { flashCopyBtn('failed', 'Empty'); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(function() { flashCopyBtn('copied', 'Copied!'); })
        .catch(function() { fallbackCopy(text); });
    } else {
      fallbackCopy(text);
    }
  }
  copyBtn.addEventListener('click', onCopy);

  // `views` is what the RESOURCE offers, so a queue or a webhook (one view) shows no switcher
  // at all and nothing changes for them.
  function renderViews(path: string, current: string | null, views: string[] | null) {
    if (!viewsEl) return;
    while (viewsEl.firstChild) viewsEl.removeChild(viewsEl.firstChild);
    if (!views || views.length < 2) { viewsEl.hidden = true; return; }
    viewsEl.hidden = false;
    views.forEach(function (v: string) {
      var btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'source-view-btn';
      btn.setAttribute('aria-pressed', v === current ? 'true' : 'false');
      btn.textContent = VIEW_LABEL[v] || v;
      btn.addEventListener('click', function () { if (v !== current) openModal(withView(path, v)); });
      viewsEl.appendChild(btn);
    });
  }

  function openModal(key: string) {
    var split = splitView(key);
    var display = split.path;                       // never show our own view marker
    var seg = String(display).split('/');
    titleEl.textContent = seg[seg.length - 1] || display;
    pathEl.textContent = display;
    overlay.classList.add('open');
    doc.body.style.overflow = 'hidden';
    renderViews(display, null, null);
    // Defensive: DocView always passes a resolver, but calling a null one would throw
    // inside a click handler and take the modal down silently.
    if (!resolve) { codeEl.textContent = 'No resolver — cannot load this resource.'; return; }
    // Live mode — fetch it.
    codeEl.textContent = 'Loading…';
    resolve(key)
      .then(function(result) {
        var payload = (result && typeof result === 'object') ? result : { text: result, language: '', note: '' };
        // Say WHICH part of the resource is on screen, so nobody mistakes a hook's code
        // for the whole object.
        if (payload.note) pathEl.textContent = display + ' · ' + payload.note;
        if (highlight) codeEl.innerHTML = highlight(payload.text, payload.language);
        else codeEl.textContent = payload.text;
        renderViews(display, payload.view || split.view || null, payload.views);
      })
      .catch(function(err) { codeEl.textContent = 'Failed to load: ' + (err && err.message ? err.message : err); });
  }

  function closeModal() {
    overlay.classList.remove('open');
    doc.body.style.overflow = '';
    if (copyResetTimer) { clearTimeout(copyResetTimer); copyResetTimer = null; }
    copyBtn.classList.remove('copied', 'failed');
    copyBtn.textContent = 'Copy';
  }

  function onOverlayClick(e: Event) { if (e.target === overlay) closeModal(); }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && overlay.classList.contains('open')) closeModal();
  }
  closeBtn.addEventListener('click', closeModal);
  overlay.addEventListener('click', onOverlayClick);
  doc.addEventListener('keydown', onKey);

  // The unified specification view has one `.markdown-body` PER DELIVERABLE (2026-08-19), so
  // listeners bind at the root and events bubble up from whichever section they happened in. With a
  // single body this is identical to what it replaced, and DocView is the only caller.
  var body = root;
  if (!body) return function () { closeModal(); };

  function onClick(e: Event) {
    var link = (e.target as Element).closest('a');
    if (!link) return;
    var href = link.getAttribute('href');
    if (!isSourceLink(href)) return;
    e.preventDefault();
    openModal(keyFor(href as string) as string);   // isSourceLink already rejected empty
  }
  body.addEventListener('click', onClick);

  // Mark eligible links with a visual cue.
  body.querySelectorAll('a').forEach(function(link: HTMLAnchorElement) {
    if (isSourceLink(link.getAttribute('href'))) {
      link.classList.add('source-link');
      link.title = 'Click to preview this resource';
    }
  });

  return function destroy() {
    body.removeEventListener('click', onClick);
    copyBtn.removeEventListener('click', onCopy);
    closeBtn.removeEventListener('click', closeModal);
    overlay.removeEventListener('click', onOverlayClick);
    doc.removeEventListener('keydown', onKey);
    closeModal();
  };
}
