// @vitest-environment jsdom
//
// ONE rule for "this image has to come from the asset store", and the test that the screen and the
// printed page cannot disagree about it again.
//
// They did. `renderCache.markAssetRefs` marked anything that was not `http(s):`, `data:` or
// protocol-relative; `assetPrefetch` gated on `assetKeys.cleanHref`, which ALSO rejects a leading
// `/` and every scheme. So `![architecture](/assets/architecture.png)` was a red pill NAMING the
// file on screen and, on paper, no picture, no marker and no warning — the reader of that PDF could
// not know a diagram had been meant to be there. Both sides now call `needsAssetStore`.
//
// The agreement test below is deliberately driven off ONE document through BOTH pipelines rather
// than off two lists of hrefs: a list can be updated on one side only, which is how the rule came
// apart in the first place.
import { describe, it, expect } from 'vitest';
import { needsAssetStore } from '../src/docs/assetRef.js';
import { renderDocument, clearRenderCache } from '../src/docs/renderCache.js';
import { createMarkdownRenderer } from '../src/docs/render.js';
import { buildPrintDocument } from '../src/docs/printDoc.js';
import { collectAssetRefs, inlinePrintAssets } from '../src/docs/printAssets.js';
import { syncAssets } from '../src/docs/assetSync.js';
import { refsInRendered } from '../src/fabry/architect/components/AssetsPanel.jsx';
import { prefetchAssets } from '../src/fabry/architect/assetPrefetch.js';

describe('needsAssetStore', () => {
  it('accepts every reference the browser will not resolve on its own', () => {
    // A rooted path and a fragment are the two that reach a rendered page: `sanitize.ts`'s
    // `safeSrc` keeps both and strips a schemed `src` outright.
    for (const href of ['assets/diagram.png', '/assets/diagram.png', '#top', 'diagram.png'])
      expect(needsAssetStore(href), href).toBe(true);
  });

  it('rejects http(s), data: and protocol-relative, which the browser fetches itself', () => {
    for (const href of [
      'https://e.test/x.png',
      'http://e.test/x.png',
      'HTTPS://e.test/x.png',
      'data:image/png;base64,AAAA',
      '//e.test/x.png',
    ])
      expect(needsAssetStore(href), href).toBe(false);
  });

  it('rejects nothing at all, including whitespace dressed up as a reference', () => {
    for (const href of ['', '   ', null as any, undefined as any])
      expect(needsAssetStore(href), JSON.stringify(href)).toBe(false);
  });
});

// The same markdown down both pipelines. Every href here is one `safeSrc` lets through, so any
// difference in the two lists is a difference in the ASSET rule and nothing else — a schemed `src`
// (`file:`, `mailto:`) is removed by the sanitizer on both sides before either rule sees it, which
// is why the two already agreed there and why none appears below.
const TEXT = [
  '# Scope',
  '![rooted](/assets/rooted.png)',
  '![relative](assets/relative.png)',
  '![fragment](#top)',
  '![external](https://e.test/external.png)',
  '![inline](data:image/png;base64,AAAA)',
  'See [the sheet](assets/report.xlsx) and [a sibling](architecture.md).',
].join('\n\n');

const EXPECTED = ['/assets/rooted.png', 'assets/relative.png', '#top'];

describe('the screen and the printed page name the same images', () => {
  it('marks on screen exactly what the print prefetch reports, for one document', async () => {
    clearRenderCache();
    const { body } = renderDocument({ id: 'agree', text: TEXT });
    const marked = [...body!.querySelectorAll('img[data-asset-ref]')].map((img) =>
      img.getAttribute('data-asset-ref'),
    );

    const { html } = buildPrintDocument({
      deliverables: [{ id: 'agree', title: 'Scope', text: TEXT }],
      displayTitle: (d: any) => d.title,
      md: createMarkdownRenderer(),
      options: { contents: false },
    });
    // An empty store, so every reference that IS an asset reference comes back as one refusal —
    // which makes the set of keys the paper side's answer to the same question the marking is the
    // screen side's answer to.
    const { assets, warnings } = await prefetchAssets(
      { lookup: () => null, resolve: () => null },
      collectAssetRefs(html),
    );

    expect(marked).toEqual(EXPECTED);
    expect([...assets.keys()]).toEqual(EXPECTED);
    // And every one of them is reported, not only marked: silence is the one unacceptable outcome.
    expect(warnings).toEqual(EXPECTED.map((h) => `${h} could not be printed — not published`));
  });

  it('leaves the same references alone on both sides', () => {
    clearRenderCache();
    const { body } = renderDocument({ id: 'agree2', text: TEXT });
    // `data:` and `https:` keep their src and are never marked; the sanitizer had already dropped
    // nothing else here.
    expect([...body!.querySelectorAll('img[src]')].map((img) => img.getAttribute('src'))).toEqual([
      'https://e.test/external.png',
      'data:image/png;base64,AAAA',
    ]);
  });
});

