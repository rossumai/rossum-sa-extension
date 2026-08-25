import { h, Fragment } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import * as store from '../store.js';
import * as fstore from '../../store.js';
import DocView from '../../../docs/components/DocView.jsx';
import { assignSlugs } from '../../../docs/slug.js';
import { prefixFor } from '../../../docs/idNamespace.js';
import { displayTitle } from '../format.js';
import { currentSection, activeHeadingAt } from '../specTarget.js';
import { animateScrollTop, SCROLL_MS } from '../../../mdh/smoothScroll.js';
import { openPdfFlow } from '../pdfAction.js';
import { extractOutline } from '../../../docs/outline.js';
import SourceEditor, { scrollLineIntoView } from './SourceEditor.jsx';
import RefineDock from './RefineDock.jsx';
import HistoryPanel from './HistoryPanel.jsx';
import { updateDeliverable } from '../actions.js';
import type { Deliverable } from '../collectionPlan.js';
import type { CheckResult } from '../api.js';
import type { SourceSection } from '../../../docs/specDocument.js';

// The whole specification as ONE document (spec 2026-08-19). Every deliverable is a section in one
// scroller, which is what lets a reader go top-to-bottom and what makes Cmd+F reach all of it — the
// reason nothing here is virtualised.
//
// This component owns the document COLUMN: the bar, the per-section headers and the scroll spy. The
// per-deliverable machinery lives in InspectorRail; the deliverable list is navigation.

// ONE badge, because there is one axis: what Mr. Fabry measured against the organization. The manual
// state was dropped on 2026-08-19 (owner) — it gated nothing, and of its five words only "Verified"
// sounded like a verdict, which is precisely what this pill already says.
//
// Staleness is a property OF THIS VERDICT (the check predates the current text), so it is rendered
// INSIDE the pill — unfilled, same hue, with the word — rather than as a second badge beside it.
export const VERDICT: Record<string, string[]> = { pass: ['pass', '✓ Met'], fail: ['fail', '✗ Not met'], uncertain: ['uncertain', '? Uncertain'] };
export function CheckBadge({ result }: { result: CheckResult | undefined }) {
  if (result && result.running) return <span class="fabry-spec-pill run">{'Checking…'}</span>;
  const known = result && VERDICT[result.verdict as string];
  if (!known) return <span class="fabry-spec-pill none" title="No check has run for this deliverable">{'Not checked'}</span>;
  const [cls, label] = known;
  const stale = !!result.stale;
  return (
    <span
      class={'fabry-spec-pill ' + cls + (stale ? ' stale' : '')}
      title={stale ? 'This verdict is older than the text — re-run the check' : 'The last check of this deliverable'}
    >{label}{stale ? ' · stale' : ''}</span>
  );
}

// Identity and status only. Deliberately no action buttons: the rail owns actions, and a document
// reads as a document when its headings are not competing with controls.
function SectionHeader({ deliverable }: { deliverable: Deliverable }) {
  const result = store.results.value[deliverable.id];
  return (
    <div
      class="fabry-spec-sec-hd"
      data-for={deliverable.id}
      onClick={() => {
        // A click is explicit, so the inspector follows it at once rather than after the settle delay.
        store.setSpyTarget(deliverable.id);
        store.setSettledTarget(deliverable.id, { immediate: true });
        if (store.pinnedTarget.value) store.setPinnedTarget(deliverable.id);
      }}
    >
      <span class="fabry-spec-sec-n">{displayTitle(deliverable)}</span>
      <CheckBadge result={result} />
    </div>
  );
}

// Refine and History, shown at DOCUMENT width above their own section (spec 2026-08-19 §6): a word
// diff in a 322px rail is unreadable, and the width is here. The rail points at this while it is up
// rather than mounting a second copy — HistoryPanel's selection is a shared signal, so two copies
// would fight over it. Escape closes it (the keydown effect in SpecView); so does this bar's button
// and the rail's "Bring it back".
function ReviewHost({ deliverable, kind }: { deliverable: Deliverable; kind: string }) {
  return (
    <div class="fabry-spec-review">
      <div class="fabry-spec-review-bar">
        <span class="fabry-spec-review-t">{kind === 'refine' ? 'Refine' : 'Version history'}</span>
        <span class="fabry-spec-sp" />
        <button
          type="button"
          class="fabry-spec-btn"
          data-act="review-close"
          title="Close — it stays available in the inspector"
          onClick={() => store.setReviewTarget(null)}
        >{'✕ Close'}</button>
      </div>
      <div class="fabry-spec-review-body">
        {kind === 'refine'
          ? <RefineDock deliverable={deliverable} />
          : <HistoryPanel deliverable={deliverable} />}
      </div>
    </div>
  );
}

