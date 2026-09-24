import { describe, it, expect } from 'vitest';
import {
  checkPipeline,
  highlightLines,
  summarySkipKeys,
  explainValue,
  explainNode,
  explainTerms,
} from '../src/mdh/searchIndexCheck.js';

describe('checkPipeline', () => {
  it('is exactly search, limit and project', () => {
    const p = checkPipeline('idx', 'acme');
    expect(p.map((s) => Object.keys(s)[0])).toEqual(['$search', '$limit', '$project']);
  });

  // Naming mapped fields broke twice, both live-measured 2026-09-24: a field
  // under a `document` parent was searched as the parent (zero rows, "No
  // match", on an index that works), and highlighting any non-string path is
  // an HTTP 400. The wildcard reaches nested string leaves and skips the rest.
  it('searches and highlights every indexed text field through a wildcard', () => {
    const { $search } = checkPipeline('idx', 'acme')[0];
    expect($search.index).toBe('idx');
    expect($search.text.path).toEqual({ wildcard: '*' });
    expect($search.highlight).toEqual({ path: { wildcard: '*' } });
  });

  // "Why it scored" shows the engine's own explanation, never one derived in the
  // browser — so the engine has to be asked for it.
  it('asks the engine for its score breakdown', () => {
    expect(checkPipeline('idx', 'acme')[0].$search.scoreDetails).toBe(true);
  });

  // The record is NESTED, not merged: a collection with its own `score` or
  // `highlights` field must never have it overwritten by the engine's metadata.
  it('returns the engine metadata beside the record, never merged into it', () => {
    expect(checkPipeline('idx', 'acme')[2].$project).toEqual({
      _id: 0,
      score: { $meta: 'searchScore' },
      highlights: { $meta: 'searchHighlights' },
      scoreDetails: { $meta: 'searchScoreDetails' },
      record: '$$ROOT',
    });
  });

  it('uses the measured fuzzy settings', () => {
    expect(checkPipeline('idx', 'acme')[0].$search.text.fuzzy).toEqual({
      maxEdits: 1,
      prefixLength: 1,
    });
  });

  // The only user input is the query string. A value that looks like a stage must
  // stay a string, or Check becomes a way to run arbitrary pipeline stages.
  it('keeps a stage-shaped value as a plain string', () => {
    const p = checkPipeline('idx', '{"$where": "1"}');
    expect(p).toHaveLength(3);
    expect(p[0].$search.text.query).toBe('{"$where": "1"}');
  });

  it('coerces a missing value to an empty string rather than emitting undefined', () => {
    expect(checkPipeline('idx', undefined as any)[0].$search.text.query).toBe('');
  });
});

describe('highlightLines', () => {
  // The shape the engine returned for a wildcard highlight, live 2026-09-24.
  const row = {
    score: 4.28,
    highlights: [
      {
        score: 17.7,
        path: 'name',
        texts: [
          { value: 'Acme ', type: 'text' },
          { value: 'Metals', type: 'hit' },
        ],
      },
      {
        score: 18.1,
        path: 'address.city',
        texts: [
          { value: 'Spring', type: 'hit' },
          { value: 'field', type: 'text' },
        ],
      },
    ],
  };

  it('gives one line per matched field, best-scoring field first', () => {
    expect(highlightLines(row).map((l) => l.path)).toEqual(['address.city', 'name']);
  });

  it('marks exactly the hit segments', () => {
    expect(highlightLines(row)[1].segments).toEqual([
      { text: 'Acme ', hit: false },
      { text: 'Metals', hit: true },
    ]);
  });

  it('returns nothing rather than throwing on junk', () => {
    expect(highlightLines(null)).toEqual([]);
    expect(highlightLines({})).toEqual([]);
    expect(highlightLines({ highlights: 'nope' })).toEqual([]);
    expect(highlightLines({ highlights: [null, { path: 'a' }] })).toEqual([
      { path: 'a', segments: [] },
    ]);
  });
});

describe('summarySkipKeys', () => {
  // The record line must not repeat what the match line above already shows —
  // but only a TOP-LEVEL key can be skipped: dropping `address` because
  // `address.city` matched would hide the rest of the address.
  it('skips top-level matched fields and keeps nested ones', () => {
    expect(
      summarySkipKeys([
        { path: 'name', segments: [] },
        { path: 'address.city', segments: [] },
      ]),
    ).toEqual(['name']);
  });
});

describe('explainValue', () => {
  it('prints integers whole and everything else to two places', () => {
    expect(explainValue(1200)).toBe('1200');
    expect(explainValue(0.38233673572540283)).toBe('0.38');
    expect(explainValue(6.214517116546631)).toBe('6.21');
  });

  it('prints junk as a dash rather than NaN', () => {
    expect(explainValue(undefined)).toBe('–');
    expect(explainValue('x')).toBe('–');
  });
});

describe('explainNode', () => {
  // The engine's text is shown word for word; this only guards the SHAPE.
  it('keeps value, description and children exactly', () => {
    const node = explainNode({
      value: 1.5,
      description: 'sum of:',
      details: [{ value: 1.5, description: 'weight(name:acme in 3)', details: [] }],
    });
    expect(node).toEqual({
      value: 1.5,
      description: 'sum of:',
      details: [{ value: 1.5, description: 'weight(name:acme in 3)', details: [] }],
    });
  });

  it('returns null for something that is not a node', () => {
    expect(explainNode(null)).toBeNull();
    expect(explainNode('x')).toBeNull();
    expect(explainNode({ description: 'no value' })).toBeNull();
  });

  it('drops malformed children rather than throwing', () => {
    expect(explainNode({ value: 1, description: 'a', details: [null, 'x'] })!.details).toEqual([]);
  });
});

