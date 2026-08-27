// @vitest-environment jsdom
//
// Controller ruling 15 moved asset resolution off `renderDocument` entirely: the cache does not
// know about any store, so it marks a relative image reference and stops there. Resolving that
// marker against a live store is `assetSync.js`'s job (see docs-asset-sync.test.ts) — these tests
// only cover the render-time half, and that it never regresses back into knowing about assets.
import { describe, expect, it } from 'vitest';
import { renderDocument, clearRenderCache } from '../src/docs/renderCache.js';

describe('renderDocument marks relative image references for later sync', () => {
  it('strips the src off a relative image and marks it with data-asset-ref', () => {
    const { body } = renderDocument({ id: 'a', text: '![shot](assets/diagram.png)' });
    const img = body!.querySelector('img')!;
    expect(img.getAttribute('src')).toBe(null);
    expect(img.getAttribute('data-asset-ref')).toBe('assets/diagram.png');
  });

  it('never touches an http(s) or data: image', () => {
    const { body } = renderDocument({
      id: 'b',
      text: '![a](https://example.test/a.png)\n\n![b](data:image/png;base64,AAAA)\n',
    });
    const imgs = [...body!.querySelectorAll('img')];
    expect(imgs).toHaveLength(2);
    for (const img of imgs) expect(img.getAttribute('data-asset-ref')).toBe(null);
    expect(imgs.map((img) => img.getAttribute('src'))).toEqual([
      'https://example.test/a.png',
      'data:image/png;base64,AAAA',
    ]);
  });

  it('a protocol-relative image is neutralised by the sanitizer before it ever reaches marking', () => {
    // The sanitizer (sanitize.ts) already rejects `//`-prefixed URIs on its own, independent of
    // assets — this pins that markAssetRefs has nothing left to see by the time it runs, so it
    // correctly leaves the (already src-less) element alone rather than mis-marking it.
    const { body } = renderDocument({ id: 'b2', text: '![c](//example.test/c.png)\n' });
    const img = body!.querySelector('img')!;
    expect(img.getAttribute('src')).toBe(null);
    expect(img.getAttribute('data-asset-ref')).toBe(null);
  });

  it('marks every relative image reference the same way, with no knowledge of any store', () => {
    const text = '![shot](assets/diagram.png)';
    const first = renderDocument({ id: 'c', text });
    clearRenderCache();
    const second = renderDocument({ id: 'c', text });
    expect(first.body!.querySelector('img')!.outerHTML).toBe(
      second.body!.querySelector('img')!.outerHTML,
    );
  });

  it('a document with no images renders exactly as before', () => {
    const { body } = renderDocument({ id: 'd', text: '# Just text\n\nNo pictures here.\n' });
    expect(body!.querySelector('img')).toBe(null);
    expect(body!.textContent).toContain('No pictures here.');
  });
});
