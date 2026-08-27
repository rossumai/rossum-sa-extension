// @vitest-environment jsdom
//
// The two PURE halves of baking assets into a printed specification. Neither knows what an asset
// store is: `collectAssetRefs` reads the assembled HTML, `inlinePrintAssets` writes back whatever
// the (async, architect-side) prefetch managed to prepare — and, crucially, MARKS what it did not.
//
// Why this cannot reuse either on-screen mechanism, pinned here because it is the whole reason the
// module exists: `pdfAction` builds its own renderer, so `renderCache`'s `markAssetRefs` never runs
// and images arrive with their authored `src`; and the assembled HTML crosses
// `chrome.storage.session` into a different tab, where a `blob:` URL from the Console's context is
// dead. See tests/docs-print.test.ts for the assembly itself.
import { describe, it, expect } from 'vitest';
import { createMarkdownRenderer } from '../src/docs/render.js';
import { buildPrintDocument } from '../src/docs/printDoc.js';
import { collectAssetRefs, inlinePrintAssets, type PrintAssets } from '../src/docs/printAssets.js';

// The real assembly, so these tests are pinned to the markup the print path actually produces
// rather than to hand-written HTML that could drift away from it.
function printed(text: string): string {
  return buildPrintDocument({
    deliverables: [{ id: 'a', title: 'A', text }],
    displayTitle: (d: any) => d.title,
    md: createMarkdownRenderer(),
    options: { contents: false },
  }).html;
}

const assets = (entries: Record<string, any>): PrintAssets => new Map(Object.entries(entries));
const PNG = 'data:image/png;base64,AAAA';

describe('collectAssetRefs', () => {
  it('finds an embedded image and a linked file in the assembled document', () => {
    const refs = collectAssetRefs(
      printed('# A\n\n![shot](assets/diagram.png)\n\nSee [the sheet](assets/report.xlsx).\n'),
    );
    expect(refs).toEqual([
      { href: 'assets/diagram.png', images: 1 },
      { href: 'assets/report.xlsx', images: 0 },
    ]);
  });

  it('reads a data-asset-ref marker in preference to any src, so a renderCache tree also works', () => {
    // The print path does not mark its images today. If it is ever routed through renderCache —
    // which STRIPS `src` and leaves `data-asset-ref` behind — this keeps working untouched.
    const refs = collectAssetRefs(
      '<p><img data-asset-ref="assets/diagram.png"><img data-asset-ref="assets/b.png" src="stale.png"></p>',
    );
    expect(refs).toEqual([
      { href: 'assets/diagram.png', images: 1 },
      { href: 'assets/b.png', images: 1 },
    ]);
  });

  it('reports one entry per distinct href, embedded winning over linked', () => {
    // The link comes FIRST in the document and still does not win: an href that is embedded
    // anywhere needs bytes, and `images: 0` would silently print its filename instead of the
    // picture.
    const refs = collectAssetRefs(
      printed('[a](assets/diagram.png)\n\n![b](assets/diagram.png)\n\n[c](assets/diagram.png)\n'),
    );
    expect(refs).toEqual([{ href: 'assets/diagram.png', images: 1 }]);
  });

  it('counts how many times one image is embedded, because that is what gets staged', () => {
    // The whole point of the count. `inlinePrintAssets` writes the data URI into EVERY matching
    // `<img>`, so a picture in three sections lands in storage three times — and a budget charged
    // once per href would let a 2.5 MB screenshot stage 7.5 MB while reporting 2.5 MB spent.
    const refs = collectAssetRefs(
      printed(
        '![a](assets/diagram.png)\n\n![b](assets/diagram.png)\n\n![c](assets/diagram.png)\n\n[d](assets/diagram.png)\n',
      ),
    );
    expect(refs).toEqual([{ href: 'assets/diagram.png', images: 3 }]);
  });

  it("carries every reference, including ones that are not assets — the policy is the prefetch's", () => {
    // Deliberately no URL rule here: `assetRef.needsAssetStore` (for an image) and `cleanHref` (for
    // a link) are where that is decided, and writing either of them out a second time here is how
    // the print path and the screen would drift apart again. Anything the prefetch declines simply
    // never enters the map, and `inlinePrintAssets` only ever touches an href that is in it.
    const refs = collectAssetRefs(
      printed(
        '![x](https://e.test/x.png)\n\n[sibling](architecture.md)\n\n[mail](mailto:a@e.test)\n',
      ),
    );
    expect(refs.map((r) => r.href)).toEqual([
      'https://e.test/x.png',
      'architecture.md',
      'mailto:a@e.test',
    ]);
  });

  it('finds nothing in a document with no references', () => {
    expect(collectAssetRefs(printed('Just prose.\n'))).toEqual([]);
  });

  it('ignores the permalink anchor markdown-it-anchor puts on every heading', () => {
    // Not a URL policy — that is the prefetch's, deliberately. Every heading in a specification
    // carries one of these, so without this the list handed to the prefetch would be mostly noise.
    expect(collectAssetRefs(printed('# A\n\n## B\n\nProse.\n'))).toEqual([]);
  });

  it('drops an `#` LINK but keeps an `#` image, because the screen marks one and not the other', () => {
    // The exclusion above exists for markdown-it-anchor's permalinks, which are always `<a>`. An
    // `<img src="#x">` gets a named pill from `renderCache`/`assetSync`, so dropping it here would
    // put paper back in the state this round is fixing: no picture, no mark, no warning.
    expect(collectAssetRefs('<p><a href="#top">up</a><img src="#top"></p>')).toEqual([
      { href: '#top', images: 1 },
    ]);
  });
});

