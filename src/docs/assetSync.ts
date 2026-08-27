// Resolves `[data-asset-ref]` markers against a live assets store, in place, on the LIVE DOM —
// never on a cached `renderDocument` tree (controller ruling 15). renderCache.ts marks a relative
// image reference with `data-asset-ref` and no `src` at render time, deliberately knowing nothing
// about any particular store; this is the other half, run by DocView in its own effect after the
// adopted tree is in the document.
//
// Bidirectional on purpose: every element this produces keeps its `data-asset-ref`, whichever
// state it is currently painted in (an `<img>`, or a `<span>` pill), so a later pass can always
// find it again and move it to a different state. That is what lets an asset self-heal — a pill
// left over from a fetch that failed becomes an image once a retry succeeds; an image whose blob
// URL got evicted becomes "not published" or "unavailable" rather than staying a broken picture
// forever, and would resolve again the next time a row exists.
//
// Nothing here starts a fetch except the branch that explicitly calls `resolve()` — `peek` and
// `lookup` are both synchronous reads with no side effect, matching the store's own contract.
//
// Ruling 16: every ref this pass looks at is handed to the store as the PINNED set at the end,
// replacing whatever was pinned before. Without that, a successful `resolve()` on one ref can
// evict another ref the reader is still looking at (assets.ts's own byte budget), which would
// leave a stale `blob:` src painted here and — worse — get re-requested on the very next pass,
// evicting whatever displaced IT in turn: an unbounded fetch loop for any single document whose
// assets add up to more than the store's `maxBytes`, which is the ordinary case for a
// specification that renders every deliverable into one scroller, not an edge one.
type Held = { row: { name: string }; url?: string; error?: string };

// Loosely typed on purpose, matching DocView's own `AssetsProp` — this module does not import
// `assets.ts`'s `Held`/`AssetRow` shapes, it duck-types them at the one boundary that matters
// (`held.url` / `held.error` / `held.row.name` below), the same way DocView already does for
// `peek`.
export type AssetSyncStore = {
  lookup: (href: string) => unknown | null;
  peek: (href: string) => unknown | null;
  resolve: (href: string) => Promise<unknown> | void;
  pin: (hrefs: string[]) => void;
  /** Optional, so a plain table can stand in for the store — and read for `indexError` alone.
   *  `lookup` returns null both for a file nobody uploaded and for an index nobody could read, and
   *  those two must not paint the same sentence: ruling 40. */
  stats?: () => { indexError?: string | null } | null;
};

// Elements this module owns: an `<img>` it marked (or is about to convert), or a pill it built.
// Narrower than `[data-asset-ref]` on its own — the sanitizer preserves every `data-*` attribute
// on every element it allows through, so a deliverable authoring `data-asset-ref` on some OTHER
// element (raw HTML, unrelated to this feature) must not be destructively replaced.
const ASSET_SELECTOR = 'img[data-asset-ref], span.state-label[data-asset-ref]';

// THREE states, not two (ruling 40). "Not published" is a claim about the FILE, so it may not be
// made about an index nobody could read: a token that expired, or one 502 on the boot `find`, made
// every image in the document column read "— not published", whose honest reading is "nobody
// uploaded these" or "somebody deleted them". `ArchitectApp`'s load effect runs once, so nothing
// re-reads and recovery needs a rail tab the reader may never open. The print path already told the
// truth (`assetPrefetch` reads the same `indexError`), so the two surfaces contradicted each other
// on exactly the first run a stale token produces.
type PillState = 'not-published' | 'unavailable' | 'index-error';

function makePill(doc: Document, ref: string, state: PillState, why: string): HTMLElement {
  const pill = doc.createElement('span');
  pill.className = 'state-label state-error';
  pill.setAttribute('data-state', 'error');
  pill.setAttribute('data-asset-state', state);
  pill.setAttribute('data-asset-ref', ref);
  const text = doc.createElement('span');
  text.className = 'state-label-text';
  text.textContent = `${ref} — ${why}`;
  pill.append(text);
  return pill;
}

// Idempotent by the TEXT as well as the state: an index error carries its own reason, so a read that
// fails differently the second time has to repaint even though the state is unchanged.
function paintPill(el: HTMLElement, ref: string, state: PillState, why: string): void {
  const text = `${ref} — ${why}`;
  if (el.getAttribute('data-asset-state') === state && el.textContent === text) return;
  el.replaceWith(makePill(el.ownerDocument || document, ref, state, why));
}

