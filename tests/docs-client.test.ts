// @vitest-environment jsdom
// The four ported client behaviours (spec 2026-08-17 §3).
//
// The TOC block ports upstream's test/toc.test.mjs, which drives real headless Chrome
// via --dump-dom. Here the same four assertions run against the same module in jsdom —
// they only inspect DOM the module BUILDS, which jsdom can do faithfully. What jsdom
// cannot answer is scroll-spy geometry (it has no layout), so that stays a browser
// check outside `npm test`, following this repo's stageLink/tether precedent.
import { describe, it, expect, beforeEach, vi } from 'vitest';
// jsdom implements neither of these; Chrome (where the ported code runs) implements
// both, so they are stubbed here rather than guarded in the port — the same approach
// this suite already takes for requestAnimationFrame elsewhere.
if (!window.Element.prototype.scrollIntoView)
  window.Element.prototype.scrollIntoView = function () {};
import { createMarkdownRenderer, wrapStandaloneImages } from '../src/docs/render.js';
import { sanitizeBody } from '../src/docs/sanitize.js';
import { initCodeCopy } from '../src/docs/client/codeCopy.js';
import { initSectionPreview } from '../src/docs/client/sectionPreview.js';
import { initSourceViewer } from '../src/docs/client/sourceViewer.js';
import { formatResource, splitResourceView, withResourceView } from '../src/docs/resources.js';

// Upstream's fixture, verbatim from test/toc.test.mjs.
const SRC = [
  '# Solution',
  '',
  '## 3. Architecture',
  '',
  '<state-label state="stale" date="2026-08-17" />',
  '',
  'Body.',
  '',
  '## 4. Operations',
  '',
  'No label here.',
  '',
].join('\n');

// Mount a rendered document the way DocView does: .docs-pane > .docs-root > .markdown-body
function mountDoc(src: any) {
  const pane = document.createElement('div');
  pane.className = 'docs-pane';
  const root = document.createElement('div');
  root.className = 'docs-root';
  const main = document.createElement('main');
  main.className = 'markdown-body';
  root.appendChild(main);
  pane.appendChild(root);
  document.body.appendChild(pane);
  const md = createMarkdownRenderer();
  const body = sanitizeBody(wrapStandaloneImages(md.render(src, {})));
  for (const node of [...body.childNodes]) main.appendChild(document.importNode(node, true));
  return { pane, root, main };
}

// Mount raw HTML (not our pipeline). Needed for the state-dot assertions: Architect
// documents no longer carry `<state-label>` badges — states moved to the deliverable
// header — so those tests exercise the PORTED behaviour against upstream-shaped markup,
// which is what stops a future tidy-up of toc.js from quietly dropping it.
function mountHtml(inner: any) {
  const pane = document.createElement('div');
  pane.className = 'docs-pane';
  const root = document.createElement('div');
  root.className = 'docs-root';
  root.innerHTML = '<main class="markdown-body">' + inner + '</main>';
  pane.appendChild(root);
  document.body.appendChild(pane);
  return { pane, root };
}

const BADGED =
  '<h2 id="3-architecture" tabindex="-1" class="has-state-label">3. Architecture' +
  '<span class="state-label state-stale" data-state="stale">' +
  '<svg class="state-label-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"></svg>' +
  '<span class="state-label-text">Stale</span><span class="state-label-date">2026-08-17</span></span></h2>' +
  '<p>Body.</p><h2 id="4-operations" tabindex="-1">4. Operations</h2><p>No label here.</p>';

beforeEach(() => {
  document.body.replaceChildren();
});

