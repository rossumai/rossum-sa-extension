// Preparing the specification's assets for paper: resolve each one once, turn the images into
// `data:` URIs, and REFUSE — by name, with a reason — anything that will not fit.
//
// Why a budget exists at all. The printed document rides `chrome.storage.session` into another tab
// (printAction.ts), and that store has a quota — 10 MB under MV3 — which nothing in this repo
// handled before this. The per-asset upload ceiling is 40 MB (assets.ts) and base64 inflates by a
// third, so ONE picture can be 53 MB of text: without a budget it would blow the quota, and
// `runPdf`'s catch would turn that into "could not open the print view: <opaque storage error>" —
// the entire specification lost because of one image. So the degradation is PER ASSET. Everything
// that fits is printed; everything that does not is named on the page and reported to the document
// bar, and the rest of the document prints normally.
import { cleanHref } from './assetKeys.js';
// A refusal with no reason is a marker on the page that names the file and says nothing else.
import { message } from './errorText.js';
import { needsAssetStore } from '../../docs/assetRef.js';
import type { PrintAsset, PrintAssets, AssetRef } from '../../docs/printAssets.js';

// The staged entry is `{ html, title, createdAt }` JSON-serialized, and a base64 payload carries no
// characters JSON has to escape — so the budget is spent one-for-one, while the document's own HTML
// costs somewhat more than its length (every attribute quote becomes two bytes). 6 MB of assets
// leaves ~4 MB for a specification's markup, which is far more than a long one weighs, and it still
// admits a dozen full-page screenshots. Measured in CHARACTERS OF `data:` URI, which is the thing
// that actually lands in storage, rather than in raw bytes — and charged once per `<img>`, not once
// per href, because that is how many copies of the URI `inlinePrintAssets` stages (see `AssetRef`).
//
// The 10 MB figure is Chrome 112 and later; before that `chrome.storage.session` was capped at 1 MB,
// which is why `manifest.json` declares a `minimum_chrome_version` above it (design §5.6).
export const PRINT_ASSET_BUDGET = 6 * 1024 * 1024;

/** `chrome.storage.session`'s documented quota under MV3, and the number the budget is carved out
 *  of. Whether a single VALUE may be this large, as opposed to the per-AREA cap the documentation
 *  states, is on the human-verify list (design §5.6). */
export const SESSION_QUOTA = 10 * 1024 * 1024;

/** Room for everything in the staged entry that is neither the markup nor the assets: the
 *  `{ html, title, createdAt }` keys, the title, and whatever the storage layer adds around them. */
const STAGE_OVERHEAD = 64 * 1024;

/**
 * The budget for ONE print, derived from the headroom that print actually has.
 *
 * `PRINT_ASSET_BUDGET` alone closed only half of it. Ruling 34 made the budget charge what is
 * STAGED per `<img>` rather than what is fetched per href; the MARKUP half stayed open, and a
 * specification's own HTML is not small — mermaid bakes as inline SVG, so a diagram-heavy one can
 * pass 4 MB on its own. 4 MB of markup plus a full 6 MB of assets is over the quota,
 * `chrome.storage.session.set` rejects, and `runPdf`'s catch loses the WHOLE specification to an
 * opaque error — the exact outcome the budget exists to prevent, reached by the one route the budget
 * did not watch. "Far more than a long one weighs" was an assertion, not a measurement.
 *
 * Measured on `JSON.stringify`, not on `html.length`: the entry is serialized, and HTML is
 * quote-heavy, so every attribute quote costs two characters. A base64 payload carries nothing JSON
 * has to escape, which is why the assets themselves are still charged one-for-one.
 *
 * `PRINT_ASSET_BUDGET` stays as a CAP so a small specification does not suddenly get to stage ~9 MB
 * in one value — the size question no offline test can settle. The derived figure only ever tightens.
 */
export function printAssetBudget(html: string): number {
  const staged = JSON.stringify(String(html ?? '')).length;
  return Math.max(0, Math.min(PRINT_ASSET_BUDGET, SESSION_QUOTA - staged - STAGE_OVERHEAD));
}

