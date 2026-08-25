// Ported from localpages@4d43f26 `src/client/section-preview.js` (sha1 dc90a3fb…).
//
// Section-reference hover preview.
// For same-page anchor links (href="#foo") whose target is a heading, show a
// floating card after a short hover delay. The card contains the target heading
// plus the following sibling blocks up to the next same-or-higher-level heading
// (capped by block count so very long sections don't fill the viewport). Click
// behaviour is untouched — the link still scrolls to the target; the card also
// has an explicit "Jump to section" footer.
//
// Deltas: `initSectionPreview(root, scroller)` instead of an IIFE over document;
// positioning is viewport-relative (theme.css DELTA F explains why that is
// behaviour-preserving); the scroll-dismiss listener attaches to the given scroller;
// and a teardown is returned. Every timing and cap is upstream's.
// opts.resolveExternal(href) -> { body, headingId, title } | null, and opts.onOpenExternal(href).
// Upstream's card previews SAME-PAGE sections only, because a localpages page is one file.
// A specification here is many deliverables, so "reference another section" usually means
// another deliverable — that resolver is what makes those hoverable too (owner, 2026-08-18).
import { resolveHeadingElement } from '../anchorResolve.js';

/** Everything the hover card needs injected. */
export type SectionPreviewOptions = {
  /** href -> the rendered body of another deliverable's section, or null. */
  resolveExternal?: ((href: string) => any) | null;
  onOpenExternal?: ((href: string) => void) | null;
  [key: string]: any;
};