describe('code copy', () => {
  it('adds one button per fenced block, scoped to the document', () => {
    const { root } = mountDoc('```json\n{"a":1}\n```\n\ntext\n\n```\nplain\n```\n');
    initCodeCopy(root);
    expect(root.querySelectorAll('.markdown-body pre .code-copy-btn').length).toBe(2);
    expect(root.querySelector('.code-copy-btn')!.getAttribute('aria-label')).toBe(
      'Copy code to clipboard',
    );
  });

  it('copies the block text and flashes, falling back outside a secure context', async () => {
    const { root } = mountDoc('```\nhello\n```\n');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    initCodeCopy(root);
    const btn = root.querySelector<HTMLElement>('.code-copy-btn')!;
    btn.click();
    expect(writeText).toHaveBeenCalledWith('hello\n');
    await Promise.resolve();
    expect(btn.textContent).toBe('Copied!');
    expect(btn.classList.contains('copied')).toBe(true);
  });
});

describe('section preview', () => {
  it('opens a card for an in-document heading link after the hover delay, and Escape closes it', () => {
    vi.useFakeTimers();
    const { root } = mountDoc(
      '# T\n\n[jump](#section-a)\n\n## Section A\n\nBody of A.\n\n## Section B\n\nB.\n',
    );
    const off = initSectionPreview(root, root);
    const link = root.querySelector('a[href="#section-a"]');
    link!.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
    vi.advanceTimersByTime(300); // HOVER_DELAY_MS = 280, upstream's value
    const card = document.querySelector('.section-preview')!;
    expect(card).toBeTruthy();
    expect(card.classList.contains('open')).toBe(true);
    expect(card.textContent).toMatch(/Section A/);
    expect(card.textContent).toMatch(/Body of A/);
    expect(card.textContent).not.toMatch(/Section B/); // stops at the next same-level heading
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(card.classList.contains('open')).toBe(false);
    off();
    expect(document.querySelector('.section-preview')).toBeNull();
    vi.useRealTimers();
  });

  it('ignores links whose target is not a heading', () => {
    vi.useFakeTimers();
    const { root } = mountDoc('# T\n\n[nope](#nothing)\n\n## A\n\nx\n');
    initSectionPreview(root, root);
    root
      .querySelector('a[href="#nothing"]')!
      .dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
    vi.advanceTimersByTime(300);
    expect(document.querySelector('.section-preview')).toBeNull();
    vi.useRealTimers();
  });
});

describe('source viewer', () => {
  const ORIGIN = 'https://example-org.rossum.app';

  function withModal() {
    const overlay = document.createElement('div');
    overlay.className = 'source-overlay';
    overlay.id = 'srcOverlay';
    overlay.innerHTML =
      '<div id="srcTitle"></div><div id="srcPath"></div>' +
      '<button id="srcCopy">Copy</button><button id="srcClose">x</button><pre><code id="srcCode"></code></pre>';
    document.body.appendChild(overlay);
    return overlay;
  }

  it('marks resource links, opens the modal on click, and resolves via the injected fetcher', async () => {
    const { root } = mountDoc(`Read [the hook](${ORIGIN}/api/v1/hooks/42) now.\n`);
    const overlay = withModal();
    const resolve = vi.fn().mockResolvedValue('{"id":42}');
    initSourceViewer(root, {
      isSourceLink: (href) => !!href && href.includes('/api/v1/'),
      keyFor: (href) => new URL(href).pathname,
      resolve,
      highlight: (t) => `<span class="hljs-attr">${t}</span>`,
    });
    const link = root.querySelector('a')!;
    expect(link.classList.contains('source-link')).toBe(true);
    expect(link.title).toBe('Click to preview this resource');
    const ev = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true); // never navigates away
    expect(overlay.classList.contains('open')).toBe(true);
    expect(document.getElementById('srcPath')!.textContent).toBe('/api/v1/hooks/42');
    expect(resolve).toHaveBeenCalledWith('/api/v1/hooks/42');
    await vi.waitFor(() =>
      expect(document.getElementById('srcCode')!.innerHTML).toMatch(/hljs-attr/),
    );
  });

  it('leaves ordinary links alone', () => {
    const { root } = mountDoc('A [normal link](https://example.test/page) here.\n');
    withModal();
    initSourceViewer(root, { isSourceLink: (href) => !!href && href.includes('/api/v1/') });
    const link = root.querySelector('a')!;
    expect(link.classList.contains('source-link')).toBe(false);
    const ev = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(document.getElementById('srcOverlay')!.classList.contains('open')).toBe(false);
  });
});

