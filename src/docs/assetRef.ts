// The ONE rule for "this image reference has to be resolved against the asset store", shared by
// both halves of the feature because a disagreement between them loses pictures silently.
//
// It had been written out twice. On screen `renderCache.markAssetRefs` marked anything that was not
// `http(s):`, `data:` or protocol-relative; on paper `assetPrefetch` gated on `assetKeys.cleanHref`,
// which ALSO rejects a leading `/` and every scheme. So `![architecture](/assets/architecture.png)`
// was a red pill NAMING the file on screen and, on paper, no picture, no mark and no warning — the
// reader of that PDF could not know a diagram was meant to be there.
//
// Its own module rather than either caller's, and in `src/docs/` rather than beside `cleanHref`,
// for two reasons that are both about the direction of dependency: `src/fabry/architect` imports
// from `src/docs` and `src/docs` imports nothing from `src/fabry`, so the architect side can reach
// here and the reverse would invert that; and whichever of `renderCache.ts` (screen) or
// `printAssets.ts` (paper) owned it, the other would have to import it across that same boundary.
// Neither owns it, both import it, and there is one copy to change.
//
// NOT the same question `cleanHref` answers, which is why they were never interchangeable.
// `cleanHref` decides what may be an index KEY — a name the uploader allocates, always relative and
// never carrying a scheme. This decides what the BROWSER will not fetch on its own, which is the
// strictly wider set: a rooted path, a fragment and a `mailto:` all reach the store and come back
// unpublished, which is the honest answer for each of them.
export function needsAssetStore(href: string): boolean {
  const h = String(href ?? '').trim();
  return !!h && !/^https?:|^data:|^\/\//i.test(h);
}
