// @vitest-environment jsdom
//
// The print FLOW, end to end: an asset that renders on screen has to reach paper too.
//
// Before this, `runPdf` built its own renderer and staged the assembled string directly, so it
// bypassed BOTH on-screen mechanisms — `renderCache`'s marking and `assetSync`'s live-DOM patch —
// and every image in every printed specification and every PDF was missing. These tests pin the
// wiring: what actually lands in `chrome.storage.session` is the document with its bytes baked in,
// or with a visible mark and a reported warning where they could not be.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/ui/fabry/mermaidLoader.js', () => ({
  // jsdom loads no external script, so the real loader's promise would never settle and `runPdf`
  // would hang on its first await. A rejection is the honest stand-in: it is what happens in a
  // browser when the bundle is unavailable, and `runPdf` already tolerates it.
  loadMermaidRenderer: () => Promise.reject(new Error('no diagram bundle in a test')),
  getMermaidRenderer: () => null,
}));

const staged = vi.hoisted(() => [] as { html: string; title?: string }[]);
vi.mock('../src/fabry/architect/printAction.js', () => ({
  openPrintTab: vi.fn(async (req: any) => {
    staged.push(req);
    return 'docPrint_test';
  }),
}));

vi.mock('../src/fabry/architect/assetPrefetch.js', async (orig) => {
  const real = await orig<typeof import('../src/fabry/architect/assetPrefetch.js')>();
  // Delegates by default; one test replaces it wholesale to prove a catastrophic prefetch failure
  // still prints the document.
  return { ...real, prefetchAssets: vi.fn(real.prefetchAssets) };
});

// The scope dialog reduced to "confirm at once with these choices". `openPdfFlow` is the only entry
// point production has (SpecView's button), so driving it is the only way to prove an option
// declared on `PdfFlowOpts` actually reaches `runPdf`.
vi.mock('../src/fabry/architect/components/PdfDialog.jsx', () => ({
  openPdfDialog: vi.fn((_scope: any, onConfirm: any) =>
    onConfirm({ scope: 'all', options: { contents: false } }),
  ),
}));

import * as store from '../src/fabry/architect/store.js';
import { runPdf, openPdfFlow } from '../src/fabry/architect/pdfAction.js';
import {
  prefetchAssets,
  printAssetBudget,
  PRINT_ASSET_BUDGET,
} from '../src/fabry/architect/assetPrefetch.js';

const ROW = { name: 'diagram.png', mime: 'image/png', size: 3 };

// These tests deliberately do NOT inject `readBytes`, so the module's own default — a `blob:` fetch
// of the object URL the store handed out — is the thing under test here. jsdom has no answer for a
// `blob:` URL, so `fetch` is stubbed instead (see beforeEach) and serves the three bytes back.
function assetStore(
  rows: Record<string, typeof ROW> = { 'assets/diagram.png': ROW },
  over: any = {},
) {
  return {
    lookup: (href: string) => rows[href] || null,
    resolve: vi.fn(async (href: string) => ({ url: `blob:${href}` })),
    ...over,
  };
}

const deliverable = (text: string) => ({ id: 'd1', order: 1, title: 'Scope', text }) as any;

beforeEach(() => {
  staged.length = 0;
  // `mockClear` only forgets the CALLS; the delegating implementation the module factory installed
  // stays, and the one test that overrides it uses `…Once`, so nothing has to be restored.
  vi.clearAllMocks();
  store.deliverables.value = [];
  store.results.value = {};
  (globalThis as any).fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    arrayBuffer: async () => new Uint8Array([65, 65, 65]).buffer,
  }));
});

