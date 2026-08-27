import { h } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { createMarkdownRenderer, wrapStandaloneImages } from '../render.js';
import { sanitizeBody } from '../sanitize.js';
import { renderDocument } from '../renderCache.js';
import { syncAssets } from '../assetSync.js';
import { initCodeCopy } from '../client/codeCopy.js';
import { initSectionPreview } from '../client/sectionPreview.js';
import { initSourceViewer } from '../client/sourceViewer.js';
import {
  apiPathFromHref,
  isResourceHref,
  createResourceFetcher,
  splitResourceView,
  withResourceView,
} from '../resources.js';
import { namespaceSection, prefixFor, resolveInPage } from '../idNamespace.js';
import { animateScrollTop, SCROLL_MS } from '../../mdh/smoothScroll.js';
import { highlightCode } from '../highlightCode.js';
import { getMermaidRenderer, loadMermaidRenderer } from '../../ui/fabry/mermaidLoader.js';
import type { SourceSection } from '../specDocument.js';

// The localpages document, rendered inside the Architect's Preview pane.
//
// Structure mirrors what the exported page has, which is what lets one stylesheet
// serve both: `.docs-pane` is the container-query context and the TOC's positioning
// parent, `.docs-root` is the scrolling element (so theme.css's ported page-level
// rules apply to it), and `main.markdown-body` is upstream's content column.
//
// The four behaviours are upstream's own modules, initialised against this root and
// torn down before each re-render — a page-scoped IIFE never had to unwind itself.