export function initSectionPreview(
  root: HTMLElement, scroller: HTMLElement | null, opts?: SectionPreviewOptions,
): () => void {
  var options = opts || {};
  var resolveExternal = options.resolveExternal || null;
  var onOpenExternal = options.onOpenExternal || null;
  var HOVER_DELAY_MS = 280;
  var HIDE_DELAY_MS  = 160;
  var MAX_BLOCKS     = 8;

  var doc = root.ownerDocument || document;
  var win = doc.defaultView || window;
  var isWindow = (scroller as unknown) === win;

  var card: HTMLElement | null = null;
  // `setTimeout`'s handle is a number in the browser and an opaque object in Node. The
  // test program loads @types/node for the meta-guards, so both overloads are in scope
  // there; ReturnType keeps this one spelling correct under either. Same idiom as
  // JsonEditor.tsx's validChangeTimer.
  var showTimer: ReturnType<typeof setTimeout> | null = null;
  var hideTimer: ReturnType<typeof setTimeout> | null = null;
  var activeLink: HTMLElement | null = null;

  function ensureCard() {
    if (card) return card;
    card = doc.createElement('div');
    card.className = 'section-preview markdown-body';
    card.innerHTML = '<div class="section-preview-from" hidden></div>' +
                     '<div class="section-preview-body"><div class="section-preview-inner"></div></div>' +
                     '<a class="section-preview-jump" href="#">Jump to section ↗</a>';
    card.addEventListener('mouseenter', function() { clearTimeout(hideTimer!); });
    card.addEventListener('mouseleave', scheduleHide);
    card.querySelector('.section-preview-jump')!.addEventListener('click', onJump);
    doc.body.appendChild(card);
    return card;
  }

  function isHeading(el: Element | null) {
    return el && /^H[1-6]$/.test(el.tagName);
  }

  function collectSection(targetHeading: Element): Node[] {
    var level = parseInt(targetHeading.tagName.slice(1), 10);
    var parts = [targetHeading.cloneNode(true)];
    var el = targetHeading.nextElementSibling;
    var n = 0;
    while (el && n < MAX_BLOCKS) {
      if (isHeading(el) && parseInt(el.tagName.slice(1), 10) <= level) break;
      parts.push(el.cloneNode(true));
      n++;
      el = el.nextElementSibling;
    }
    return parts;
  }

  // A cross-document link with no fragment previews the document's opening instead of
  // nothing — the useful answer to "what is in there".
  function collectStart(bodyEl: Element): Node[] {
    var parts = [];
    var el = bodyEl.firstElementChild;
    var n = 0;
    while (el && n < MAX_BLOCKS) { parts.push(el.cloneNode(true)); n++; el = el.nextElementSibling; }
    return parts;
  }

  function populate(c: HTMLElement, parts: Node[], href: string, from: string | null) {
    var inner = c.querySelector('.section-preview-inner');
    inner!.innerHTML = '';
    parts.forEach(function(p: any) {
      // Strip anchor permalinks from cloned headings so they don't render as
      // orphaned "#" marks inside the popup.
      p.querySelectorAll('.anchor').forEach(function(a: Element) { a.remove(); });
      inner!.appendChild(p);
    });
    var fromEl = c.querySelector('.section-preview-from') as HTMLElement | null;
    if (from) {
      // Say which document this is, or the reader cannot tell a quotation from their own
      // text — the one thing a cross-document preview must not leave ambiguous.
      fromEl!.textContent = from;
      fromEl!.hidden = false;
    } else {
      fromEl!.textContent = '';
      fromEl!.hidden = true;
    }
    var jump = c.querySelector('.section-preview-jump') as HTMLElement;
    jump.setAttribute('href', href);
    jump.textContent = from ? 'Open ' + from + ' ↗' : 'Jump to section ↗';
  }

  function positionCard(link: HTMLElement, c: HTMLElement) {
    var lr = link.getBoundingClientRect();
    var cr = c.getBoundingClientRect();
    var margin = 8;
    var vw = win.innerWidth;
    var vh = win.innerHeight;
    var left = lr.left;
    var maxLeft = vw - cr.width - margin;
    if (left > maxLeft) left = maxLeft;
    if (left < margin) left = margin;
    var below = lr.bottom + margin;
    var above = lr.top - cr.height - margin;
    var top;
    if (below + cr.height <= vh || above < 0) {
      top = lr.bottom + margin;
    } else {
      top = lr.top - cr.height - margin;
    }
    c.style.left = Math.round(left) + 'px';
    c.style.top  = Math.round(top) + 'px';
  }

  // Scoped to the rendered root (a Console-page id must never answer a document's fragment) and
  // forgiving about the form: `#2.1` finds "2.1 Entities" even though its id is `21-entities`.
  function targetFor(href: string) {
    return resolveHeadingElement(root, href.slice(1));
  }

  function showFor(link: HTMLElement) {
    var href = link.getAttribute('href');
    if (!href) return;
    var parts = null;
    var from = null;
    if (href.charAt(0) === '#') {
      if (href.length < 2) return;
      var target = targetFor(href);
      if (!isHeading(target)) return;
      parts = collectSection(target!);
    } else {
      var ext = resolveExternal && resolveExternal(href);
      if (!ext || !ext.body) return;
      var head = ext.headingId ? resolveHeadingElement(ext.body, ext.headingId) : null;
      parts = isHeading(head) ? collectSection(head!) : collectStart(ext.body);
      if (!parts.length) return;
      from = ext.title || null;
    }
    var c = ensureCard();
    populate(c, parts, href, from);
    c.classList.add('open');
    positionCard(link, c);
  }

  function scheduleShow(link: HTMLElement) {
    clearTimeout(showTimer!);
    clearTimeout(hideTimer!);
    showTimer = setTimeout(function() { showFor(link); }, HOVER_DELAY_MS);
  }
  function scheduleHide() {
    clearTimeout(showTimer!);
    clearTimeout(hideTimer!);
    hideTimer = setTimeout(function() {
      if (card) card.classList.remove('open');
      activeLink = null;
    }, HIDE_DELAY_MS);
  }
  function hideNow() {
    clearTimeout(showTimer!);
    clearTimeout(hideTimer!);
    if (card) card.classList.remove('open');
    activeLink = null;
  }
  // The footer link is a fragment; in the pane it has to scroll the pane's own
  // scroller rather than navigate the extension page (same reason as toc.js).
  function onJump(e: Event) {
    var href = (e.currentTarget as Element).getAttribute('href') || '';
    hideNow();
    if (href && href.charAt(0) !== '#' && onOpenExternal) {
      e.preventDefault();
      onOpenExternal(href);
      return;
    }
    if (isWindow || href.charAt(0) !== '#') return;
    var target = targetFor(href);
    if (!target) return;
    e.preventDefault();
    target.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function eligible(link: Element | null) {
    if (!link) return false;
    if (link.classList.contains('anchor')) return false;
    if (link.closest('.toc')) return false;
    if (link.closest('.section-preview')) return false;
    var href = link.getAttribute('href');
    if (!href) return false;
    if (href.charAt(0) === '#') return href.length >= 2 && isHeading(targetFor(href));
    // Anything with a scheme is an outside link; the resolver decides about the rest.
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return false;
    return !!(resolveExternal && resolveExternal(href));
  }

  // The unified specification view has one `.markdown-body` PER DELIVERABLE (2026-08-19), so
  // listeners bind at the root and events bubble up from whichever section they happened in. With a
  // single body this is identical to what it replaced, and DocView is the only caller.
  var body = root;
  if (!body) return function () {};

  function onOver(e: Event) {
    var link = (e.target as Element).closest('a');
    if (!eligible(link)) return;
    if (link === activeLink) return;
    activeLink = link;
    scheduleShow(link!);
  }
  function onOut(e: Event) {
    var link = (e.target as Element).closest('a');
    if (!link || link !== activeLink) return;
    if (card && card.contains((e as MouseEvent).relatedTarget as Node)) return;
    scheduleHide();
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') hideNow();
  }
  // Page scroll dismisses the card — re-positioning relative to the link while
  // the page scrolls would feel unstable. But if the pointer is currently over
  // the card, the user is likely scrolling its own contents, so leave it alone.
  function onScroll() {
    if (!card || !card.classList.contains('open')) return;
    if (card.matches(':hover')) return;
    hideNow();
  }

  body.addEventListener('mouseover', onOver);
  body.addEventListener('mouseout', onOut);
  doc.addEventListener('keydown', onKey);
  var scrollTarget = isWindow ? win : scroller;
  scrollTarget!.addEventListener('scroll', onScroll, { passive: true });

  return function destroy() {
    body.removeEventListener('mouseover', onOver);
    body.removeEventListener('mouseout', onOut);
    doc.removeEventListener('keydown', onKey);
    scrollTarget!.removeEventListener('scroll', onScroll);
    hideNow();
    if (card) { card.remove(); card = null; }
  };
}
