// Allowlist sanitizer for rendered deliverable HTML (spec 2026-08-17, D9).
//
// localpages runs markdown-it with `html: true` and drops the result straight into
// a page, which is right for a tool that renders .md files you wrote on your own
// machine. Deliverable text has FOUR writers — the SA, the agent (RefineDock's
// accept() writes a refine proposal straight in), any holder of an org token writing
// the Data Storage collection, and this extension's own MDH record editor — and the
// EXPORTED html carries no CSP at all (measured), so the same output would execute
// in whoever opens the ZIP. `html: true` still has to stay on: <state-label>,
// <details>/<summary>, <mark> and <div class="wide"> are all raw HTML.
//
// Allowlist, not denylist: markdown-it's output plus those four constructs is a
// finite set, so there is no reason to accept the weaker policy.
//
// Pure apart from needing a DOMParser (browser and jsdom both have one).
//
// ONE honest limit on "byte-identical to localpages": passing HTML through the DOM
// re-serializes it, so `&#x27;` comes back as `'` and `<circle/>` as
// `<circle></circle>`. Semantically and visually identical, not byte-identical — the
// RENDERER's output is byte-identical (tests/docs-render-equivalence.test.js), and the
// sanitizer provably changes nothing beyond a round-trip
// (tests/docs-sanitize.test.js § idempotence).

const ALLOWED = new Set([
  // markdown-it's own output, wrapStandaloneImages included
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'em', 'strong', 's', 'del', 'ins',
  'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'hr', 'br', 'img',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'figure', 'figcaption',
  // the raw-HTML constructs localpages documents, plus inert text-level helpers
  'details', 'summary', 'mark', 'div', 'span', 'kbd', 'sup', 'sub', 'abbr',
  'dl', 'dt', 'dd', 'caption', 'colgroup', 'col',
]);

// Elements whose CHILDREN are not prose — unwrapping these would leak code or
// attribute soup into the document, so they are removed outright.
const HARD_DELETE = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'textarea',
  'select', 'option', 'button', 'link', 'meta', 'base', 'noscript', 'frame', 'frameset',
]);

const ATTRS = new Set([
  'class', 'id', 'href', 'src', 'alt', 'title', 'align', 'colspan', 'rowspan',
  'open', 'start', 'type', 'width', 'height', 'span', 'reversed', 'value', 'lang', 'dir',
  // markdown-it-anchor puts tabindex="-1" on EVERY heading. Omitting it silently
  // changed every heading in the output — caught by the fixture-idempotence test
  // below, which is why that test compares against upstream's real HTML rather than
  // a hand-written sample.
  'tabindex',
]);

const SVG_NS = 'http://www.w3.org/2000/svg';

// `javascript:`/`vbscript:`/`data:` (other than images) can all execute or smuggle;
// everything else that is a bare scheme is rejected too, since the only schemes a
// document needs are http(s) and the implicit relative one.
function safeHref(value) {
  const v = String(value || '').trim();
  if (!v) return false;
  if (v.startsWith('#')) return true;                       // in-document anchor
  if (/^https?:\/\//i.test(v)) return true;
  if (/^mailto:/i.test(v)) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return false;         // any other scheme
  if (v.startsWith('//')) return false;                     // protocol-relative
  return true;                                              // relative path
}

function safeSrc(value) {
  const v = String(value || '').trim();
  if (!v) return false;
  if (/^https?:\/\//i.test(v)) return true;
  if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);/i.test(v)) return true;  // D8 inlining
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return false;
  if (v.startsWith('//')) return false;
  return true;
}

function scrubAttrs(el, inSvg) {
  for (const attr of [...el.attributes]) {
    const name = attr.name.toLowerCase();
    // Event handlers are rejected everywhere, SVG subtrees included.
    if (name.startsWith('on')) { el.removeAttribute(attr.name); continue; }
    if (name === 'href' || name === 'xlink:href') {
      if (!safeHref(attr.value)) el.removeAttribute(attr.name);
      continue;
    }
    if (name === 'src') {
      if (!safeSrc(attr.value)) el.removeAttribute(attr.name);
      continue;
    }
    // Inside an <svg> everything else is allowed — see the class comment on clean().
    if (inSvg) continue;
    if (name.startsWith('data-') || name.startsWith('aria-') || name === 'role') continue;
    if (name === 'style') continue;  // inline CSS cannot execute; upstream renders it
    if (!ATTRS.has(name)) el.removeAttribute(attr.name);
  }
}

// Inside an <svg> subtree everything is allowed except on* handlers, <script> and
// unsafe URLs. That is what lets render.js's mermaid fence override stay verbatim:
// mermaid emits an SVG carrying its own <style>, into which highlightTodoInSvg
// injects the .todo-hl rule, and every state-label badge is an inline SVG icon with
// stroke-dasharray/paint-order/tspan geometry. Enumerating that attribute surface
// would be a fragile allowlist over machine-generated markup; both producers are
// ours instead (and beautiful-mermaid escapes label text itself).
function clean(parent, inSvg) {
  for (const child of [...parent.childNodes]) {
    if (child.nodeType !== 1) continue;   // text and comments ride along, as upstream
    const tag = (child.localName || '').toLowerCase();
    const svgHere = inSvg || tag === 'svg' || child.namespaceURI === SVG_NS;

    if (svgHere) {
      if (tag === 'script' || tag === 'foreignobject') { child.remove(); continue; }
      scrubAttrs(child, true);
      clean(child, true);
      continue;
    }
    if (HARD_DELETE.has(tag)) { child.remove(); continue; }
    if (!ALLOWED.has(tag)) {
      // Unwrap, don't delete: the children are prose, and silently swallowing prose
      // is the failure mode this port can least afford. An unknown element degrades
      // to its text content instead of vanishing with everything inside it.
      clean(child, false);
      while (child.firstChild) parent.insertBefore(child.firstChild, child);
      child.remove();
      continue;
    }
    scrubAttrs(child, false);
    clean(child, false);
  }
}

function parse(html, DP) {
  const Impl = DP || (typeof DOMParser !== 'undefined' ? DOMParser : null);
  if (!Impl) throw new Error('sanitize needs a DOMParser');
  return new Impl().parseFromString(String(html ?? ''), 'text/html');
}

// Returns the sanitized <body> of a DETACHED document. Callers either read
// .innerHTML (export) or importNode its children (the live pane).
export function sanitizeBody(html, { DOMParserImpl } = {}) {
  const doc = parse(html, DOMParserImpl);
  clean(doc.body, false);
  return doc.body;
}

export function sanitizeHtml(html, opts) {
  return sanitizeBody(html, opts).innerHTML;
}

// Live-pane link policy. Not a security control — a hygiene one: this document is
// rendered INSIDE the Console, so a plain click on an http link or a relative
// `other.md` would navigate the whole app away and destroy the session. External
// links get the same treatment FabryMarkdown already gives them; relative ones are
// left for DocView's click handler to resolve to a sibling deliverable.
export function markLinksForPane(body) {
  for (const a of body.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }
  }
  return body;
}