export default function SpecView() {
  const ds = store.deliverables.value;
  const mode = store.docView.value;
  const [note, setNote] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<any[]>([]);
  const docRef = useRef<any>(null);
  const rafRef = useRef(0);
  // Switching mode unmounts one column and mounts another, so the new scroller starts at the top —
  // which reads as the document jumping away (owner, 2026-08-19: "no layout shift when switching the
  // modes"). The deliverable being read is remembered here and restored, instantly, the moment the new
  // column reports itself.
  const restoreRef = useRef<any>(null);
  const modeRef = useRef(mode);
  if (modeRef.current !== mode) {
    restoreRef.current = store.pinnedTarget.value || store.settledTarget.value || store.spyTarget.value;
    modeRef.current = mode;
  }

  // One slug per deliverable, assigned exactly as the print path and the export used to: the slug is
  // how a cross-document reference addresses a deliverable, and now also its id namespace.
  const slugKey = ds.map((d) => `${d.id}\x00${displayTitle(d)}`).join('\x01');
  const slugs = useMemo(() => assignSlugs(ds, displayTitle), [slugKey]);
  const sections = useMemo(
    () => ds.map((d) => ({ id: d.id, slug: slugs.get(d.id) || d.id, text: d.text || '' })),
    [ds, slugs],
  );
  const byId = useMemo(() => new Map(ds.map((d) => [d.id, d])), [ds]);

  // The sidebar navigates the one document. It passes the deliverable id so a heading slug that two
  // deliverables share resolves inside the right one.
  useEffect(() => {
    store.setOutlineNavigator((slug: any, docId: any) => {
      const api = docRef.current;
      if (!api) return;
      // No slug = "take me to this deliverable" (a sidebar row); a slug = one of its headings.
      if (docId) { store.setSpyTarget(docId); store.setSettledTarget(docId, { immediate: true }); }
      if (!slug && docId) { api.scrollToDeliverable(docId); return; }
      // Preview resolves by id prefix, Edit by deliverable id — both need to know WHICH document's
      // heading was clicked, so it travels in the shared options argument.
      api.scrollToSlug(slug, docId ? prefixFor(slugs.get(docId) || '') : '', { docId });
    });
    return () => store.setOutlineNavigator(null);
  }, [slugs]);

  // Scroll spy: which deliverable the rail shows, and which heading the list highlights. Measured
  // from the DOM (jsdom has no layout), decided by the pure rules in specTarget.js.
  //
  // The column hands its own live API in, rather than this component reaching for a ref: a mode
  // switch builds a new scroller, and a listener bound here on stale deps kept listening to the
  // destroyed one (measured in a browser — the spy stopped working after one switch).
  function onScroll(api: any) {
    if (!api) return;
    if (restoreRef.current) {
      const id = restoreRef.current;
      restoreRef.current = null;
      api.scrollToDeliverable(id, { instant: true });
    }
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const top = api.scroller ? api.scroller.scrollTop : 0;
      const id = currentSection(api.sectionTops(), top);
      if (id) { store.setSpyTarget(id); store.setSettledTarget(id); }
      const head = activeHeadingAt(api.headingTops(), top);
      if (head) store.setActiveHeading(head.slug);
    });
  }

  useEffect(() => {
    const onKey = (e: any) => { if (e.key === 'Escape' && store.reviewTarget.value) store.setReviewTarget(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  const review = store.reviewTarget.value;
  const headerFor = (s: any) => {
    const d = byId.get(s.id);
    if (!d) return null;
    return (
      <Fragment>
        <SectionHeader deliverable={d} />
        {review && review.id === s.id ? <ReviewHost deliverable={d} kind={review.kind} /> : null}
      </Fragment>
    );
  };

  return (
    <div class="fabry-spec">
      <div class="fabry-spec-bar">
        <span class="fabry-spec-lbl">Specification</span>
        <div class="fabry-spec-modes fabry-arch-viewtoggle" role="group" aria-label="Text mode">
          <button type="button" aria-pressed={mode === 'edit'} title="Markdown source" onClick={() => store.setDocView('edit')}>{'✎ Edit'}</button>
          <button type="button" aria-pressed={mode === 'preview'} title="Rendered document — the mode Cmd+F searches" onClick={() => store.setDocView('preview')}>{'◑ Preview'}</button>
        </div>
        <span class="fabry-spec-sp" />
        <button
          type="button"
          class="fabry-spec-btn"
          data-act="pdf"
          disabled={note === 'busy' || !ds.length}
          title="Print, or save as PDF"
          onClick={() => openPdfFlow(
            ds.find((d) => d.id === (store.pinnedTarget.value || store.settledTarget.value)) || ds[0],
            { onNote: setNote, onWarnings: (w) => setWarnings((prev) => [...w, ...prev]) },
          )}
        >{note === 'busy' ? 'Preparing…' : '⤓ PDF'}</button>
        <button
          type="button"
          class="fabry-spec-btn"
          data-act="toggle-rail"
          aria-pressed={store.railOpen.value}
          title={store.railOpen.value ? 'Hide the inspector' : 'Show the inspector'}
          onClick={() => store.setRailOpen(!store.railOpen.value)}
        >{store.railOpen.value ? '⇥ Inspector' : '⇤ Inspector'}</button>
      </div>
      {(warnings.length > 0 || (note && note !== 'busy')) && (
        <div class="fabry-arch-doc-warn">
          {note && note !== 'busy' && <div class="fabry-arch-doc-note">{note}</div>}
          {warnings.map((w, i) => <div key={i}>{w}</div>)}
          <button
            type="button"
            class="fabry-arch-doc-warn-x"
            aria-label="Dismiss"
            onClick={() => { setWarnings([]); setNote(null); }}
          >{'×'}</button>
        </div>
      )}
      {mode === 'preview' ? (
        <DocView
          sections={sections}
          headerFor={headerFor}
          docRef={docRef}
          onScroll={onScroll}
          domain={fstore.domain.value}
          token={fstore.token.value}
          resolveDoc={(slug) => {
            const hit = ds.find((d) => (slugs.get(d.id) || d.id) === slug);
            return hit ? { title: displayTitle(hit), text: hit.text || '' } : null;
          }}
          onNavigate={(slug) => {
            const hit = ds.find((d) => (slugs.get(d.id) || d.id) === slug);
            if (hit) store.navigateOutline(slugs.get(hit.id), hit.id);
          }}
        />
      ) : (
        <SourceColumn sections={sections} headerFor={headerFor} docRef={docRef} onScroll={onScroll} />
      )}
    </div>
  );
}

// Edit mode. The same chrome as Preview — the switch changes only how the text renders — with every
// deliverable in an editor of its own, visible immediately (owner, 2026-08-19). No click-to-activate and
// no swap, so nothing shifts under the reader.
//
// Real CodeMirror per section, because the owner wants Markdown highlighting while editing. MEASURED
// that this is affordable: five 700-line editors mount in 70ms, none of them scrolls internally, and
// only the visible lines are rendered.
export function SourceColumn({
  sections, headerFor, docRef, onScroll,
}: {
  sections: SourceSection[];
  headerFor?: (s: any) => any;
  docRef?: { current: any };
  onScroll?: (info: any) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const views = useRef(new Map());     // deliverable id -> EditorView, for exact line geometry
  const pending = useRef(new Map());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // One timer for the column, a pending value PER deliverable: every section is editable at once, so a
  // single slot would drop an edit the moment the reader moved to another field.
  function flush() {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const edits = [...pending.current.entries()];
    pending.current.clear();
    for (const [id, text] of edits) updateDeliverable(id, text);
  }
  useEffect(() => flush, []);
  function onEdit(id: any, text: any) {
    pending.current.set(id, text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; flush(); }, 600);
  }

  // Navigation and the spy behave exactly as in Preview, which is what the deliverable list expects. A
  // heading here is a source LINE, and CodeMirror knows exactly where a line sits — `lineBlockAt` is
  // wrapping-aware, so nothing has to be estimated. Cached on the scroller's scrollHeight, like
  // DocView's geometry.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    let geo: any = null;
    let geoHeight = -1;
    const readGeo = () => {
      if (geo && root.scrollHeight === geoHeight) return geo;
      geoHeight = root.scrollHeight;
      const rootTop = root.getBoundingClientRect().top;
      const secs = [...root.querySelectorAll<HTMLElement>('[data-deliverable]')];
      const headings = [];
      for (const el of secs) {
        const id = el.dataset.deliverable;
        const view = views.current.get(id);
        const text = (sections.find((x) => x.id === id) || {}).text || '';
        if (!view) continue;
        // The editor's own top in scroll space, plus CodeMirror's exact offset for the line.
        const base = root.scrollTop + (view.dom.getBoundingClientRect().top - rootTop);
        for (const e of extractOutline(text)) {
          try {
            const line = view.state.doc.line(Math.min(view.state.doc.lines, e.line + 1));
            headings.push({ docId: id, slug: e.slug, top: base + view.lineBlockAt(line.from).top });
          } catch { /* a document edited out from under the outline: skip that entry */ }
        }
      }
      geo = {
        // From RECTS, like DocView's own geometry: `offsetTop` measures against whichever ancestor
        // happens to be the offsetParent (here `.docs-pane`, which today shares the scroller's top
        // edge — verified equal, 4393 == 4393), so any padding added above `.docs-root` would shift
        // every jump by that much with nothing to point at.
        sections: secs.map((el) => ({
          id: el.dataset.deliverable,
          slug: el.dataset.slug || '',
          top: root.scrollTop + (el.getBoundingClientRect().top - rootTop),
        })),
        headings,
      };
      return geo;
    };
    const invalidate = () => { geo = null; };
    window.addEventListener('resize', invalidate);

    // Landing EXACTLY, on a column of virtualised editors. CodeMirror estimates the height of lines
    // it has not rendered and the estimate assumes one visual line, so the arithmetic target moves as
    // the trip there renders the region — MEASURED on a five-document fixture: a jump to the third
    // deliverable computed 4725 while the section settled at 5153, landing 428px short. The element's
    // live rect is the only truth once it is rendered, so the tween gets it close and up to three
    // corrections close the gap. `seq` makes a newer jump win, so a correction can never yank a reader
    // who has already clicked somewhere else. (This is the section-level twin of scrollLineIntoView.)
    let seq = 0;
    const topOf = (el: any) => root.scrollTop + (el.getBoundingClientRect().top - root.getBoundingClientRect().top);
    const settle = (el: any, mine: any, left: any) => {
      if (mine !== seq || left <= 0) return;
      const delta = topOf(el) - root.scrollTop;
      if (Math.abs(delta) <= 2) return;
      root.scrollTop += delta;
      requestAnimationFrame(() => settle(el, mine, left - 1));
    };
    const jumpToEl = (el: any, { instant = false } = {}) => {
      if (!el) return false;
      const mine = ++seq;
      const y = Math.max(0, topOf(el));
      if (instant) { root.scrollTop = y; requestAnimationFrame(() => settle(el, mine, 3)); return true; }
      animateScrollTop(root, y, { duration: SCROLL_MS });
      setTimeout(() => settle(el, mine, 3), SCROLL_MS + 30);
      return true;
    };
    const api = {
      scroller: root,
      sectionTops: () => readGeo().sections,
      headingTops: () => readGeo().headings,
      scrollToDeliverable: (id: any, opts: any) => jumpToEl(
        [...root.querySelectorAll<HTMLElement>('[data-deliverable]')].find((el) => el.dataset.deliverable === id),
        opts,
      ),
      scrollToSlug: (slug: any, _prefix: any, opts: { docId?: string } = {}) => {
        // Which deliverable owns this heading, and on which source line.
        //
        // The deliverable the reader clicked in is tried FIRST, because a slug alone is ambiguous:
        // two deliverables may legitimately carry the same heading, and `## 2. Scope` in both slugs
        // to `2-scope` in both (measured — a plain scan landed inside the first document while the
        // reader had clicked the second). Preview disambiguates with the id prefix; in source the
        // id itself is the answer, so it travels in the options.
        const ordered = opts.docId
          ? [...sections.filter((x) => x.id === opts.docId), ...sections.filter((x) => x.id !== opts.docId)]
          : sections;
        for (const sec of ordered) {
          const entry = extractOutline(sec.text || '').find((e) => e.slug === slug);
          if (!entry) continue;
          const view = views.current.get(sec.id);
          if (!view) return false;
          const moved = scrollLineIntoView(view, entry.line, root);
          invalidate();
          return moved;
        }
        return false;
      },
    };
    if (docRef) docRef.current = api;
    const fire = () => { if (onScroll) onScroll(api); };
    root.addEventListener('scroll', fire, { passive: true });
    fire();
    return () => {
      root.removeEventListener('scroll', fire);
      window.removeEventListener('resize', invalidate);
    };
  }, [sections]);

  return (
    <div class="docs-pane">
      <div class="docs-root" ref={rootRef}>
        {sections.map((s) => (
          <section key={s.id} class="docs-section" data-deliverable={s.id} data-slug={s.slug}>
            {headerFor ? headerFor(s) : null}
            {/* `markdown-body` for its BOX only — max-width, centring and upstream's own narrow-column
                padding branch — so Edit and Preview occupy the same column. */}
            <div class="markdown-body fabry-spec-edit">
              <SourceEditor
                text={s.text}
                onChange={(t) => onEdit(s.id, t)}
                viewRef={{
                  get current() { return views.current.get(s.id) || null; },
                  set current(v) { if (v) views.current.set(s.id, v); else views.current.delete(s.id); },
                }}
              />
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
