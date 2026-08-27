// @vitest-environment jsdom
//
// Preparing a specification's assets for paper. Every claim here is about ONE property: an asset
// that cannot be printed must be NAMED, on the page and in the document bar, and must never take
// the rest of the document down with it.
//
// The budget is the reason this module exists. The printed HTML rides `chrome.storage.session` into
// another tab, MV3 caps that store at 10 MB, and the per-asset upload ceiling is 40 MB — which
// base64 turns into 53 MB. Nothing in this repo handled that before, so one screenshot could have
// made `runPdf` report "could not open the print view: <opaque storage error>" and lose the whole
// specification.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  prefetchAssets,
  printAssetBudget,
  PRINT_ASSET_BUDGET,
  SESSION_QUOTA,
  type PrintAssetStore,
} from '../src/fabry/architect/assetPrefetch.js';
import type { AssetRef } from '../src/docs/printAssets.js';

// `images` is how many `<img>` elements carry the href, which is how many copies of its `data:` URI
// `inlinePrintAssets` stages — so it is what the budget is charged.
const img = (href: string, images = 1): AssetRef => ({ href, images });
const link = (href: string): AssetRef => ({ href, images: 0 });

type Row = { name: string; mime: string; size: number };

// A store that answers from a plain table. `resolve` hands back an object URL naming its own key,
// and `readBytes` turns that back into bytes — the same round trip the real store performs through
// `URL.createObjectURL` and a `blob:` fetch, without either.
function fakeStore(rows: Record<string, Row>, over: Partial<PrintAssetStore> = {}) {
  const resolve = vi.fn(async (href: string) => ({ url: `blob:${href}` }));
  return {
    lookup: (href: string) => rows[href] || null,
    resolve,
    ...over,
  } as PrintAssetStore & { resolve: typeof resolve };
}

// Deterministic bytes, so the base64 is reproducible and its LENGTH is the real thing the budget
// is spent on.
const bytesOf = (n: number) => new Uint8Array(n).fill(65).buffer;
const readN = (n: number) => vi.fn(async () => bytesOf(n));

const PNG = { name: 'diagram.png', mime: 'image/png', size: 9 };