describe('source viewer — an extension is two files (definition + implementation)', () => {
  const ORIGIN = 'https://example-org.rossum.app';
  const HOOK = JSON.stringify({
    id: 42,
    name: 'Index doctor',
    config: { runtime: 'python3.12', code: 'def handler(p):\n    return p\n' },
  });
  const QUEUE = JSON.stringify({ id: 7, name: 'Invoices' });

  function withModal() {
    const overlay = document.createElement('div');
    overlay.className = 'source-overlay';
    overlay.id = 'srcOverlay';
    overlay.innerHTML =
      '<div id="srcTitle"></div><div id="srcPath"></div>' +
      '<div id="srcViews" hidden></div>' +
      '<button id="srcCopy">Copy</button><button id="srcClose">x</button><pre><code id="srcCode"></code></pre>';
    document.body.appendChild(overlay);
    return overlay;
  }
  const viewButtons = () => [
    ...document.getElementById('srcViews')!.querySelectorAll('.source-view-btn'),
  ];
  const labels = () => viewButtons().map((b) => b.textContent);
  const pressed = () =>
    viewButtons()
      .filter((b) => b.getAttribute('aria-pressed') === 'true')
      .map((b) => b.textContent);

  function mountHook(raw = HOOK) {
    const { root } = mountDoc(`Read [the hook](${ORIGIN}/api/v1/hooks/42) now.\n`);
    withModal();
    const resolve = vi.fn((key) =>
      Promise.resolve(formatResource(raw, splitResourceView(key).view)),
    );
    initSourceViewer(root, {
      isSourceLink: (href) => !!href && href.includes('/api/v1/'),
      keyFor: (href) => new URL(href).pathname,
      resolve,
      splitView: splitResourceView,
      withView: withResourceView,
    });
    return { root, resolve };
  }

  it('offers Code and Definition for a hook that has code, showing the code first', async () => {
    const { root, resolve } = mountHook();
    root
      .querySelector('a')!
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(viewButtons().length).toBe(2));
    expect(labels()).toEqual(['Code', 'Definition']);
    expect(pressed()).toEqual(['Code']);
    expect(document.getElementById('srcCode')!.textContent).toMatch(/def handler/);
    expect(resolve).toHaveBeenCalledWith('/api/v1/hooks/42');
  });

  it('switching to Definition shows the WHOLE hook — the defect this fixes', async () => {
    const { root, resolve } = mountHook();
    root
      .querySelector('a')!
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(viewButtons().length).toBe(2));
    (viewButtons()[1] as HTMLElement).click();
    await vi.waitFor(() =>
      expect(document.getElementById('srcCode')!.textContent).toMatch(/"name": "Index doctor"/),
    );
    expect(resolve).toHaveBeenLastCalledWith('/api/v1/hooks/42?view=json');
    expect(pressed()).toEqual(['Definition']);
    // the marker is ours and never shown to the reader
    expect(document.getElementById('srcPath')!.textContent).not.toMatch(/view=/);
    expect(document.getElementById('srcPath')!.textContent).toMatch(/^\/api\/v1\/hooks\/42/);
  });

  it('shows no switcher for a resource with only one view', async () => {
    const { root } = mountHook(QUEUE);
    root
      .querySelector('a')!
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await vi.waitFor(() =>
      expect(document.getElementById('srcCode')!.textContent).toMatch(/Invoices/),
    );
    expect(viewButtons()).toEqual([]);
    expect(document.getElementById('srcViews')!.hidden).toBe(true);
  });
});