describe('inlinePrintAssets', () => {
  it('bakes the bytes into the image and names the file in its title', () => {
    const out = inlinePrintAssets(
      printed('![shot](assets/diagram.png)\n'),
      assets({ 'assets/diagram.png': { name: 'diagram.png', dataUri: PNG } }),
    );
    expect(out).toContain(`src="${PNG}"`);
    expect(out).toContain('title="diagram.png"');
    expect(out).not.toContain('assets/diagram.png');
  });

  it('drops the data-asset-ref marker once the image carries its own bytes', () => {
    const out = inlinePrintAssets(
      '<p><img data-asset-ref="assets/diagram.png"></p>',
      assets({ 'assets/diagram.png': { name: 'diagram.png', dataUri: PNG } }),
    );
    expect(out).toContain(`src="${PNG}"`);
    expect(out).not.toContain('data-asset-ref');
  });

  it('marks an asset it could not prepare WHERE THE IMAGE WOULD HAVE BEEN, with the reason', () => {
    // The one unacceptable outcome is silence: an image missing from a printed page with no mark is
    // indistinguishable from one that was never referenced.
    const out = inlinePrintAssets(
      printed('![shot](assets/diagram.png)\n'),
      assets({ 'assets/diagram.png': { name: 'diagram.png', reason: 'not published' } }),
    );
    expect(out).not.toContain('<img');
    expect(out).toContain('class="print-asset-missing"');
    expect(out).toContain('assets/diagram.png — not published');
    // The figure and its caption survive, so the space the picture occupied still reads as a figure.
    expect(out).toContain('<figcaption>shot</figcaption>');
  });

  it('falls back to a reason rather than marking an asset with none', () => {
    const out = inlinePrintAssets(
      '<p><img src="assets/diagram.png"></p>',
      assets({ 'assets/diagram.png': { name: 'diagram.png' } }),
    );
    expect(out).toContain('assets/diagram.png — unavailable');
  });

  it('prints the filename beside a link, which paper cannot follow', () => {
    const out = inlinePrintAssets(
      printed('See [the sheet](assets/report.xlsx).\n'),
      assets({ 'assets/report.xlsx': { name: 'quarterly-report.xlsx' } }),
    );
    expect(out).toContain('<a href="assets/report.xlsx">the sheet</a>');
    expect(out).toContain('<span class="print-asset-file"> (quarterly-report.xlsx)</span>');
  });

  it('leaves every reference the prefetch declined exactly as it was', () => {
    const html = printed(
      '![x](https://e.test/x.png)\n\n[sibling](architecture.md)\n\n![shot](assets/diagram.png)\n',
    );
    const out = inlinePrintAssets(
      html,
      assets({ 'assets/diagram.png': { name: 'diagram.png', dataUri: PNG } }),
    );
    expect(out).toContain('src="https://e.test/x.png"');
    expect(out).toContain('<a href="architecture.md">sibling</a>');
    expect(out).not.toContain('print-asset-file'); // a sibling document is not an asset
  });

  it('returns the document byte-for-byte when there is nothing to inline', () => {
    // A specification with no assets must be UNCHANGED by this task, and "equal after a DOM round
    // trip" is not the same claim: parsing and re-serializing rewrites entities (`&#x27;` comes
    // back as `'` — sanitize.ts's own documented limit). So the assertion uses markup the round
    // trip WOULD change, which is what makes it sensitive to the short-circuit rather than to the
    // parser's idempotence.
    const html = `${printed('# A\n')}\n<p>&#x27;quoted&#x27;</p>`;
    expect(html).toContain('&#x27;');
    expect(inlinePrintAssets(html, new Map())).toBe(html);
  });

  it('stages the bytes into EVERY copy of a repeated image, not just the first', () => {
    // The fact the print budget has to be charged for (assetPrefetch.ts): one href, three copies of
    // its `data:` URI in what crosses `chrome.storage.session`.
    const out = inlinePrintAssets(
      printed('![a](assets/diagram.png)\n\n![b](assets/diagram.png)\n\n![c](assets/diagram.png)\n'),
      assets({ 'assets/diagram.png': { name: 'diagram.png', dataUri: PNG } }),
    );
    expect(out.split(`src="${PNG}"`)).toHaveLength(4); // three occurrences
  });

  it('handles the same file both embedded and linked in one document', () => {
    const out = inlinePrintAssets(
      printed('![shot](assets/diagram.png)\n\nAlso [as a file](assets/diagram.png).\n'),
      assets({ 'assets/diagram.png': { name: 'diagram.png', dataUri: PNG } }),
    );
    expect(out).toContain(`src="${PNG}"`);
    expect(out).toContain('<span class="print-asset-file"> (diagram.png)</span>');
  });
});
