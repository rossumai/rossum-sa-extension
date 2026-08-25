// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { CATALOG, optionsFor, SYSTEM_VAR_OPTIONS } from '../src/mdh/pipelineCompletions.js';
import { EditorState } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { ensureSyntaxTree } from '@codemirror/language';
import { classifyContext } from '../src/mdh/pipelineCompletions.js';

// Build a state from code containing a single '|' cursor marker.
function at(code: any) {
  const pos = code.indexOf('|');
  const doc = code.slice(0, pos) + code.slice(pos + 1);
  const state = EditorState.create({ doc, extensions: [javascript()] });
  ensureSyntaxTree(state, doc.length, 5000); // force a full parse for the test
  return { state, pos };
}
function ctx(code: any) {
  const { state, pos } = at(code);
  return classifyContext(state, pos);
}

describe('operator catalog', () => {
  it('every entry has label/detail/cats and a $ label', () => {
    expect(CATALOG.length).toBeGreaterThan(120);
    for (const e of CATALOG) {
      expect(typeof e.label).toBe('string');
      expect(e.label.startsWith('$')).toBe(true);
      expect(typeof e.detail).toBe('string');
      expect(e.detail.length).toBeGreaterThan(0);
      expect(e.cats.size).toBeGreaterThan(0);
    }
  });

  it('labels are unique (merged across categories)', () => {
    const labels = CATALOG.map((e) => e.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('category option lists contain the expected anchors', () => {
    const labelsOf = (cat: any) => optionsFor(cat).map((o) => o.label);
    expect(labelsOf('STAGE')).toEqual(
      expect.arrayContaining(['$match', '$group', '$setWindowFields', '$unionWith']),
    );
    expect(labelsOf('QUERY')).toEqual(
      expect.arrayContaining(['$eq', '$in', '$regex', '$elemMatch']),
    );
    expect(labelsOf('EXPRESSION')).toEqual(
      expect.arrayContaining(['$concat', '$dateToString', '$toInt', '$cond', '$mergeObjects']),
    );
    expect(labelsOf('ACCUMULATOR')).toEqual(
      expect.arrayContaining(['$sum', '$push', '$stdDevPop', '$rank']),
    );
    const g = labelsOf('GROUP_VALUE');
    expect(g).toEqual(expect.arrayContaining(['$sum', '$concat']));
    expect(new Set(g).size).toBe(g.length);
    const sum = CATALOG.find((e) => e.label === '$sum');
    expect(sum.cats.has('ACCUMULATOR')).toBe(true);
    expect(sum.cats.has('EXPRESSION')).toBe(true);
  });

  it('options are CodeMirror completion shaped', () => {
    const o = optionsFor('STAGE')[0];
    expect(o).toHaveProperty('label');
    expect(o).toHaveProperty('type', 'keyword');
    expect(o).toHaveProperty('detail');
    expect(SYSTEM_VAR_OPTIONS.map((s) => s.label)).toContain('$$ROOT');
  });
});

describe('lezer node-name pins (guard against CM upgrades)', () => {
  it('object keys are PropertyDefinition (unquoted) or String (quoted, firstChild)', () => {
    const { state } = at('[{ $match: {} }|]');
    const tree = ensureSyntaxTree(state, state.doc.length, 5000);
    const names = new Set();
    tree!.cursor().iterate((n) => {
      names.add(n.name);
    });
    expect(names.has('ObjectExpression')).toBe(true);
    expect(names.has('ArrayExpression')).toBe(true);
    expect(names.has('Property')).toBe(true);
    expect(names.has('PropertyDefinition')).toBe(true);
  });
});

describe('classifyContext', () => {
  it('STAGE — root pipeline, unquoted and quoted keys', () => {
    expect(ctx('[{ $ma|t }]')).toEqual({ position: 'key', keyCategory: 'STAGE' });
    expect(ctx('[{ "$ma|t" }]')).toEqual({ position: 'key', keyCategory: 'STAGE' });
  });
  it('STAGE — sub-pipelines ($lookup.pipeline, $facet branch)', () => {
    expect(ctx('[{ $lookup: { from: "c", pipeline: [ { $ma| } ], as: "a" } }]')).toEqual({
      position: 'key',
      keyCategory: 'STAGE',
    });
    expect(ctx('[{ $facet: { branchA: [ { $ma| } ] } }]')).toEqual({
      position: 'key',
      keyCategory: 'STAGE',
    });
  });
  it('QUERY — operator inside $match', () => {
    expect(ctx('[{ $match: { amount: { $g| } } }]')).toEqual({
      position: 'key',
      keyCategory: 'QUERY',
    });
  });
  it('QUERY — operators inside $and/$or query clauses in $match (transparent)', () => {
    expect(ctx('[{ $match: { $and: [ { $e| } ] } }]')).toEqual({
      position: 'key',
      keyCategory: 'QUERY',
    });
    expect(ctx('[{ $match: { $or: [ { amount: { $g| } } ] } }]')).toEqual({
      position: 'key',
      keyCategory: 'QUERY',
    });
  });
  it('EXPRESSION — $and/$or inside $expr inherit expression context', () => {
    expect(ctx('[{ $match: { $expr: { $or: [ { $g| } ] } } }]')).toEqual({
      position: 'key',
      keyCategory: 'EXPRESSION',
    });
  });
  it('EXPRESSION — $expr inside $match beats $match', () => {
    expect(ctx('[{ $match: { $expr: { $g| } } }]')).toEqual({
      position: 'key',
      keyCategory: 'EXPRESSION',
    });
  });
  it('EXPRESSION — computed value in $project / $addFields', () => {
    expect(ctx('[{ $project: { y: { $toU| } } }]')).toEqual({
      position: 'key',
      keyCategory: 'EXPRESSION',
    });
    expect(ctx('[{ $addFields: { y: { $a| } } }]')).toEqual({
      position: 'key',
      keyCategory: 'EXPRESSION',
    });
  });
  it('EXPRESSION — expression-operator array argument ($multiply args)', () => {
    expect(ctx('[{ $project: { y: { $multiply: [ { $a| } ] } } }]')).toEqual({
      position: 'key',
      keyCategory: 'EXPRESSION',
    });
  });
  it('GROUP_VALUE — accumulator field in $group (non-_id)', () => {
    expect(ctx('[{ $group: { _id: "$x", total: { $su| } } }]')).toEqual({
      position: 'key',
      keyCategory: 'GROUP_VALUE',
    });
  });
  it('EXPRESSION — $group._id is an expression, not an accumulator', () => {
    expect(ctx('[{ $group: { _id: { $toU| } } }]')).toEqual({
      position: 'key',
      keyCategory: 'EXPRESSION',
    });
  });
  it('EXPRESSION — deeply nested $group._id composite key stays an expression', () => {
    expect(ctx('[{ $group: { _id: { region: { $toU| } } } }]')).toEqual({
      position: 'key',
      keyCategory: 'EXPRESSION',
    });
  });
  it('GROUP_VALUE — $setWindowFields output accumulator', () => {
    expect(ctx('[{ $setWindowFields: { output: { r: { $ra| } } } }]')).toEqual({
      position: 'key',
      keyCategory: 'GROUP_VALUE',
    });
  });
  it('FIELD_REF — string value starting with $', () => {
    expect(ctx('[{ $project: { y: "$fie|" } }]')).toEqual({ position: 'value', keyCategory: null });
    expect(ctx('[{ $match: { $expr: { $gt: ["$am|", 5] } } }]')).toEqual({
      position: 'value',
      keyCategory: null,
    });
  });
  it('plain field-name key position (no $)', () => {
    expect(ctx('[{ $sort: { amo| } }]')).toEqual({ position: 'key', keyCategory: 'EXPRESSION' });
  });
  it('UNKNOWN — plain string value (not $) and whitespace', () => {
    expect(ctx('[{ $match: { status: "act|" } }]')).toEqual({
      position: 'value',
      keyCategory: null,
    });
  });
});

import { CompletionContext } from '@codemirror/autocomplete';
import { makeCompletionSource, extractFieldNames } from '../src/mdh/pipelineCompletions.js';

// Run the aggregate source at a '|' cursor; fields = sample field names.
function complete(code: any, fields: any[] = []) {
  const pos = code.indexOf('|');
  const doc = code.slice(0, pos) + code.slice(pos + 1);
  const state = EditorState.create({ doc, extensions: [javascript()] });
  ensureSyntaxTree(state, doc.length, 5000);
  const source = makeCompletionSource('aggregate', () => fields);
  const cc = new CompletionContext(state, pos, /* explicit */ true);
  return source(cc);
}
const labels = (res: any) => (res ? res.options.map((o: any) => o.label) : null);

describe('extractFieldNames', () => {
  it('collects dotted paths and sorts', () => {
    expect(
      extractFieldNames([
        { a: 1, b: { c: 2 } },
        { a: 1, d: 3 },
      ]),
    ).toEqual(['a', 'b', 'b.c', 'd']);
  });

  it('descends one level into arrays of objects', () => {
    const names = extractFieldNames([{ items: [{ sku: 'a', qty: 1 }], name: 'x' }]);
    expect(names).toContain('name');
    expect(names).toContain('items.sku');
    expect(names).toContain('items.qty');
  });
});

describe('aggregate completion source', () => {
  it('STAGE position offers stages, not query/expression operators', () => {
    const out = labels(complete('[{ $ma| }]'));
    expect(out).toContain('$match');
    expect(out).toContain('$group');
    expect(out).not.toContain('$gt');
    expect(out).not.toContain('$toInt');
  });
  it('QUERY position inside $match offers query operators only', () => {
    const out = labels(complete('[{ $match: { amount: { $| } } }]'));
    expect(out).toContain('$gt');
    expect(out).toContain('$in');
    expect(out).not.toContain('$match');
  });
  it('GROUP_VALUE offers accumulators (and expression args)', () => {
    const out = labels(complete('[{ $group: { _id: "$x", total: { $| } } }]'));
    expect(out).toContain('$sum');
    expect(out).toContain('$push');
    expect(out).not.toContain('$match');
  });
  it('no startsWith pre-filter — fuzzy can still reach $group from "grp"', () => {
    const res = complete('[{ $grp| }]');
    expect(labels(res)).toContain('$group');
    expect((res as any).validFor).toBeInstanceOf(RegExp);
  });
  it('FIELD_REF — string value starting with $ offers $-prefixed fields + system vars', () => {
    const out = labels(
      complete('[{ $project: { y: "$am|" } }]', ['amount', 'amount.net', 'vendor']),
    );
    expect(out).toContain('$amount');
    expect(out).toContain('$amount.net');
    expect(out).toContain('$$ROOT');
    expect(out).not.toContain('$match');
  });
  it('FIELD_REF — $$ prefix offers only system vars', () => {
    const out = labels(complete('[{ $project: { y: "$$R|" } }]', ['amount']));
    expect(out).toContain('$$ROOT');
    expect(out).not.toContain('$amount');
  });
  it('plain field-name key offers field names', () => {
    const out = labels(complete('[{ $sort: { am| } }]', ['amount', 'vendor']));
    expect(out).toContain('amount');
    expect(out).toContain('vendor');
    expect(out).not.toContain('$amount');
  });
  it('returns null for a plain (non-$) string value', () => {
    expect(complete('[{ $match: { status: "ac|" } }]', ['amount'])).toBeNull();
  });
  it('the from offset sits after an opening quote', () => {
    const res = complete('[{ "$ma|" }]');
    expect(res!.from).toBe(4);
  });
});

describe('non-aggregate modes keep union behavior', () => {
  it('query mode still offers query operators for $-token (no classifier)', () => {
    const doc = '{ "$g }';
    const state = EditorState.create({ doc, extensions: [javascript()] });
    const source = makeCompletionSource('query', null);
    const res = source(new CompletionContext(state, 4, true));
    expect(res!.options.map((o) => o.label)).toContain('$gt');
  });
});