// The same read `assetPrefetch` makes for paper, and for the same reason. Guarded because the type
// declares `stats` optional and a store is free to throw from it.
function indexErrorOf(store: AssetSyncStore): string {
  try {
    const s = store.stats ? store.stats() : null;
    return s && s.indexError ? String(s.indexError) : '';
  } catch {
    return '';
  }
}

// Idempotent: called with the store in the same state twice makes zero DOM mutations and starts
// no new fetch (the store's own `inflight` map already dedupes a `resolve()` for the same key —
// see assets.ts — so calling it again here just returns the same pending promise).
export function syncAssets(
  root: HTMLElement | null | undefined,
  store: AssetSyncStore | null | undefined,
): void {
  if (!root || !store) return;
  const doc = root.ownerDocument || document;
  const painted: string[] = [];
  const indexError = indexErrorOf(store);

  for (const el of [...root.querySelectorAll<HTMLElement>(ASSET_SELECTOR)]) {
    const ref = el.getAttribute('data-asset-ref') || '';
    if (!ref) continue;
    painted.push(ref);

    let held: Held | null = null;
    try {
      held = store.peek(ref) as Held | null;
    } catch {
      held = null;
    }

    if (held && held.url) {
      // Set `src`/`title` on the EXISTING element rather than building a fresh one: the
      // sanitizer keeps `alt`, `class`, `id`, `width`, `height` and `align` on an authored
      // `<img>`, and replacing the node would throw all of that away the moment it resolves.
      if (el.tagName === 'IMG') {
        if (el.getAttribute('src') !== held.url) el.setAttribute('src', held.url);
        const name = held.row && held.row.name;
        if (name && el.getAttribute('title') !== name) el.setAttribute('title', name);
        continue;
      }
      // Self-healing from a pill: nothing to preserve (a pill never carried the original
      // <img>'s attributes), so a fresh element is the only option here.
      const img = doc.createElement('img');
      img.setAttribute('data-asset-ref', ref);
      img.setAttribute('src', held.url);
      if (held.row && held.row.name) img.setAttribute('title', held.row.name);
      el.replaceWith(img);
      continue;
    }

    if (held && held.error) {
      // A row existed and the fetch failed: a real per-asset failure, whatever the index is doing.
      paintPill(el, ref, 'unavailable', 'unavailable');
      continue;
    }

    // Nothing cached, nothing failed. An `<img>` that still carries a `blob:` src at this point
    // was resolved once and then evicted (or the store was cleared) — that URL is already
    // revoked, and leaving it painted is exactly the broken picture this module promises not to
    // show. Clear it before deciding what to paint instead.
    if (el.tagName === 'IMG' && (el.getAttribute('src') || '').startsWith('blob:')) {
      el.removeAttribute('src');
    }

    let row: unknown = null;
    let lookupError = '';
    try {
      row = store.lookup(ref);
    } catch (err) {
      lookupError = String((err && (err as Error).message) || 'the index could not be read');
    }

    if (!row) {
      // The SAME two-way split `assetPrefetch` makes for paper, in the same order, so the screen and
      // the page cannot diagnose one failure differently.
      const failed = lookupError || indexError;
      if (failed) {
        paintPill(el, ref, 'index-error', `the file index could not be read (${failed})`);
        continue;
      }
      paintPill(el, ref, 'not-published', 'not published');
      continue;
    }

    // A row exists but nothing is cached or failed yet: paint nothing (a bare `<img>` with no
    // `src` is invisible, never a broken-image glyph) and start the only fetch this module ever
    // triggers. The store's shipped implementation always fulfils, but the declared type permits
    // a rejection, which would otherwise surface as an unhandled-rejection console error.
    try {
      Promise.resolve(store.resolve(ref)).catch(() => {});
    } catch {
      /* a well-behaved store never throws synchronously from resolve(); ignore one that does */
    }
  }

  // Replace the pinned set wholesale, not merge it: a ref that scrolled out of the live DOM (a
  // deliverable switch, an edit that removed the reference) must stop being protected on the
  // very next pass, or nothing would ever become evictable again.
  try {
    store.pin(painted);
  } catch {
    /* pinning is best-effort bookkeeping; a store that throws here must not break the sync */
  }
}
