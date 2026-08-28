// Name filter for the collections sidebar: the text a user types into the box above the
// list. NOT to be confused with `applyCollectionFilter` in store.ts, which is the unrelated
// split of the listing into the customer's collections and this extension's own. An org with ninety collections sharing a long
// prefix cannot be navigated by eye, and the list is already sorted — so the only thing
// missing is narrowing it.
//
// Plain case-insensitive substring, deliberately: it is the one rule a user can predict
// from the characters they typed. Multi-token AND and subsequence ("fuzzy") matching were
// both considered and rejected — each turns "why is this row here?" into a question.
// The query is LITERAL text, never a pattern: a name here may contain parentheses or dots
// (`orders (v2)`), and a regex would either throw on them or quietly match everything.

export function filterCollections(names: string[], query: string): string[] {
  const all = names || [];
  const q = (query || '').trim().toLowerCase();
  if (!q) return all;
  return all.filter((name) => name.toLowerCase().includes(q));
}

// One run of a collection name, and whether the query matched it. The segments always
// reassemble to the input exactly — the renderer emphasises the hits and prints the rest
// verbatim, so what a row shows is still the whole, unaltered name.
export type NameSegment = { text: string; hit: boolean };

export function splitByMatch(name: string, query: string): NameSegment[] {
  const q = (query || '').trim().toLowerCase();
  if (!q) return [{ text: name, hit: false }];
  const haystack = name.toLowerCase();
  // The offsets below come from the lowercased haystack but slice the ORIGINAL name, so the
  // row keeps the collection's own casing. That only holds while both strings are indexed
  // alike, and one BMP character breaks it: U+0130 'I' with a dot lowercases to TWO code
  // units, shifting every offset after it and emphasising the wrong run. Filtering is
  // unaffected (it compares whole strings), so fall back to no emphasis rather than wrong
  // emphasis. A collection name is free-form UTF-8, so this is reachable, not theoretical.
  if (haystack.length !== name.length) return [{ text: name, hit: false }];
  const out: NameSegment[] = [];
  let at = 0;
  for (;;) {
    const found = haystack.indexOf(q, at);
    if (found === -1) break;
    if (found > at) out.push({ text: name.slice(at, found), hit: false });
    // Slice from the ORIGINAL name, never from the lowercased copy, so the row keeps the
    // collection's own casing. Both strings are indexed alike: toLowerCase() can change a
    // string's length in some locales, but not for any character a collection name allows.
    out.push({ text: name.slice(found, found + q.length), hit: true });
    at = found + q.length;
  }
  if (out.length === 0) return [{ text: name, hit: false }];
  if (at < name.length) out.push({ text: name.slice(at), hit: false });
  return out;
}