// `sanitize.ts`'s own `safeSrc` allowlist for `data:` image URIs. Nothing outside it is inlined:
// the staged HTML must stay HTML the sanitizer would have passed, and the print page injects it
// with no sanitizer of its own. `mimeForName` cannot currently produce an image mime outside this
// set, so this is a guard against a future entry rather than a live branch — which is why an
// unlisted type degrades to "printed as a filename" and not to an error.
const INLINABLE = /^image\/(png|jpe?g|gif|webp|svg\+xml)$/i;

type PrefetchRow = { name: string; mime: string; size: number };
type PrefetchHeld = { url?: string; error?: string } | null;

/** What the prefetch needs of the asset store — `store.assets`, the one instance (store.ts). */
export type PrintAssetStore = {
  lookup: (href: string) => PrefetchRow | null;
  resolve: (href: string) => Promise<PrefetchHeld> | PrefetchHeld;
  /** Optional, so a plain table can stand in for the store. Read for `indexError` alone: `lookup`
   *  returns null both for a file nobody uploaded and for an index nobody could read, and those two
   *  must not print the same sentence. */
  stats?: () => { indexError?: string | null } | null;
};

function human(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// The refusal names what the whole reference COSTS, which is the picture times the number of places
// it appears — so the repetition is said out loud rather than leaving a reader to wonder why a 2.5 MB
// screenshot was refused as 7.5 MB.
function cost(chars: number, images: number): string {
  return images > 1 ? `${human(chars)} in ${images} places` : human(chars);
}

// `lookup` cannot report this: it returns null for a file nobody uploaded and for an index nobody
// could read alike. `assets.ts` keeps the two apart everywhere else (`indexError`, and a `message`
// that never returns ''), and printing "not published" for the second one blames the file for the
// index's failure.
function indexErrorOf(store: PrintAssetStore): string {
  try {
    const s = store.stats ? store.stats() : null;
    return s && s.indexError ? String(s.indexError) : '';
  } catch {
    return '';
  }
}

// base64 is 4 characters per 3 bytes, padded — exact, not an estimate, which is what lets an
// oversized asset be refused BEFORE its bytes are read. Reading 40 MB to then throw it away is
// waste the user waits through, the same reasoning as `uploadNow`'s size check before its digest.
function projectedLength(mime: string, size: number): number {
  return `data:${mime};base64,`.length + Math.ceil(Math.max(0, size) / 3) * 4;
}

// `String.fromCharCode(...bytes)` on a whole image overflows the argument list, so this walks it in
// 32 KB slices. No FileReader: `readAsDataURL` is a MACROTASK, and a caller awaiting a chain of
// promises would never let it run.
function toBase64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

// The store hands out an OBJECT URL and nothing else — deliberately, `fetchBytes(row)` is out of
// scope for this task — so the bytes are read back through it. Same-origin `blob:` fetch, which the
// default MV3 page CSP does not restrict; injected so the tests never need one.
async function readObjectUrl(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText || ''}`.trim());
  return res.arrayBuffer();
}

export type PrefetchOptions = {
  budget?: number;
  readBytes?: (url: string) => Promise<ArrayBuffer>;
};

/**
 * Resolve every asset the printed document references — ONE `resolve` per distinct href — and
 * return what `inlinePrintAssets` should do with each. Never rejects: a single asset failing is a
 * marker on one page, never a lost document.
 *
 * Sequential, and each asset's bytes are read the moment it resolves, because the store evicts by
 * total bytes (`assets.ts`, `maxBytes`): resolving all of them first and reading afterwards would
 * hand back object URLs that the later resolves had already revoked. `evict` never touches the
 * entry it was called for, so read-then-next is safe. It deliberately does NOT `pin` — the pinned
 * set belongs to whichever `syncAssets` pass ran last (ruling 16), and replacing it from here would
 * unpin what the reader is looking at on screen.
 */
export async function prefetchAssets(
  store: PrintAssetStore | null | undefined,
  refs: AssetRef[],
  { budget = PRINT_ASSET_BUDGET, readBytes = readObjectUrl }: PrefetchOptions = {},
): Promise<{ assets: PrintAssets; warnings: string[] }> {
  const assets: PrintAssets = new Map();
  const warnings: string[] = [];
  if (!store || !refs || !refs.length) return { assets, warnings };
  let spent = 0;

  const refuse = (href: string, entry: PrintAsset, reason: string) => {
    entry.reason = reason;
    warnings.push(`${href} could not be printed — ${reason}`);
  };
  const indexError = indexErrorOf(store);

  for (const { href, images } of refs) {
    if (assets.has(href)) continue;
    // Two rules, because the two references ask different questions, and pairing them the other way
    // round is what lost pictures silently.
    //
    // An IMAGE is `needsAssetStore`'s question (assetRef.ts) — the SAME predicate `renderCache` marks
    // the screen with. Anything the browser will not fetch on its own has to come from the store, so
    // `/assets/x.png` with no row is refused BY NAME here exactly as it is pilled on screen, instead
    // of being skipped and vanishing off the page with no mark and no warning. `https://` is
    // correctly outside this class: the screen leaves it alone too, and the print page fetches it.
    //
    // A LINK is `cleanHref`'s question. A rooted or schemed link is not an asset at all, and a
    // relative one with no row is a sibling deliverable — nothing to say about either, and the screen
    // marks no link, so there is no divergence to close.
    if (!(images > 0 ? needsAssetStore(href) : cleanHref(href))) continue;

    let row: PrefetchRow | null = null;
    let readError = '';
    try {
      row = store.lookup(href);
    } catch (err) {
      readError = message(err);
    }

    if (!row) {
      // A relative LINK with no row is a sibling deliverable (`architecture.md`), which is how
      // DocView's click routing reads it too — not an asset, and nothing to say about it. A
      // relative IMAGE with no row is the missing asset `assetSync` paints its "not published"
      // pill for, and paper gets the same statement — unless the index itself could not be read, in
      // which case nothing is known about the file and saying "not published" would be a claim.
      if (images > 0) {
        const entry: PrintAsset = { name: href };
        assets.set(href, entry);
        const failed = readError || indexError;
        refuse(
          href,
          entry,
          failed ? `the file index could not be read (${failed})` : 'not published',
        );
      }
      continue;
    }

    const entry: PrintAsset = { name: row.name };
    assets.set(href, entry);
    // A link carries its filename and nothing else: paper cannot follow it, and fetching a workbook
    // nobody can open would spend the budget on bytes that could never be shown (design §5.4).
    if (!images) continue;

    if (!INLINABLE.test(row.mime)) {
      refuse(href, entry, `${row.mime || 'this file type'} cannot be shown on paper`);
      continue;
    }
    // × images, both here and on the real length below. `inlinePrintAssets` writes the URI into
    // EVERY <img> carrying the href, so charging it once let a specification that repeats one 2.5 MB
    // screenshot in three sections report 3.4 MB of 6 MB spent while staging 10.2 MB — over the
    // session-storage quota, and `runPdf`'s catch turns that into "could not open the print view:
    // <opaque storage error>". The whole document lost to one picture, which is what the budget is
    // for.
    const projected = projectedLength(row.mime, row.size) * images;
    if (spent + projected > budget) {
      refuse(href, entry, `too large for the print budget (${cost(projected, images)})`);
      continue;
    }

    let held: PrefetchHeld = null;
    try {
      held = await store.resolve(href);
    } catch (err) {
      refuse(href, entry, message(err));
      continue;
    }
    if (!held || !held.url) {
      refuse(href, entry, held && held.error ? held.error : 'unavailable');
      continue;
    }

    let dataUri: string;
    try {
      dataUri = `data:${row.mime};base64,${toBase64(new Uint8Array(await readBytes(held.url)))}`;
    } catch (err) {
      refuse(href, entry, message(err));
      continue;
    }
    // Re-checked against the REAL length, not the projection: `row.size` comes from the index and
    // the bytes come from the document, and if those two ever disagree the budget must hold to what
    // is actually about to be staged.
    const staged = dataUri.length * images;
    if (spent + staged > budget) {
      refuse(href, entry, `too large for the print budget (${cost(staged, images)})`);
      continue;
    }
    entry.dataUri = dataUri;
    spent += staged;
  }

  return { assets, warnings };
}