describe('runPdf stages a document with its assets baked in', () => {
  it('replaces a relative image src with a data: URI before the document crosses to the print tab', async () => {
    // The reason bytes, and not the object URL, have to travel: the print page is a DIFFERENT TAB,
    // and a `blob:` URL belongs to the Console's context.
    store.deliverables.value = [deliverable('# Scope\n\n![shot](assets/diagram.png)\n')];
    const notes: string[] = [];
    await runPdf({
      current: null,
      scope: 'all',
      assets: assetStore(),
      onNote: (n) => notes.push(n),
    });
    expect(staged).toHaveLength(1);
    expect(staged[0].html).toContain('src="data:image/png;base64,QUFB"');
    expect(staged[0].html).not.toContain('assets/diagram.png');
    // The sentinel SpecView keys the PDF button's disabled state and label off, unchanged.
    expect(notes[0]).toBe('busy');
    expect(notes[1]).toBe('print view opened');
  });

  it('marks an unresolvable asset on the page AND reports it to the document bar', async () => {
    store.deliverables.value = [deliverable('![shot](assets/missing.png)\n')];
    const warnings: string[] = [];
    const notes: string[] = [];
    await runPdf({
      current: null,
      scope: 'all',
      assets: assetStore({}),
      onNote: (n) => notes.push(n),
      onWarnings: (w) => warnings.push(...w),
    });
    expect(staged[0].html).toContain('class="print-asset-missing"');
    expect(staged[0].html).toContain('assets/missing.png — not published');
    expect(warnings).toEqual(['assets/missing.png could not be printed — not published']);
    // Silence is the one unacceptable outcome, but a missing picture is still not a failed print.
    expect(notes[1]).toBe('print view opened');
  });

  it('marks an asset whose bytes come back with an error status', async () => {
    // The object URL resolved, so the store reported success; the read of it did not. That is the
    // one failure the store itself cannot see, and it still has to reach the page.
    store.deliverables.value = [deliverable('![shot](assets/diagram.png)\n')];
    (globalThis as any).fetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
    const warnings: string[] = [];
    await runPdf({
      current: null,
      scope: 'all',
      assets: assetStore(),
      onWarnings: (w) => warnings.push(...w),
    });
    expect(staged[0].html).toContain('assets/diagram.png — 404 Not Found');
    expect(warnings).toEqual(['assets/diagram.png could not be printed — 404 Not Found']);
  });

  it('keeps the document diagnostics as well as the asset ones', async () => {
    store.deliverables.value = [
      deliverable('## S\n\n<state-label state="ready" />\n\n![shot](assets/missing.png)\n'),
    ];
    const warnings: string[] = [];
    await runPdf({
      current: null,
      scope: 'all',
      assets: assetStore({}),
      onWarnings: (w) => warnings.push(...w),
    });
    expect(warnings.join('\n')).toMatch(/renders as nothing/);
    expect(warnings.join('\n')).toMatch(/not published/);
  });

  it('prints a linked file’s name, which is all paper can carry', async () => {
    store.deliverables.value = [deliverable('See [the sheet](assets/report.xlsx).\n')];
    await runPdf({
      current: null,
      scope: 'all',
      assets: assetStore({
        'assets/report.xlsx': { name: 'quarterly.xlsx', mime: 'application/json', size: 4 },
      }),
    });
    expect(staged[0].html).toContain('<span class="print-asset-file"> (quarterly.xlsx)</span>');
  });

  // Renamed 2026-08-26: it asserts the prose survived and the store was never touched, not that the
  // HTML is byte-identical. That byte-for-byte claim is `docs-print-assets.test.ts`'s, and it holds.
  it('stages a specification with no assets without touching the store', async () => {
    store.deliverables.value = [deliverable('# Scope\n\nWhat we will do.\n')];
    const store2 = assetStore();
    await runPdf({ current: null, scope: 'all', assets: store2 });
    expect(staged[0].html).toContain('What we will do.');
    expect(store2.resolve).not.toHaveBeenCalled();
  });

  it('still prints the specification if the whole prefetch collapses', async () => {
    // Defence in depth: `prefetchAssets` degrades per asset and cannot reject — every call it makes
    // is already wrapped. If it somehow did, there is no way to know WHICH references were assets,
    // so the document is staged with them as authored (a print tab shows a browser broken-image
    // glyph for each) and the failure is named in the document bar. Losing the whole specification
    // over one picture is the outcome this path exists to prevent.
    store.deliverables.value = [deliverable('![shot](assets/diagram.png)\n')];
    vi.mocked(prefetchAssets).mockRejectedValueOnce(new Error('the index exploded'));
    const warnings: string[] = [];
    const notes: string[] = [];
    await runPdf({
      current: null,
      scope: 'all',
      assets: assetStore(),
      onNote: (n) => notes.push(n),
      onWarnings: (w) => warnings.push(...w),
    });
    expect(staged).toHaveLength(1);
    expect(staged[0].html).toContain('assets/diagram.png');
    expect(warnings).toEqual(['assets could not be prepared: the index exploded']);
    expect(notes[1]).toBe('print view opened');
  });
});