describe('explainTerms', () => {
  // Shapes copied from live responses (2026-09-24), values and terms replaced.
  const leaf = (value: number, description: string) => ({ value, description, details: [] });
  const formula = (value: number, boost?: number) => ({
    value,
    description: 'score(freq=1.0), computed as boost * idf * tf from:',
    details: [
      ...(boost === undefined ? [] : [leaf(boost, 'boost')]),
      {
        value: 3.2,
        description: 'idf, computed as log(1 + (N - n + 0.5) / (n + 0.5)) from:',
        details: [
          leaf(5, 'n, number of documents containing term'),
          leaf(1200, 'N, total number of documents with field'),
        ],
      },
      {
        value: 0.38,
        description: 'tf, computed as freq / (freq + k1 * (1 - b + b * dl / avgdl)) from:',
        details: [
          leaf(1, 'freq, occurrences of term within document'),
          leaf(1.2000000476837158, 'k1, term saturation parameter'),
          leaf(0.75, 'b, length normalization parameter'),
          leaf(5, 'dl, length of field'),
          leaf(3.4, 'avgdl, average length of field'),
        ],
      },
    ],
  });
  const weightForm = (value: number, path: string, term: string) => ({
    value,
    description: `weight($type:string/${path}:${term} in 12) [BM25Similarity], result of:`,
    details: [formula(value)],
  });
  const plainForm = (value: number, path: string, term: string, boost?: number) => ({
    value,
    description: `$type:string/${path}:${term} [BM25Similarity], result of:`,
    details: [formula(value, boost)],
  });
  const sum = (value: number, details: any[]) => ({ value, description: 'sum of:', details });

  it('reads one row per matched term, from both term forms and any depth of sum wrappers', () => {
    const tree = sum(6, [
      sum(6, [
        sum(2.5, [weightForm(2.5, 'name', 'acme')]),
        plainForm(2, 'name', 'metals', 0.8),
        weightForm(1.5, 'address.city', 'springfield'),
      ]),
    ]);
    expect(explainTerms(explainNode(tree)!)).toMatchObject([
      { path: 'name', term: 'acme', points: 2.5, boost: null },
      { path: 'name', term: 'metals', points: 2, boost: 0.8 },
      { path: 'address.city', term: 'springfield', points: 1.5, boost: null },
    ]);
  });

  // The counts under each term's formula, read by the engine's own labels.
  it('reads how rare the term is, how long the field is, and how often the term occurs', () => {
    const tree = sum(2.5, [weightForm(2.5, 'name', 'acme')]);
    expect(explainTerms(explainNode(tree)!)![0]).toEqual({
      path: 'name',
      term: 'acme',
      points: 2.5,
      boost: null,
      docsWithTerm: 5,
      docsWithField: 1200,
      freq: 1,
      fieldLength: 5,
      avgFieldLength: 3.4,
    });
  });

  // The counts are extras: missing ones leave the row, and the table, intact.
  it('leaves a count null when the engine did not list it', () => {
    const bare = {
      value: 1,
      description: 'weight($type:string/a:x in 1) [BM25Similarity], result of:',
      details: [],
    };
    expect(explainTerms(explainNode(sum(1, [bare]))!)![0]).toMatchObject({
      docsWithTerm: null,
      docsWithField: null,
      freq: null,
      fieldLength: null,
      avgFieldLength: null,
    });
  });

  // The plain form is NOT a fuzzy marker: an exact term was seen in it live. The
  // only fuzzy evidence is a boost below 1, so the row carries the boost itself.
  it('reports the boost only when the engine gave one', () => {
    const tree = sum(1, [plainForm(1, 'description', 'widget')]);
    expect(explainTerms(explainNode(tree)!)![0].boost).toBeNull();
  });

  // A keyword analyzer keeps case and spaces; the term is whatever the index holds.
  it('keeps a term with capitals and spaces intact', () => {
    const tree = sum(1, [weightForm(1, 'ref.code', 'AC 1001-X')]);
    expect(explainTerms(explainNode(tree)!)![0]).toMatchObject({
      path: 'ref.code',
      term: 'AC 1001-X',
    });
  });

  it('sorts the rows by points, highest first', () => {
    const tree = sum(3, [weightForm(1, 'a', 'x'), weightForm(2, 'b', 'y')]);
    expect(explainTerms(explainNode(tree)!)!.map((r) => r.term)).toEqual(['y', 'x']);
  });

  // Strict by design: MongoDB does not guarantee this format, so anything the
  // parser does not fully recognise must fall back to the raw tree, never to a
  // half-right table.
  it('gives up on a wrapper it does not know', () => {
    expect(
      explainTerms(
        explainNode({ value: 2, description: 'max of:', details: [weightForm(2, 'a', 'x')] })!,
      ),
    ).toBeNull();
  });

  it('gives up on a description it does not recognise', () => {
    expect(explainTerms(explainNode(sum(1, [leaf(1, 'something new')]))!)).toBeNull();
  });

  it('gives up when the terms do not add up to the score', () => {
    expect(explainTerms(explainNode(sum(5, [weightForm(2, 'a', 'x')]))!)).toBeNull();
  });

  it('gives up when there is no term at all', () => {
    expect(explainTerms(explainNode(sum(0, []))!)).toBeNull();
  });
});
