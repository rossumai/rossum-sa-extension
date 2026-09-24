// Pure query helpers for the Search Indexes card's Check row. No requests: the
// caller runs the pipeline through api.aggregate.

const CHECK_LIMIT = 5;

// One read-only probe of a single index. Assembled here: no stage ever comes
// from user text, and the only user input is the query string. Callers must not
// run this below READY — a $search against a building index returns [] with
// code "ok", which is indistinguishable from a genuine miss (verified live
// 2026-08-31).
//
// The path is a wildcard, never the mapped field names. Both alternatives broke
// live (2026-09-24): a field under a `document` parent was searched as the
// parent, returning zero rows on a working index, and highlighting any
// non-string path (a document, a token) is an HTTP 400. The wildcard reaches
// nested string leaves and skips token fields; it does not reach `multi`
// alternates.
//
// The record comes back NESTED under `record`, beside the engine's metadata, so a
// collection with its own `score` or `highlights` field is never overwritten.
// `scoreDetails` is the engine's own explanation of each score; the card shows it
// word for word and never derives anything from it. All four live-verified
// together through data/aggregate, 2026-09-24.
export function checkPipeline(indexName: string, value: string): any[] {
  const path = { wildcard: '*' };
  return [
    {
      $search: {
        index: indexName,
        text: { query: String(value ?? ''), path, fuzzy: { maxEdits: 1, prefixLength: 1 } },
        highlight: { path },
        scoreDetails: true,
      },
    },
    { $limit: CHECK_LIMIT },
    {
      $project: {
        _id: 0,
        score: { $meta: 'searchScore' },
        highlights: { $meta: 'searchHighlights' },
        scoreDetails: { $meta: 'searchScoreDetails' },
        record: '$$ROOT',
      },
    },
  ];
}

export type HighlightLine = { path: string; segments: { text: string; hit: boolean }[] };

// One line per matched field, best-scoring first. `row` is a raw aggregate
// result carrying the engine's searchHighlights:
// [{ score, path, texts: [{ value, type: 'hit' | 'text' }] }].
export function highlightLines(row: any): HighlightLine[] {
  const list = row && Array.isArray(row.highlights) ? row.highlights : [];
  return list
    .filter((h: any) => h && typeof h === 'object')
    .sort((a: any, b: any) => Number(b.score ?? 0) - Number(a.score ?? 0))
    .map((h: any) => ({
      path: String(h.path ?? ''),
      segments: (Array.isArray(h.texts) ? h.texts : []).map((t: any) => ({
        text: String(t?.value ?? ''),
        hit: t?.type === 'hit',
      })),
    }));
}

// The record line leaves out what the match line already shows — but only a
// top-level key can go: skipping `address` because `address.city` matched would
// hide the rest of the address.
export function summarySkipKeys(lines: HighlightLine[]): string[] {
  return lines.map((l) => l.path).filter((p) => p !== '' && !p.includes('.'));
}

export type ExplainNode = { value: number; description: string; details: ExplainNode[] };

// A searchScoreDetails node, shape-checked and otherwise untouched: the text is
// the engine's (Lucene's explain output) and is shown verbatim. Anything that is
// not a node becomes null here rather than a crash in the tree.
export function explainNode(raw: any): ExplainNode | null {
  if (!raw || typeof raw !== 'object' || typeof raw.value !== 'number') return null;
  const details = Array.isArray(raw.details) ? raw.details : [];
  return {
    value: raw.value,
    description: String(raw.description ?? ''),
    details: details.map(explainNode).filter((n: ExplainNode | null) => n !== null),
  };
}

// Counts (N, freq) stay whole; everything else is rounded for reading.
export function explainValue(v: unknown): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '\u2013';
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

export type ExplainTerm = {
  path: string;
  term: string;
  points: number;
  boost: number | null;
  // From the term's BM25 formula, each by the engine's own label; null when the
  // engine did not list it. They explain a score but never gate the table.
  docsWithTerm: number | null;
  docsWithField: number | null;
  freq: number | null;
  fieldLength: number | null;
  avgFieldLength: number | null;
};

// The leaf labels under a term's formula, verbatim from live responses.
const COUNT_LABELS = {
  boost: 'boost',
  docsWithTerm: 'n, number of documents containing term',
  docsWithField: 'N, total number of documents with field',
  freq: 'freq, occurrences of term within document',
  fieldLength: 'dl, length of field',
  avgFieldLength: 'avgdl, average length of field',
} as const;

// The two forms a matched term took in every live response (2026-09-24, three
// index shapes): `weight($type:<type>/<path>:<term> in <doc>) [<Sim>], result of:`
// and the same without the `weight(… in <doc>)` wrapper. Which form appears is
// NOT exact-vs-fuzzy — an exact term was seen in the second. `<term>` is the
// INDEXED token (post-analyzer), so it may differ from what was typed. A path is
// taken as everything up to the first colon: a field name containing a colon
// would mis-split, which is legal in MongoDB but has not been seen.
const TERM_WEIGHT = /^weight\(\$type:[^/]+\/([^:]+):(.+) in \d+\) \[\w+\], result of:$/;
const TERM_PLAIN = /^\$type:[^/]+\/([^:]+):(.+) \[\w+\], result of:$/;

// The engine's breakdown read as one row per matched term, or null. MongoDB does
// not guarantee this format ("does not guarantee any specific output format for
// scoreDetails"), so the reading is strict: only `sum of:` wrappers and the two
// term forms above are accepted, and the terms must add up to the score. Anything
// else is null, and the caller shows the raw tree instead — never a half-right
// table.
export function explainTerms(root: ExplainNode): ExplainTerm[] | null {
  const terms: ExplainTerm[] = [];
  function walk(node: ExplainNode): boolean {
    const m = TERM_WEIGHT.exec(node.description) || TERM_PLAIN.exec(node.description);
    if (m) {
      const count = (label: string) => findLeaf(node, label);
      terms.push({
        path: m[1],
        term: m[2],
        points: node.value,
        boost: count(COUNT_LABELS.boost),
        docsWithTerm: count(COUNT_LABELS.docsWithTerm),
        docsWithField: count(COUNT_LABELS.docsWithField),
        freq: count(COUNT_LABELS.freq),
        fieldLength: count(COUNT_LABELS.fieldLength),
        avgFieldLength: count(COUNT_LABELS.avgFieldLength),
      });
      return true;
    }
    if (node.description !== 'sum of:' || node.details.length === 0) return false;
    return node.details.every(walk);
  }
  if (!walk(root) || terms.length === 0) return null;
  const total = terms.reduce((acc, t) => acc + t.points, 0);
  if (Math.abs(total - root.value) > 1e-3 * Math.max(1, Math.abs(root.value))) return null;
  return terms.sort((a, b) => b.points - a.points);
}

// The value of the first node under `node` whose description is exactly `label`.
// A `boost` below 1 came only from a fuzzy match in every live response (0.8).
function findLeaf(node: ExplainNode, label: string): number | null {
  for (const child of node.details) {
    if (child.description === label) return child.value;
    const inner = findLeaf(child, label);
    if (inner !== null) return inner;
  }
  return null;
}