describe('cross-deliverable preview', () => {
  // Upstream's card is same-page only, because a localpages page is one file. A
  // specification here is many deliverables, so "reference another section" usually means
  // another deliverable (owner, 2026-08-18) — the resolver is what makes those hoverable.
  const OTHER = () => {
    const body = document.createElement('div');
    body.innerHTML =
      '<h1 id="architecture">Architecture</h1><p>Intro of the other doc.</p>' +
      '<h2 id="queues">Queues</h2><p>Queue detail.</p><p>More queue detail.</p>' +
      '<h2 id="hooks">Hooks</h2><p>Hook detail.</p>';
    return body;
  };
  const resolveExternal = (href: any) => {
    if (!href.startsWith('architecture')) return null;
    const frag = href.split('#')[1] || '';
    return { body: OTHER(), headingId: frag, title: 'Architecture' };
  };

  function hover(root: any, selector: any) {
    vi.advanceTimersByTime(1);
    root
      .querySelector(selector)
      .dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
    vi.advanceTimersByTime(300); // upstream's 280ms hover delay
    return document.querySelector('.section-preview');
  }

  it('previews the referenced section of another deliverable, and says which one', () => {
    vi.useFakeTimers();
    const { root } = mountDoc('See [the queues section](architecture.md#queues) for detail.\n');
    initSectionPreview(root, root, { resolveExternal });
    const card = hover(root, '.markdown-body a')!;
    expect(card).toBeTruthy();
    expect(card.classList.contains('open')).toBe(true);
    expect(card.textContent).toMatch(/Queues/);
    expect(card.textContent).toMatch(/Queue detail/);
    expect(card.textContent).not.toMatch(/Hook detail/); // stops at the next h2
    // Provenance is mandatory: a quotation from another document must not read as your own.
    const from = card.querySelector<HTMLElement>('.section-preview-from')!;
    expect(from.hidden).toBe(false);
    expect(from.textContent).toBe('Architecture');
    expect(card.querySelector('.section-preview-jump')!.textContent).toBe('Open Architecture ↗');
    vi.useRealTimers();
  });

  it('previews the opening of the document when the reference has no fragment', () => {
    vi.useFakeTimers();
    const { root } = mountDoc('See [the architecture](architecture.md) for detail.\n');
    initSectionPreview(root, root, { resolveExternal });
    const card = hover(root, '.markdown-body a')!;
    expect(card.textContent).toMatch(/Architecture/);
    expect(card.textContent).toMatch(/Intro of the other doc/);
    vi.useRealTimers();
  });

  it('the footer opens that deliverable instead of scrolling this one', () => {
    vi.useFakeTimers();
    const opened: any = [];
    const { root } = mountDoc('See [queues](architecture.md#queues).\n');
    initSectionPreview(root, root, {
      resolveExternal,
      onOpenExternal: (href) => opened.push(href),
    });
    const card = hover(root, '.markdown-body a')!;
    const jump = card.querySelector('.section-preview-jump');
    const ev = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    jump!.dispatchEvent(ev);
    expect(opened).toEqual(['architecture.md#queues']);
    expect(ev.defaultPrevented).toBe(true);
    expect(card.classList.contains('open')).toBe(false);
    vi.useRealTimers();
  });

  it('ignores a reference the resolver cannot place, and external links entirely', () => {
    vi.useFakeTimers();
    const { root } = mountDoc(
      'A [renamed doc](gone.md#x) and an [outside link](https://example.test/a).\n',
    );
    initSectionPreview(root, root, { resolveExternal });
    hover(root, '.markdown-body a[href="gone.md#x"]');
    expect(document.querySelector('.section-preview')).toBeNull();
    hover(root, '.markdown-body a[href="https://example.test/a"]');
    expect(document.querySelector('.section-preview')).toBeNull();
    vi.useRealTimers();
  });

  it('still previews same-document sections when a resolver is present', () => {
    vi.useFakeTimers();
    const { root } = mountDoc('[jump](#section-a)\n\n## Section A\n\nBody of A.\n');
    initSectionPreview(root, root, { resolveExternal });
    const card = hover(root, '.markdown-body a[href="#section-a"]')!;
    expect(card.textContent).toMatch(/Body of A/);
    expect(card.querySelector<HTMLElement>('.section-preview-from')!.hidden).toBe(true);
    expect(card.querySelector('.section-preview-jump')!.textContent).toBe('Jump to section ↗');
    vi.useRealTimers();
  });
});