// W7: the budget is spent out of the SAME quota the assembled markup is staged in, and only this
// scope knows how much of it the document has already taken. A constant could not: a specification
// whose own HTML passes 4 MB — mermaid bakes as inline SVG — plus a full 6 MB of assets overruns
// `chrome.storage.session`, `set` rejects, and the catch loses the whole specification.
describe('the print budget follows the real headroom', () => {
  it('hands the prefetch a budget computed from the assembled document', async () => {
    store.deliverables.value = [deliverable('![shot](assets/diagram.png)\n')];
    await runPdf({ current: null, scope: 'all', assets: assetStore() });
    const [, , opts] = vi.mocked(prefetchAssets).mock.calls[0];
    expect(opts!.budget).toBe(printAssetBudget(staged[0].html));
  });

  it('gives a heavy document a SMALLER budget than a light one', async () => {
    // The two runs differ only in how much markup the specification carries, which is the axis the
    // constant was blind to.
    store.deliverables.value = [deliverable('![shot](assets/diagram.png)\n')];
    await runPdf({ current: null, scope: 'all', assets: assetStore() });
    const light = (vi.mocked(prefetchAssets).mock.calls[0][2] as any).budget;

    vi.mocked(prefetchAssets).mockClear();
    store.deliverables.value = [
      // One long token rather than a million words: the markdown cost is the tokenizer's, and what
      // this test needs is only a document whose HTML is big enough for the derived figure to bind.
      deliverable('![shot](assets/diagram.png)\n\n' + 'x'.repeat(4_500_000)),
    ];
    await runPdf({ current: null, scope: 'all', assets: assetStore() });
    const heavy = (vi.mocked(prefetchAssets).mock.calls[0][2] as any).budget;

    expect(light).toBe(PRINT_ASSET_BUDGET);
    expect(heavy).toBeLessThan(light);
  });
});

describe('openPdfFlow', () => {
  it('carries the assets store through the scope dialog', async () => {
    // `PdfFlowOpts` declared `assets` and `openPdfFlow` destructured only `onNote`/`onWarnings`, so
    // a caller wiring a store through the dialog path had it dropped in silence — this feature's own
    // defect shape in miniature, and unnoticed precisely because nothing in production passes it
    // yet. Dropped, the fallback is the live `store.assets`, whose index nobody has loaded, so the
    // picture would come back "not published" instead of carrying its bytes.
    store.deliverables.value = [deliverable('![shot](assets/diagram.png)\n')];
    const notes: string[] = [];
    openPdfFlow(null, { assets: assetStore(), onNote: (n) => notes.push(n) });
    // `openPdfFlow` returns nothing — the dialog's confirm callback owns the promise — so the wait is
    // on what was staged.
    await vi.waitFor(() => expect(staged).toHaveLength(1));
    expect(staged[0].html).toContain('src="data:image/png;base64,QUFB"');
    expect(notes[1]).toBe('print view opened');
  });
});