describe('prefetchAssets', () => {
  it('turns an image into a self-contained data: URI carrying the row’s own mime', async () => {
    const store = fakeStore({ 'assets/diagram.png': PNG });
    const { assets, warnings } = await prefetchAssets(store, [img('assets/diagram.png')], {
      readBytes: readN(9),
    });
    const entry = assets.get('assets/diagram.png')!;
    expect(entry.name).toBe('diagram.png');
    // 9 bytes of 0x41 → 12 base64 characters, no padding.
    expect(entry.dataUri).toBe('data:image/png;base64,QUFBQUFBQUFB');
    expect(entry.reason).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('uses the INDEX row’s mime, never the response’s (D7)', async () => {
    // A macro-enabled workbook is normalised by the API; the same distrust applies to an image.
    const store = fakeStore({ 'a.gif': { name: 'a.gif', mime: 'image/gif', size: 3 } });
    const { assets } = await prefetchAssets(store, [img('a.gif')], { readBytes: readN(3) });
    expect(assets.get('a.gif')!.dataUri).toMatch(/^data:image\/gif;base64,/);
  });

  it('resolves each distinct href exactly once, however often it is referenced', async () => {
    const store = fakeStore({ 'assets/diagram.png': PNG });
    await prefetchAssets(
      store,
      [img('assets/diagram.png'), img('assets/diagram.png'), link('assets/diagram.png')],
      { readBytes: readN(9) },
    );
    expect(store.resolve).toHaveBeenCalledTimes(1);
  });

  it('reads each asset’s bytes before resolving the next one', async () => {
    // Not an ordering preference: the store evicts by TOTAL BYTES (assets.ts `maxBytes`), and
    // resolving everything first would revoke the earlier object URLs before they were ever read.
    // `evict` never touches the entry it was called for, which is what makes resolve-then-read safe.
    const order: string[] = [];
    const store = fakeStore(
      {
        a: { name: 'a', mime: 'image/png', size: 3 },
        b: { name: 'b', mime: 'image/png', size: 3 },
      },
      {
        resolve: vi.fn(async (href: string) => {
          order.push(`resolve ${href}`);
          return { url: `blob:${href}` };
        }),
      },
    );
    await prefetchAssets(store, [img('a'), img('b')], {
      readBytes: vi.fn(async (url: string) => {
        order.push(`read ${url}`);
        return bytesOf(3);
      }),
    });
    expect(order).toEqual(['resolve a', 'read blob:a', 'resolve b', 'read blob:b']);
  });

  it('never pins: the pinned set belongs to whichever syncAssets pass ran last (ruling 16)', async () => {
    const pin = vi.fn();
    const store = fakeStore({ 'assets/diagram.png': PNG }, { pin } as any);
    await prefetchAssets(store, [img('assets/diagram.png')], { readBytes: readN(9) });
    expect(pin).not.toHaveBeenCalled();
  });

  it('records a linked file’s name and never fetches its bytes', async () => {
    // A link cannot be followed on paper, so its filename is all that can survive; spending the
    // budget on a workbook nobody could open would push a printable image out of the document.
    const store = fakeStore({
      'assets/report.xlsx': {
        name: 'quarterly.xlsx',
        mime: 'application/vnd.ms-excel',
        size: 5000,
      },
    });
    const readBytes = readN(5000);
    const { assets, warnings } = await prefetchAssets(store, [link('assets/report.xlsx')], {
      readBytes,
    });
    expect(assets.get('assets/report.xlsx')).toEqual({ name: 'quarterly.xlsx' });
    expect(store.resolve).not.toHaveBeenCalled();
    expect(readBytes).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
  });

  it('marks an image with no index row as "not published", exactly as the screen does', async () => {
    const { assets, warnings } = await prefetchAssets(fakeStore({}), [img('assets/gone.png')]);
    expect(assets.get('assets/gone.png')).toEqual({
      name: 'assets/gone.png',
      reason: 'not published',
    });
    expect(warnings).toEqual(['assets/gone.png could not be printed — not published']);
  });

  it('leaves a relative LINK with no row alone — that is a sibling deliverable, not an asset', async () => {
    const { assets, warnings } = await prefetchAssets(fakeStore({}), [link('architecture.md')]);
    expect(assets.size).toBe(0);
    expect(warnings).toEqual([]);
  });

  it('skips a reference that cannot be an asset at all', async () => {
    const store = fakeStore({});
    const { assets, warnings } = await prefetchAssets(store, [
      img('https://e.test/x.png'),
      img('//e.test/y.png'),
      link('mailto:a@e.test'),
    ]);
    // An absolute image is left exactly as it is on screen: a network fetch by the print page.
    expect(assets.size).toBe(0);
    expect(warnings).toEqual([]);
    expect(store.resolve).not.toHaveBeenCalled();
  });

  it('names an image the STORE cannot key, because the screen names it too', async () => {
    // The round-1 defect, and the sixth instance of this feature's silent-loss shape. The gate here
    // was `cleanHref`, which rejects a leading `/` and a leading `#` — while `renderCache` marks
    // both, so `![architecture](/assets/architecture.png)` was a red pill NAMING the file on screen
    // and, on paper, no picture, no marker and no warning. See asset-ref-rule.test.ts for the two
    // sides driven off one document; this pins the paper half on its own.
    const store = fakeStore({});
    const { assets, warnings } = await prefetchAssets(store, [
      img('/assets/rooted.png'),
      img('#top'),
    ]);
    expect(assets.get('/assets/rooted.png')).toEqual({
      name: '/assets/rooted.png',
      reason: 'not published',
    });
    expect(assets.get('#top')).toEqual({ name: '#top', reason: 'not published' });
    expect(warnings).toEqual([
      '/assets/rooted.png could not be printed — not published',
      '#top could not be printed — not published',
    ]);
    // Still no fetch: there is no row to fetch, and that is the whole statement.
    expect(store.resolve).not.toHaveBeenCalled();
  });

  it('leaves a ROOTED or SCHEMED link alone — a link is `cleanHref`’s question, not an image’s', async () => {
    // Deliberately NOT symmetrical. The wider rule exists because the screen marks images; it marks
    // no link, so there is nothing on paper to bring into line, and treating `/docs/index.html` as
    // an unpublished asset would invent a warning the reader never sees on screen.
    const { assets, warnings } = await prefetchAssets(fakeStore({}), [
      link('/docs/index.html'),
      link('#top'),
      link('mailto:a@e.test'),
    ]);
    expect(assets.size).toBe(0);
    expect(warnings).toEqual([]);
  });

  it('names a file type paper cannot show, and still prints its filename', async () => {
    const store = fakeStore({
      'assets/book.xlsx': {
        name: 'book.xlsx',
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: 12,
      },
    });
    const { assets, warnings } = await prefetchAssets(store, [img('assets/book.xlsx')], {
      readBytes: readN(12),
    });
    const entry = assets.get('assets/book.xlsx')!;
    expect(entry.name).toBe('book.xlsx');
    expect(entry.dataUri).toBeUndefined();
    expect(entry.reason).toMatch(/cannot be shown on paper/);
    expect(warnings[0]).toMatch(
      /^assets\/book\.xlsx could not be printed — .* cannot be shown on paper$/,
    );
    expect(store.resolve).not.toHaveBeenCalled();
  });

  it('refuses an oversized asset BEFORE reading a single byte of it', async () => {
    // Hashing, then downloading, 40 MB in order to throw it away is waste the user waits through —
    // the same reasoning as `uploadNow`'s size check before its digest. base64 is exactly
    // 4 characters per 3 bytes, so the projection needs no bytes to be exact.
    const store = fakeStore({
      'assets/huge.png': { name: 'huge.png', mime: 'image/png', size: 40 * 1024 * 1024 },
    });
    const readBytes = readN(8);
    const { assets, warnings } = await prefetchAssets(store, [img('assets/huge.png')], {
      readBytes,
    });
    expect(assets.get('assets/huge.png')!.reason).toBe('too large for the print budget (53.3 MB)');
    expect(store.resolve).not.toHaveBeenCalled();
    expect(readBytes).not.toHaveBeenCalled();
    expect(warnings).toHaveLength(1);
  });

  it('degrades PER ASSET: what fits is printed, what does not is named, the rest is unaffected', async () => {
    // Each 300-byte image costs 400 base64 characters plus a 22-character `data:image/png;base64,`
    // prefix — 422. A 1000-character budget therefore admits exactly two of them, which is what
    // makes this sensitive to the budget being SPENT and not merely checked.
    const small = { name: 's.png', mime: 'image/png', size: 300 };
    const store = fakeStore({
      'a.png': small,
      'big.png': { name: 'big.png', mime: 'image/png', size: 5000 },
      'z.png': small,
      'w.png': small,
    });
    const { assets, warnings } = await prefetchAssets(
      store,
      [img('a.png'), img('big.png'), img('z.png'), img('w.png')],
      {
        budget: 1000,
        readBytes: vi.fn(async (url: string) => bytesOf(url === 'blob:big.png' ? 5000 : 300)),
      },
    );
    expect(assets.get('a.png')!.dataUri).toBeTruthy();
    expect(assets.get('big.png')!.dataUri).toBeUndefined();
    expect(assets.get('big.png')!.reason).toMatch(/too large for the print budget/);
    // The asset AFTER the refused one still gets printed: the budget refuses an entry, never the
    // remainder of the document.
    expect(assets.get('z.png')!.dataUri).toBeTruthy();
    // And the budget really is cumulative: 422 + 422 leaves no room for a third.
    expect(assets.get('w.png')!.dataUri).toBeUndefined();
    expect(assets.get('w.png')!.reason).toMatch(/too large for the print budget/);
    expect(warnings).toHaveLength(2);
  });

  it('charges the budget once per COPY, because that is how many copies get staged', async () => {
    // 600 bytes → 800 base64 characters + a 22-character `data:image/png;base64,` prefix = 822, and
    // `inlinePrintAssets` writes that string into BOTH `<img>` elements: 1644 characters cross
    // `chrome.storage.session`. Charged once per href — which is what round 1 did — a 900-character
    // budget admits it and stages nearly double. This is the mechanism by which a specification that
    // repeats one 2.5 MB screenshot in three sections blows the quota and loses the WHOLE document
    // to `runPdf`'s opaque catch.
    const store = fakeStore({ 'twice.png': { name: 'twice.png', mime: 'image/png', size: 600 } });
    const { assets, warnings } = await prefetchAssets(store, [img('twice.png', 2)], {
      budget: 900,
      readBytes: readN(600),
    });
    expect(assets.get('twice.png')!.dataUri).toBeUndefined();
    expect(assets.get('twice.png')!.reason).toBe(
      'too large for the print budget (2 KB in 2 places)',
    );
    expect(warnings).toHaveLength(1);
    // Refused on the projection, so not a single byte was read for it.
    expect(store.resolve).not.toHaveBeenCalled();
  });

  it('a repeated image that DOES fit spends the budget for every copy', async () => {
    // The other half of the same arithmetic: 822 × 2 = 1644 fits a 2000 budget, and what is left is
    // 356 — not 1178 — so the next 822-character picture is refused. Without the multiplication both
    // would be admitted and 2466 characters would be staged against a 2000 budget.
    const small = { name: 's.png', mime: 'image/png', size: 600 };
    const store = fakeStore({ 'twice.png': small, 'after.png': small });
    const { assets } = await prefetchAssets(store, [img('twice.png', 2), img('after.png')], {
      budget: 2000,
      readBytes: readN(600),
    });
    expect(assets.get('twice.png')!.dataUri).toHaveLength(822);
    expect(assets.get('after.png')!.dataUri).toBeUndefined();
    expect(assets.get('after.png')!.reason).toMatch(/too large for the print budget/);
  });

  it('charges every copy against the REAL length too, not only the projection', async () => {
    // The re-check has to multiply as well. The row claims 30 bytes, so the projection is 124
    // characters for two copies and sails through a 500 budget; the document actually holds 300,
    // which is 422 characters — one copy still fits and two do not. Charged singly, this admits it.
    const store = fakeStore({ 'lies.png': { name: 'lies.png', mime: 'image/png', size: 30 } });
    const { assets } = await prefetchAssets(store, [img('lies.png', 2)], {
      budget: 500,
      readBytes: readN(300),
    });
    expect(assets.get('lies.png')!.dataUri).toBeUndefined();
    expect(assets.get('lies.png')!.reason).toBe(
      'too large for the print budget (1 KB in 2 places)',
    );
  });

  it('an index that could not be READ says so, instead of blaming the file', async () => {
    // `lookup` returns null for a file nobody uploaded and for an index nobody could read alike, and
    // "not published" is a claim about the file. assets.ts keeps the two apart everywhere else
    // (`indexError`, and a `message` that never returns ''); the printed page has to as well, or a
    // 401 at boot reads to every reader as "the SA never uploaded these".
    const store = fakeStore({}, { stats: () => ({ indexError: '401 Unauthorized' }) } as any);
    const { assets, warnings } = await prefetchAssets(store, [img('assets/diagram.png')]);
    expect(assets.get('assets/diagram.png')!.reason).toBe(
      'the file index could not be read (401 Unauthorized)',
    );
    expect(warnings).toEqual([
      'assets/diagram.png could not be printed — the file index could not be read (401 Unauthorized)',
    ]);
  });

  it('still says "not published" when the index read fine and the row is simply absent', async () => {
    const store = fakeStore({}, { stats: () => ({ indexError: null }) } as any);
    const { assets } = await prefetchAssets(store, [img('assets/gone.png')]);
    expect(assets.get('assets/gone.png')!.reason).toBe('not published');
  });

  it('re-checks the real encoded length, so an index row that understates the size cannot overrun', async () => {
    // `row.size` comes from the index and the bytes come from the document. If those disagree the
    // budget must hold to what is actually about to be staged, not to what was projected.
    const store = fakeStore({ 'lies.png': { name: 'lies.png', mime: 'image/png', size: 30 } });
    const { assets, warnings } = await prefetchAssets(store, [img('lies.png')], {
      budget: 100,
      readBytes: readN(4000),
    });
    expect(assets.get('lies.png')!.dataUri).toBeUndefined();
    expect(assets.get('lies.png')!.reason).toMatch(/too large for the print budget/);
    expect(warnings).toHaveLength(1);
  });

  it('a resolve that reports a failure becomes that failure on the page', async () => {
    const store = fakeStore(
      { 'assets/diagram.png': PNG },
      { resolve: vi.fn(async () => ({ error: '401 Unauthorized' })) },
    );
    const { assets, warnings } = await prefetchAssets(store, [img('assets/diagram.png')], {
      readBytes: readN(9),
    });
    expect(assets.get('assets/diagram.png')!.reason).toBe('401 Unauthorized');
    expect(warnings).toEqual(['assets/diagram.png could not be printed — 401 Unauthorized']);
  });

  it('a resolve that returns nothing at all is still reported', async () => {
    const store = fakeStore({ 'assets/diagram.png': PNG }, { resolve: vi.fn(async () => null) });
    const { assets } = await prefetchAssets(store, [img('assets/diagram.png')], {
      readBytes: readN(9),
    });
    expect(assets.get('assets/diagram.png')!.reason).toBe('unavailable');
  });

  it('a throwing resolve, a throwing lookup and a throwing read are all survivable', async () => {
    const store = fakeStore(
      {
        boom: { name: 'boom.png', mime: 'image/png', size: 3 },
        unread: { name: 'unread.png', mime: 'image/png', size: 3 },
        fine: { name: 'fine.png', mime: 'image/png', size: 3 },
      },
      {
        resolve: vi.fn(async (href: string) => {
          if (href === 'boom') throw new Error('the socket closed');
          return { url: `blob:${href}` };
        }),
      },
    );
    const { assets, warnings } = await prefetchAssets(
      store,
      [img('boom'), img('unread'), img('fine')],
      {
        readBytes: vi.fn(async (url: string) => {
          if (url === 'blob:unread') throw new Error('the bytes went away');
          return bytesOf(3);
        }),
      },
    );
    expect(assets.get('boom')!.reason).toBe('the socket closed');
    expect(assets.get('unread')!.reason).toBe('the bytes went away');
    // The one healthy asset is still printed — the failures cost their own pictures and nothing else.
    expect(assets.get('fine')!.dataUri).toBeTruthy();
    expect(warnings).toHaveLength(2);
  });

  it('survives a store whose lookup throws, and reports the throw rather than the file', async () => {
    const { assets, warnings } = await prefetchAssets(
      {
        lookup: () => {
          throw new Error('the index is gone');
        },
        resolve: vi.fn(),
      },
      [img('assets/diagram.png')],
    );
    expect(assets.get('assets/diagram.png')!.reason).toBe(
      'the file index could not be read (the index is gone)',
    );
    expect(warnings).toHaveLength(1);
  });

  it('a rejection with no message is still given one', async () => {
    // `indexError`'s lesson in assets.ts: a reason of '' reads as no failure at all.
    const store = fakeStore(
      { 'assets/diagram.png': PNG },
      {
        // A rejection carrying no message at all — a gateway with an empty body, or a
        // `Promise.reject('')`. `new Error('')` would still stringify to "Error".
        resolve: vi.fn(() => Promise.reject('')),
      },
    );
    const { assets } = await prefetchAssets(store, [img('assets/diagram.png')]);
    expect(assets.get('assets/diagram.png')!.reason).toBe(
      'the request failed with no reason given',
    );
  });

  it('does nothing, and cannot throw, without a store or without references', async () => {
    expect(await prefetchAssets(null, [img('a.png')])).toEqual({
      assets: new Map(),
      warnings: [],
    });
    expect(await prefetchAssets(fakeStore({}), [])).toEqual({ assets: new Map(), warnings: [] });
  });

  it('budgets well under the 10 MB session-storage quota, leaving the document room of its own', () => {
    expect(PRINT_ASSET_BUDGET).toBeLessThan(SESSION_QUOTA);
    expect(SESSION_QUOTA - PRINT_ASSET_BUDGET).toBeGreaterThan(3 * 1024 * 1024);
  });

  // W7: the constant closed only half of "the budget does not bound what is staged". Ruling 34 made
  // it charge per `<img>` rather than per href; the MARKUP half stayed open, and a specification's
  // own HTML is not small — mermaid bakes as inline SVG, so a diagram-heavy one passes 4 MB alone.
  // 4 MB of markup plus a full 6 MB of assets is over the quota, `storage.session.set` rejects, and
  // `runPdf`'s catch loses the whole specification to an opaque error.
  describe('printAssetBudget', () => {
    it('is the constant for a document with room to spare', () => {
      expect(printAssetBudget('<p>short</p>')).toBe(PRINT_ASSET_BUDGET);
    });

    it('shrinks by what the markup itself will occupy', () => {
      const big = '<p>' + 'x'.repeat(5 * 1024 * 1024) + '</p>';
      const budget = printAssetBudget(big);
      expect(budget).toBeLessThan(PRINT_ASSET_BUDGET);
      // and what the two together stage still fits, which is the whole claim
      expect(JSON.stringify(big).length + budget).toBeLessThan(SESSION_QUOTA);
    });

    it('measures the SERIALIZED markup, because that is what lands in storage', () => {
      // HTML is quote-heavy and every `"` costs two characters once the entry is JSON. Two strings
      // of equal length, one of them all quotes, must not get the same budget.
      // Large enough that the derived figure binds rather than the constant cap.
      const plain = 'y'.repeat(5 * 1000 * 1000);
      const quoted = '"'.repeat(5 * 1000 * 1000);
      expect(printAssetBudget(quoted)).toBeLessThan(printAssetBudget(plain));
    });

    it('never goes negative, however large the document', () => {
      expect(printAssetBudget('z'.repeat(40 * 1024 * 1024))).toBe(0);
    });
  });

  it('rests on a Chrome floor the manifest actually declares', () => {
    // The 10 MB above is Chrome 112 and later. Before that `chrome.storage.session` was capped at
    // 1 MB, and on such a build a 6 MB budget is 6× over — every asset-bearing print would fail
    // opaquely, which is the exact outcome the budget exists to prevent. The figure was an
    // UNDECLARED assumption until this round; asserted here rather than in the manifest's own test
    // because this is the number that depends on it.
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'manifest.json'), 'utf8'),
    );
    expect(Number(String(manifest.minimum_chrome_version).split('.')[0])).toBeGreaterThanOrEqual(
      112,
    );
  });
});
