// @vitest-environment jsdom
// The print-ready document, and the staging that opens it.
//
// Mechanism note (owner-approved): an extension cannot write a .pdf under this manifest's
// permissions, so "PDF" means a print-ready page plus the browser's print dialog, where
// "Save as PDF" is the default destination. Printing the CONSOLE works too — measured, a long
// document prints to the same 3 pages in-pane as standalone — but only for the deliverable
// that is open, which is the gap this fills.
import { describe, it, expect, vi } from 'vitest';
import { createMarkdownRenderer } from '../src/docs/render.js';
import { buildPrintDocument, DEFAULT_OPTIONS } from '../src/docs/printDoc.js';
import {
  buildPrintRequest,
  openPrintTab,
  PRINT_PREFIX,
} from '../src/fabry/architect/printAction.js';

const md = () => createMarkdownRenderer();
const displayTitle = (d: any) => d.title;
const DELIVERABLES = [
  {
    id: '1',
    order: 1,
    title: 'Scope',
    text: '# Scope\n\nWhat we will do.\n',
    state: 'verified',
    stateDate: '2026-08-17',
  },
  {
    id: '2',
    order: 2,
    title: 'Architecture',
    text: '## Queues\n\nQueue detail.\n',
    state: 'stale',
    stateDate: '2026-08-01',
  },
  { id: '3', order: 3, title: 'Untouched', text: 'No heading here.\n' },
];
const RESULTS = { 1: { verdict: 'pass' }, 2: { verdict: 'fail' } };

const build = (over = {}) =>
  buildPrintDocument({
    deliverables: DELIVERABLES,
    displayTitle,
    results: RESULTS,
    md: md(),
    ...over,
  });