const MERMAID_FENCE = /^[ \t]*```[ \t]*mermaid[ \t]*$/m;

// Decoupled from `assets.ts`'s own `AssetRow`/`Held` shapes on purpose, matching how
// assetSync.js already types its own local store contract rather than importing one — DocView
// only ever tests these for truthiness or passes them through. `resolve` and `pin` are not in
// the brief's original prop list, which predates controller rulings 15 and 16: `syncAssets` is
// what actually starts a fetch now (DocView never calls `resolve` itself) and pins whatever it
// just painted (ruling 16, so a resolve on one asset can never evict another the reader is still
// looking at) — both need to be on the store DocView hands it.
type AssetsProp = {
  lookup: (href: string) => unknown | null;
  peek: (href: string) => unknown | null;
  resolve: (href: string) => Promise<unknown> | void;
  pin: (hrefs: string[]) => void;
  version: () => number;
};

// Rendered siblings, for the cross-deliverable hover preview. Keyed by slug + the exact
// text, so an edit invalidates its own entry and nothing goes stale; small cap because a
// reader only ever hovers a handful of references. Module-level so switching deliverable
// and coming back does not re-render what was already built.
const SIBLING_CACHE = new Map();
const SIBLING_CAP = 12;

function siblingBody(slug: any, text: any) {
  const key = slug + '\u0000' + text;
  const hit = SIBLING_CACHE.get(key);
  if (hit) return hit;
  // No mermaid renderer and no syncLines here: a preview needs neither, and leaving them
  // out keeps a hover cheap (a fence degrades to a code block, as it does while the
  // diagram bundle is still loading).
  const md = createMarkdownRenderer();
  const body = sanitizeBody(wrapStandaloneImages(md.render(String(text || ''), {})));
  if (SIBLING_CACHE.size >= SIBLING_CAP) SIBLING_CACHE.delete(SIBLING_CACHE.keys().next().value);
  SIBLING_CACHE.set(key, body);
  return body;
}

// href -> the sibling document and the heading inside it, or null when it resolves to
// nothing (an unknown slug, or a link to this same deliverable).
export function resolveSiblingHref(href: string, resolveDoc?: (slug: string) => any) {
  if (!resolveDoc || !href) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('/'))
    return null;
  const [pathPart, frag = ''] = String(href).split('#');
  const slug = pathPart.split('?')[0].replace(/\.(md|html)$/i, '');
  if (!slug) return null;
  const doc = resolveDoc(slug);
  if (!doc) return null;
  let headingId = '';
  try {
    headingId = decodeURIComponent(frag);
  } catch {
    headingId = frag;
  }
  return { title: doc.title, headingId, body: siblingBody(slug, doc.text) };
}

// How far below the scroller's top edge a navigation jump lands, so the sticky section header does
// not sit on top of the heading the reader just asked for.
const NAV_INSET = 40;

// Jump to an element inside the scroller, fast. `scrollIntoView({ behavior: 'smooth' })` was what
// made navigation feel sluggish (owner, 2026-08-19): Chrome's implementation is ~300-500ms for a long
// distance and takes no duration. `animateScrollTop` is this repo's hand-rolled tween, written for
// precisely that reason, and it honours prefers-reduced-motion.
//
// The target is computed from RECTS rather than offsetTop, so it does not care which ancestor happens
// to be the offsetParent.
function jumpTo(scroller: any, el: any, inset = NAV_INSET, { instant = false } = {}) {
  if (!scroller || !el) return false;
  const delta = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  const top = Math.max(0, scroller.scrollTop + delta - inset);
  // `instant` is for RESTORING a position (a mode switch), where animating from the top would be the
  // very jump we are trying to avoid.
  if (instant) {
    scroller.scrollTop = top;
    return true;
  }
  animateScrollTop(scroller, top, { duration: SCROLL_MS });
  return true;
}

function usePrefersDark() {
  const [dark, setDark] = useState(() => {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch {
      return false;
    }
  });
  useEffect(() => {
    let mq;
    try {
      mq = window.matchMedia('(prefers-color-scheme: dark)');
    } catch {
      return undefined;
    }
    if (!mq || !mq.addEventListener) return undefined;
    const on = (e: any) => setDark(!!e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return dark;
}

// `sections` is the unified specification: one entry per deliverable, rendered into its own
// `.markdown-body` inside its own `<section>`, with every section in the DOM at once — which is what
// makes Cmd+F reach the whole specification (spec 2026-08-19 F3). A section that carries a `slug`
// gets its heading ids namespaced (F2); the legacy single-document call passes none and is therefore
// byte-identical to what it was.
export default function DocView({
  sections = null,
  headerFor = null,
  docId = '',
  text = '',
  domain = '',
  token = '',
  onWarnings,
  onNavigate,
  resolveDoc,
  onScroll: onSpy,
  docRef,
  assets = null,
  onAssetOpen,
}: {
  sections?: SourceSection[] | null;
  headerFor?: ((s: any) => any) | null;
  docId?: string;
  text?: string;
  domain?: string;
  token?: string;
  onWarnings?: (w: string[]) => void;
  onNavigate?: (target: any) => void;
  resolveDoc?: (slug: string) => any;
  onScroll?: (info: any) => void;
  docRef?: { current: any };
  assets?: AssetsProp | null;
  onAssetOpen?: (href: string) => void;
}) {
  const paneRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // These arrive as FRESH FUNCTIONS on every host render (they close over the store), so they
  // must never reach the adopt effect's dependencies: the effect tears the document down and
  // re-initialises every behaviour, and `initSourceViewer`'s teardown calls closeModal(). With
  // them in the deps, one keystroke closed an open file modal and cancelled the 280ms hover
  // timer mid-hover — which is exactly "the preview doesn't work". Held in refs instead, so the
  // effect re-runs only when there is genuinely new DOM to adopt.
  const resolveDocRef = useRef(resolveDoc);
  resolveDocRef.current = resolveDoc;
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  const onSpyRef = useRef(onSpy);
  onSpyRef.current = onSpy;
  const assetsRef = useRef(assets);
  assetsRef.current = assets;
  const onAssetOpenRef = useRef(onAssetOpen);
  onAssetOpenRef.current = onAssetOpen;
  // Read UNCONDITIONALLY, every render: `assets.version()` is backed by a @preact/signals signal
  // (see assets.ts), and reading its `.value` here is what wakes this component when a fetch
  // completes. It deliberately does NOT feed the `rendered` memo or the adopt effect below —
  // controller ruling 15: that used to route every resolved fetch through `body.replaceChildren()`,
  // which tears down `initSourceViewer` (closing the very modal this task opens) and cancels the
  // hover-preview timer mid-hover. Instead `assetsVersion` only drives the asset-sync effect
  // further down, which patches the LIVE DOM in place and never touches the adopted tree's
  // lifecycle.
  const assetsVersion = assets ? assets.version() : 0;
  const dark = usePrefersDark();
  const list = useMemo(
    () => (sections && sections.length ? sections : [{ id: docId, slug: '', text }]),
    [sections, docId, text],
  );
  // Rendering is debounced off the keystroke, but the SKELETON is not: the sections themselves paint
  // immediately so a switch never shows an empty column.
  const sig = list.map((s) => `${s.id}\u0000${s.slug || ''}\u0000${s.text || ''}`).join('\u0001');
  const [held, setHeld] = useState(list);
  useEffect(() => {
    const t = setTimeout(() => setHeld(list), 120);
    return () => clearTimeout(t);
  }, [sig]);
  const needsMermaid = held.some((s) => MERMAID_FENCE.test(s.text || ''));
  const [mermaidReady, setMermaidReady] = useState(() => !!getMermaidRenderer());

  // Load the diagram bundle BEFORE the first paint that needs it, so a document with
  // diagrams never flashes its fences as code blocks first.
  useEffect(() => {
    if (!needsMermaid || mermaidReady) return undefined;
    let stale = false;
    loadMermaidRenderer()
      .then(() => {
        if (!stale) setMermaidReady(true);
      })
      .catch(() => {
        if (!stale) setMermaidReady(true);
      }); // render without diagrams
    return () => {
      stale = true;
    };
  }, [needsMermaid, mermaidReady]);

  // Rendered through the shared cache, so a deliverable warmed in the background (see
  // architect/preload.js) paints on the first frame after a switch instead of being re-rendered.
  // Each through the shared cache, so deliverables warmed in the background (architect/preload.js)
  // paint on the first frame instead of being re-rendered. `syncLines: true` matches the key the
  // preloader warms.
  const rendered = useMemo(
    () =>
      held.map((s) => ({
        ...s,
        out: renderDocument({
          id: s.id,
          text: s.text || '',
          mermaid: mermaidReady ? getMermaidRenderer() : null,
          dark,
          syncLines: true,
        }),
      })),
    [held, mermaidReady, dark],
  );

  useEffect(() => {
    if (onWarnings) onWarnings(rendered.flatMap((r) => r.out.warnings || []));
  }, [rendered]);

  // Adopt the sanitized nodes and (re)start the behaviours.
  useEffect(() => {
    const root = rootRef.current;
    const pane = paneRef.current;
    if (!root || !pane) return undefined;
    // Zip by position: Preact renders the sections in list order, so index i of the DOM matches
    // index i of `rendered` — no attribute-selector escaping needed for ids we do not control.
    const secs = [...root.querySelectorAll<HTMLElement>('[data-deliverable]')];
    const main = secs.length ? secs[0].querySelector('.markdown-body') : null;
    if (!main) return undefined;
    rendered.forEach((item, i) => {
      const sec = secs[i];
      const body = sec && sec.querySelector('.markdown-body');
      if (!body) return;
      body.replaceChildren();
      if (item.out.body) {
        for (const node of [...item.out.body.childNodes])
          body.appendChild(document.importNode(node, true));
      }
      // Ids are prefixed on the ADOPTED COPY, never in the cache (F7).
      if (item.slug) namespaceSection(sec, prefixFor(item.slug));
    });

    const fetchResource = domain && token ? createResourceFetcher({ domain, token }) : null;
    const teardowns = [
      // No in-pane TOC: the outline moved to the Architect sidebar (owner, 2026-08-18), which
      // always has room — upstream's `.toc` needs a 1280px column and the pane is ~936px at a
      // 1280px window, so it was hidden in practice. Upstream's `client/toc.js` served the
      // exported pages, which have no sidebar; it was deleted with the ZIP export.
      initCodeCopy(root),
      initSectionPreview(root, root, {
        // A reference to another deliverable previews THAT document's section — the
        // multi-document equivalent of upstream's same-page card (owner, 2026-08-18).
        resolveExternal: (href) => resolveSiblingHref(href, resolveDocRef.current),
        onOpenExternal: (href) => {
          const slug = href
            .split('#')[0]
            .split('?')[0]
            .replace(/\.(md|html)$/i, '');
          if (slug && onNavigateRef.current) onNavigateRef.current(slug);
        },
      }),
      initSourceViewer(root, {
        isSourceLink: (href) => isResourceHref(href, domain),
        keyFor: (href) => apiPathFromHref(href, domain),
        resolve: fetchResource,
        highlight: (t, language) => highlightCode(t, language),
        // A hook is two files (definition + implementation) behind one API resource, so the
        // modal addresses them as views of one key — see resources.js.
        splitView: splitResourceView,
        withView: withResourceView,
      }),
    ];
    // The scroll listener belongs to the effect that owns `root`, and the API travels WITH the
    // callback. Anything that remounts this component (a mode switch) builds a new scroller, and a
    // listener attached from the parent on stale deps would keep listening to the destroyed node —
    // measured: the scroll spy died permanently after one mode switch.
    {
      // The spy runs on every scroll frame, and a real specification has ~130 headings — reading
      // `offsetTop` for each of them per frame is 130 forced layout reads for an answer that only
      // changes when the document does. So the geometry is measured once and cached, keyed on the
      // scroller's own `scrollHeight`: one cheap layout read per frame tells us whether anything
      // could have moved. A resize invalidates it outright.
      let geo: any = null;
      let geoHeight = -1;
      const readGeo = () => {
        if (geo && root.scrollHeight === geoHeight) return geo;
        geoHeight = root.scrollHeight;
        const secs = [...root.querySelectorAll<HTMLElement>('[data-deliverable]')];
        geo = {
          sections: secs.map((el) => ({
            id: el.dataset.deliverable,
            slug: el.dataset.slug || '',
            top: el.offsetTop,
          })),
          headings: secs.flatMap((el) =>
            [...el.querySelectorAll<HTMLElement>('h1[id], h2[id], h3[id]')].map((hEl) => ({
              docId: el.dataset.deliverable,
              slug: hEl.id,
              top: el.offsetTop + hEl.offsetTop,
            })),
          ),
        };
        return geo;
      };
      const invalidateGeo = () => {
        geo = null;
      };
      window.addEventListener('resize', invalidateGeo);
      teardowns.push(() => window.removeEventListener('resize', invalidateGeo));

      const api = {
        scroller: root,
        // Sidebar outline → document, resolved across the WHOLE page so a slug can name a heading in
        // any deliverable; `resolveInPage` matches a prefixed id (F2) against the un-prefixed slug the
        // sidebar holds, and matches by ATTRIBUTE rather than `#id` because a heading slug may start
        // with a digit ("3-architecture"), which is not a valid CSS id selector.
        scrollToSlug: (slug: any, prefix = '', opts: any) =>
          jumpTo(root, resolveInPage(root, slug, prefix), NAV_INSET, opts),
        // The sidebar's row click means "take me to this deliverable", which is the section itself
        // rather than any heading inside it.
        // A section lands flush with the top: its own sticky header is what sits there.
        scrollToDeliverable: (id: any, opts: any) =>
          jumpTo(
            root,
            [...root.querySelectorAll<HTMLElement>('[data-deliverable]')].find(
              (el) => el.dataset.deliverable === id,
            ),
            0,
            opts,
          ),
        // Where each section starts, and every heading — both from the cache above.
        sectionTops: () => readGeo().sections,
        headingTops: () => readGeo().headings,
      };
      if (docRef) docRef.current = api;
      const fireSpy = () => {
        if (onSpyRef.current) onSpyRef.current(api);
      };
      root.addEventListener('scroll', fireSpy, { passive: true });
      teardowns.push(() => root.removeEventListener('scroll', fireSpy));
      fireSpy();
    }
    return () => {
      for (const off of teardowns) {
        try {
          off();
        } catch {
          /* teardown is best-effort */
        }
      }
      if (docRef) docRef.current = null;
    };
  }, [rendered, domain, token]);

  // Resolves asset references against the LIVE DOM, separate from the adopt effect above on
  // purpose (controller ruling 15). `rendered` here only re-triggers this after a genuine content
  // swap (the adopt effect already ran and rebuilt the tree this operates on); `assetsVersion`
  // re-triggers it on its own whenever the store changes — a resolve, a failure, an upload, a
  // remove — WITHOUT `rendered` changing identity, so the adopt effect's own dependency array
  // never sees a change and never tears down the modal or the hover timer mid-use.
  useEffect(() => {
    syncAssets(rootRef.current, assetsRef.current);
  }, [rendered, assetsVersion]);

  // A relative link (`architecture.md`, or `.html` after an export round-trip) means
  // "a sibling document". On a page that is a navigation; in a pane it would replace
  // the whole Console, so it is intercepted and reported to the host, which opens the
  // matching deliverable. Unresolvable ones do nothing rather than destroying the app.
  function onClick(e: any) {
    const a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (/^https?:|^mailto:/i.test(href) || isResourceHref(href, domain)) return;

    // An in-document reference (`[see](#modules)`) scrolls the PANE, the same way the TOC
    // and the hover card's footer already do. Left to the browser it would append `#x` to
    // the Console's own URL — the stray-fragment problem toc.js deliberately avoids — and
    // fragment navigation inside a nested scroller on an extension page is not something to
    // rely on. An unresolvable anchor does nothing rather than navigating anywhere.
    if (href.startsWith('#')) {
      if (href.length < 2) return;
      // With many deliverables on one page an id can appear twice (F2), so resolution starts in the
      // section the link is IN — that is what a fragment written in that document means.
      const inSec = a.closest('[data-slug]');
      const target = resolveInPage(
        rootRef.current!,
        href.slice(1),
        inSec ? prefixFor((inSec as HTMLElement).dataset.slug) : '',
      );
      e.preventDefault();
      jumpTo(rootRef.current!, target);
      return;
    }

    if (assetsRef.current && assetsRef.current.lookup(href)) {
      e.preventDefault();
      onAssetOpenRef.current?.(href);
      return;
    }

    e.preventDefault();
    const slug = href
      .split('#')[0]
      .split('?')[0]
      .replace(/\.(md|html)$/i, '');
    if (slug && onNavigateRef.current) onNavigateRef.current(slug);
  }

  return (
    <div class="docs-pane" ref={paneRef}>
      <div class="docs-root" ref={rootRef} onClick={onClick}>
        {list.map((s) => (
          <section
            key={s.id}
            class="docs-section"
            data-deliverable={s.id}
            data-slug={s.slug || null}
          >
            {headerFor ? headerFor(s) : null}
            <div class="markdown-body" />
          </section>
        ))}
      </div>
      <div class="source-overlay" id="srcOverlay">
        <div class="source-modal">
          <div class="source-modal-header">
            <div class="source-modal-info">
              <div class="source-modal-title" id="srcTitle" />
              <div class="source-modal-path" id="srcPath" />
            </div>
            <div class="source-modal-views" id="srcViews" hidden />
            <button
              type="button"
              class="source-modal-copy"
              id="srcCopy"
              aria-label="Copy file content to clipboard"
            >
              Copy
            </button>
            <button class="source-modal-close" id="srcClose">
              {'×'}
            </button>
          </div>
          <div class="source-modal-body">
            <pre>
              <code id="srcCode" class="hljs" />
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