// RULING 40 — the same question must get the same ANSWER on every surface, not just the same rule
// about which references are assets. "Why is this picture not here?" was answered `not published` on
// screen and `the file index could not be read (401 Unauthorized)` on paper, for one store in one
// state. `not published` is a claim about the FILE, and its honest reading is "nobody uploaded these"
// or "somebody deleted them" — so a token that expired, or one 502 on the boot `find`, blamed the SA
// for the index's failure across the whole document column. Ruling 33's shape with the polarity
// reversed: print was the honest side this time.
const ONE_IMAGE = '![shot](assets/diagram.png)';

// Every authoring form at once, the two the old markdown regex missed included: a raw `<img>` with a
// width, and a reference-style image whose href lives in a link definition.
const PANEL_TEXT = [
  '# Scope',
  '![inline](assets/inline.png)',
  '<img src="assets/raw.png" width="600" alt="raw">',
  '![byref][r]',
  'See [the sheet](assets/report.xlsx) and [a sibling](architecture.md), and [up](#scope).',
  '```',
  '![fenced](assets/fenced.png)',
  '```',
  '[r]: assets/byref.png',
].join('\n\n');

function paperSentence(assetsStore: any) {
  const { html } = buildPrintDocument({
    deliverables: [{ id: 'diag', title: 'Scope', text: ONE_IMAGE }],
    displayTitle: (d: any) => d.title,
    md: createMarkdownRenderer(),
    options: { contents: false },
  });
  return prefetchAssets(assetsStore, collectAssetRefs(html)).then(({ assets }) => {
    const out = new DOMParser().parseFromString(inlinePrintAssets(html, assets), 'text/html');
    return out.querySelector('.print-asset-missing')!.textContent;
  });
}

function screenSentence(assetsStore: any, id: string) {
  clearRenderCache();
  const { body } = renderDocument({ id, text: ONE_IMAGE });
  // A CLONE: `renderCache` caches this tree and never touches it again, so the live-DOM patch runs
  // against the copy DocView adopted, exactly as it does in the pane.
  const live = body!.cloneNode(true) as HTMLElement;
  syncAssets(live, assetsStore);
  return live.querySelector('.state-label')!.textContent;
}

// RULING 38's other half. The Assets panel's reference count gates a DELETE, so it has to be the
// SAME set the printed page collects — and it is, by being the same function over the same assembler
// rather than by two lists agreeing today. Driven off one document down both paths for the reason the
// rule above is: a hand-written list can be updated on one side only.
describe('the panel and the printed page name the same references', () => {
  it('returns one list for one document, images and links alike', () => {
    const { html } = buildPrintDocument({
      deliverables: [{ id: 'both', title: 'Scope', text: PANEL_TEXT }],
      displayTitle: (d: any) => d.title,
      md: createMarkdownRenderer(),
      options: { contents: false },
    });
    expect(refsInRendered(PANEL_TEXT)).toEqual(collectAssetRefs(html).map((r) => r.href));
  });
});

describe('the screen and the printed page give the same diagnosis', () => {
  const base = { lookup: () => null, peek: () => null, resolve: () => null, pin: () => {} };

  it('blames the INDEX, not the file, on both surfaces', async () => {
    const store = { ...base, stats: () => ({ indexError: '401 Unauthorized' }) };
    const expected = 'assets/diagram.png — the file index could not be read (401 Unauthorized)';
    expect(screenSentence(store, 'diag-err')).toBe(expected);
    expect(await paperSentence(store)).toBe(expected);
  });

  it('blames the FILE on both surfaces when the index was read and simply has no row', async () => {
    const store = { ...base, stats: () => ({ indexError: null }) };
    const expected = 'assets/diagram.png — not published';
    expect(screenSentence(store, 'diag-missing')).toBe(expected);
    expect(await paperSentence(store)).toBe(expected);
  });
});