describe('buildPrintDocument', () => {
  it('emits one section per deliverable, in the order given', () => {
    const { html } = build({ options: { contents: false } });
    const sections = html.match(/<section class="print-doc">/g) || [];
    expect(sections).toHaveLength(3);
    // Order by each document's own first heading / injected title.
    expect(html.indexOf('id="scope"')).toBeLessThan(html.indexOf('id="queues"'));
    expect(html.indexOf('id="queues"')).toBeLessThan(html.indexOf('print-doc-title'));
  });

  it('does not repeat a title the document already declares', () => {
    // 'Scope' opens with `# Scope`, which is how a deliverable names itself — printing the
    // stored title above it would show the same words twice.
    const { html } = build({
      deliverables: [DELIVERABLES[0]],
      options: { contents: false, verdicts: true },
    });
    expect(html).not.toMatch(/print-doc-title/);
    expect(html).toMatch(/<h1 id="scope"[^>]*>.*Scope<\/h1>/s); // the author's own heading survives
    expect(html).toMatch(/print-doc-head meta-only/); // the verdict chip still has a home
  });

  it('supplies a title only for a document that has no heading of its own', () => {
    const { html } = build({ deliverables: [DELIVERABLES[2]], options: { contents: false } });
    expect(html).toMatch(/<h1 class="print-doc-title">Untouched<\/h1>/);
    expect(html).not.toMatch(/meta-only/);
  });

  it('a headed document with nothing to show beside it gets no header at all', () => {
    const { html } = build({
      deliverables: [DELIVERABLES[0]],
      options: { contents: false, verdicts: false },
    });
    expect(html).not.toMatch(/print-doc-head/);
    expect(html).toMatch(/Scope/);
  });

  it('adds a contents page only when there is more than one document', () => {
    const many = build({ options: { contents: true } }).html;
    expect(many).toMatch(/<section class="print-doc print-contents">/);
    expect(many).toMatch(/<th>Document<\/th>/);
    const one = build({ deliverables: [DELIVERABLES[0]], options: { contents: true } }).html;
    expect(one).not.toMatch(/print-contents/);
  });

  it('strips links from the contents — they resolve to nothing on paper', () => {
    const { html } = build({ options: { contents: true } });
    const contents = html.slice(0, html.indexOf('</section>'));
    expect(contents).not.toMatch(/<a /);
    expect(contents).toMatch(/Scope/);
    // Permalink anchors must be REMOVED, not unwrapped: unwrapping leaves markdown-it-anchor's
    // `#` behind as literal text, which printed as "# Specification".
    expect(contents).not.toMatch(/#\s*Specification/);
    // Removing the anchor leaves the space upstream put between it and the text; HTML
    // collapses it, so the heading reads correctly.
    expect(contents).toMatch(/<h1[^>]*>\s*Specification<\/h1>/);
  });

  it('does not tell a printed page that its styles are inlined in a bundle', () => {
    // buildContentsMarkdown's default note describes the ZIP export; on paper it is nonsense.
    const { html } = build({ options: { contents: true } });
    expect(html).not.toMatch(/self-contained/);
    expect(html).not.toMatch(/no network access/);
  });

  it('no longer prints a manual state badge — status is the check verdict alone', () => {
    // Dropped 2026-08-19 (owner). A deliverable may still carry the old fields; nothing renders them.
    const { html } = buildPrintDocument({
      deliverables: [
        { id: 'a', title: 'A', text: 'body', state: 'verified', stateDate: '2026-08-12' } as any,
      ],
      displayTitle,
      md: md(),
      options: { verdicts: true },
      results: { a: { verdict: 'pass' } },
    });
    expect(html).not.toMatch(/state-label/);
    expect(html).not.toMatch(/Verified/);
    expect(html).toMatch(/print-verdict/); // the verdict chip is still offered
  });

  it('includes the check verdict only when asked (default off)', () => {
    expect(DEFAULT_OPTIONS.verdicts).toBe(false);
    const off = build({ options: { contents: false } }).html;
    expect(off).not.toMatch(/print-verdict/);
    const on = build({ options: { contents: false, verdicts: true } }).html;
    expect(on).toMatch(/<span class="print-verdict verdict-pass">✓ Met<\/span>/);
    expect(on).toMatch(/verdict-fail/);
  });

  it('a deliverable with no state prints no badge, and does not break the run', () => {
    const { html } = build({ deliverables: [DELIVERABLES[2]], options: { contents: false } });
    expect(html).toMatch(/Untouched/);
    expect(html).not.toMatch(/state-label/);
  });

  it('sanitizes each document, so a printed page cannot carry injected markup', () => {
    const { html } = build({
      deliverables: [
        {
          id: 'x',
          order: 1,
          title: 'Hostile',
          text: 'Text\n\n<script>alert(1)</script>\n\n<iframe src="https://x.test"></iframe>\n',
        },
      ],
      options: { contents: false },
    });
    expect(html).not.toMatch(/<script>/);
    expect(html).not.toMatch(/<iframe/);
    expect(html).toMatch(/Text/);
  });

  it('escapes a title that contains markup', () => {
    const { html } = build({
      deliverables: [{ id: 'x', order: 1, title: '<img onerror=alert(1)>', text: 'x' }],
      options: { contents: false },
    });
    expect(html).toMatch(/&lt;img onerror=alert\(1\)&gt;/);
    expect(html).not.toMatch(/<img onerror/);
  });

  it('collects document diagnostics rather than dropping them', () => {
    const { warnings } = build({
      deliverables: [
        { id: 'x', order: 1, title: 'D', text: '## S\n\n<state-label state="ready" />\n' },
      ],
      options: { contents: false },
    });
    expect(warnings.join('\n')).toMatch(/renders as nothing/);
  });
});

describe('print staging', () => {
  it('builds a single-use session key and the page URL', () => {
    const req = buildPrintRequest({ html: '<p>x</p>', title: 'Spec', uuid: 'abc', now: 42 });
    expect(req.key).toBe(`${PRINT_PREFIX}abc`);
    expect(req.entry).toEqual({ html: '<p>x</p>', title: 'Spec', createdAt: 42 });
    expect(req.url).toBe('console/print.html?printId=abc');
  });

  it('stages in SESSION storage and opens the page next to the current tab', async () => {
    const deps = {
      uuid: () => 'u1',
      now: () => 7,
      getURL: (p: any) => 'chrome-extension://id/' + p,
      sessionSet: vi.fn().mockResolvedValue(undefined),
      getCurrentTab: vi.fn().mockResolvedValue({ index: 3, windowId: 9 }),
      tabsCreate: vi.fn().mockResolvedValue({}),
    };
    const key = await openPrintTab({ html: '<p>doc</p>', title: 'Spec' }, deps);
    expect(key).toBe('docPrint_u1');
    // Session, not local: deliverable text must not land at rest on disk.
    expect(deps.sessionSet).toHaveBeenCalledWith({
      docPrint_u1: { html: '<p>doc</p>', title: 'Spec', createdAt: 7 },
    });
    expect(deps.tabsCreate).toHaveBeenCalledWith({
      url: 'chrome-extension://id/console/print.html?printId=u1',
      index: 4,
      windowId: 9,
    });
  });

  it('still opens when the current tab cannot be resolved', async () => {
    const deps = {
      uuid: () => 'u2',
      now: () => 1,
      getURL: (p: any) => '/' + p,
      sessionSet: vi.fn().mockResolvedValue(undefined),
      getCurrentTab: vi.fn().mockRejectedValue(new Error('no tab')),
      tabsCreate: vi.fn().mockResolvedValue({}),
    };
    await openPrintTab({ html: '<p>x</p>' }, deps);
    expect(deps.tabsCreate).toHaveBeenCalledWith({ url: '/console/print.html?printId=u2' });
  });

  it('does nothing without a document', async () => {
    const deps = {
      sessionSet: vi.fn(),
      tabsCreate: vi.fn(),
      uuid: () => 'x',
      now: () => 0,
      getURL: (p: any) => p,
      getCurrentTab: vi.fn(),
    };
    expect(await openPrintTab({ html: '' }, deps)).toBeNull();
    expect(deps.sessionSet).not.toHaveBeenCalled();
    expect(deps.tabsCreate).not.toHaveBeenCalled();
  });
});
