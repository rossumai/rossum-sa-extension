// Baking assets into a printed specification — the two PURE halves of it.
//
// The print path is not the on-screen path and cannot borrow either of its mechanisms. `pdfAction`
// builds its own renderer, so `renderCache`'s `markAssetRefs` never runs and every relative image
// reaches here with its authored `src` intact; and `buildPrintDocument` returns an HTML STRING that
// crosses `chrome.storage.session` into a DIFFERENT TAB, so `assetSync`'s live-DOM patch has no DOM
// to patch and the `blob:` URLs it paints would be dead on arrival — they belong to the Console's
// context, not to the print page's. The only thing a printed image can carry is its own bytes.
//
// Hence two passes with the (async, architect-side) prefetch between them: `collectAssetRefs` says
// what the assembled document references, `inlinePrintAssets` puts back whatever the prefetch could
// prepare and MARKS, visibly, whatever it could not. Neither fetches anything, so
// `buildPrintDocument` stays pure and is not touched at all.
//
// Both accept `data-asset-ref` as well as a plain `src`, so this keeps working if the print path is
// ever routed through `renderCache` (which strips `src` and leaves the marker behind).
//
// No URL policy lives here on purpose. `collectAssetRefs` extracts everything and lets the prefetch
// decide — with `assetRef.needsAssetStore` for an image, which is the SAME predicate `renderCache`
// marks the screen with so the two cannot disagree about what a picture is, and
// `assetKeys.cleanHref` for a link. `inlinePrintAssets` only ever touches an href the prefetch put
// in the map.

/** One asset, as the printed page needs it. */
export type PrintAsset = {
  /** The filename from the index row. Printed beside a link, which paper cannot follow. */
  name: string;
  /** Set only when the bytes were prepared: a self-contained `data:` URI. */
  dataUri?: string;
  /** Set when they were not, and why. Printed where the image would have been. */
  reason?: string;
};

/** Keyed by the reference exactly as it appears in the document — the same string the author wrote
 *  and the index is keyed by, so no normalisation can drift between the two sides. */
export type PrintAssets = Map<string, PrintAsset>;

/** A reference the assembled document makes, and how many `<img>` elements carry it.
 *
 *  ONE number rather than a boolean plus a count, because the two facts are the same fact and two
 *  fields would be free to drift: `images > 0` is "this needs bytes at all" (a link only ever prints
 *  its name), and `images` is how many copies of those bytes `inlinePrintAssets` will stage — which
 *  is what the print budget has to be charged. Zero for a reference that is only ever linked. */
export type AssetRef = { href: string; images: number };

function parseBody(html: string): HTMLElement {
  // The same DOMParser `sanitize.ts` uses, and by the time any of this runs `buildPrintDocument`
  // has already sanitized every section through it — so there is nothing here to guard against.
  return new DOMParser().parseFromString(String(html ?? ''), 'text/html').body;
}

function refOf(img: Element): string {
  return img.getAttribute('data-asset-ref') || img.getAttribute('src') || '';
}

/** Every reference in the assembled HTML, in document order, one entry per distinct href, counting
 *  the `<img>` occurrences of each. The same file may be both embedded and linked; the embedded use
 *  is the one that needs bytes, and it needs them once per `<img>`. */
export function collectAssetRefs(html: string): AssetRef[] {
  const body = parseBody(html);
  const seen = new Map<string, AssetRef>();
  // Every IMAGE first, then every link — not document order across the two, and both halves of that
  // matter. The byte budget is spent in the order this list is walked, so an image must never lose
  // its place in the queue to a link that costs nothing; and counting the images first is what makes
  // a file that is both embedded and linked come back with `images > 0`, the use that needs bytes.
  for (const img of body.querySelectorAll('img')) {
    const href = refOf(img);
    if (!href) continue;
    const at = seen.get(href);
    if (at) at.images += 1;
    else seen.set(href, { href, images: 1 });
  }
  for (const a of body.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    // An `#anchor` LINK is dropped, and it is the ONE exclusion here: markdown-it-anchor puts a
    // permalink anchor on every heading, so a specification would otherwise hand the prefetch a
    // list that is mostly its own table of contents. It is deliberately not applied to an `<img>`:
    // markdown-it-anchor never emits one, and an `<img src="#x">` IS marked on screen, so excluding
    // it here would be exactly the screen/paper disagreement `needsAssetStore` exists to close.
    if (!href || href.startsWith('#') || seen.has(href)) continue;
    seen.set(href, { href, images: 0 });
  }
  return [...seen.values()];
}

// The one thing this feature cannot do is drop a picture quietly, so an asset with no bytes leaves
// a marker WHERE THE IMAGE WOULD HAVE BEEN, naming the reference and the reason. `print.css` styles
// it; `data-asset-ref` rides along so the markup stays traceable to what it replaced.
function missingMark(doc: Document, href: string, reason: string): HTMLElement {
  const span = doc.createElement('span');
  span.className = 'print-asset-missing';
  span.setAttribute('data-asset-ref', href);
  span.textContent = `${href} — ${reason}`;
  return span;
}

/** Fill in every image the prefetch prepared, mark every one it could not, and print the filename
 *  beside every link — a link is dead on paper, so its name is all that can survive the trip.
 *  Returns the HTML unchanged when there is nothing to do, so a specification with no assets is not
 *  even re-serialized. */
export function inlinePrintAssets(html: string, assets: PrintAssets): string {
  if (!assets || !assets.size) return html;
  const body = parseBody(html);
  const doc = body.ownerDocument;

  for (const img of [...body.querySelectorAll('img')]) {
    const href = refOf(img);
    const asset = assets.get(href);
    if (!asset) continue;
    if (asset.dataUri) {
      img.setAttribute('src', asset.dataUri);
      // The marker has done its job; leaving it would invite a second pass to re-resolve an image
      // that is already carrying its own bytes.
      img.removeAttribute('data-asset-ref');
      if (asset.name) img.setAttribute('title', asset.name);
      continue;
    }
    img.replaceWith(missingMark(doc, href, asset.reason || 'unavailable'));
  }

  for (const a of [...body.querySelectorAll('a[href]')]) {
    const asset = assets.get(a.getAttribute('href') || '');
    if (!asset || !asset.name) continue;
    const tag = doc.createElement('span');
    tag.className = 'print-asset-file';
    tag.textContent = ` (${asset.name})`;
    a.after(tag);
  }

  return body.innerHTML;
}
