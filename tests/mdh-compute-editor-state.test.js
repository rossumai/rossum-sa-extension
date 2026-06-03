// @vitest-environment jsdom
//
// A variable is ONLY a whole quoted value "{name}" (what MDH supports). A {...}
// that is part of a larger string is literal data — e.g. the user's
// "GBL CS WLD FLG {A105N} CSF DC N/STK". Unfilled variables substitute to an
// empty string (a valid value), so the pipeline still parses and runs.
//
import { describe, it, expect } from 'vitest';
import { h, render } from 'preact';
import { usePipeline } from '../src/mdh/hooks/usePipeline.js';

function getPipeline() {
  let api;
  render(h(() => { api = usePipeline(); return null; }, null), document.createElement('div'));
  return api;
}

describe('computeEditorState — variables are whole quoted values', () => {
  it('an unfilled "{name}" surfaces the name and substitutes an empty string', () => {
    const p = getPipeline();
    const r = p.computeEditorState('[{"$match":{"vendor":"{vendor}"}}]');
    expect(r.placeholders).toEqual(['vendor']);
    expect(r.parsed).toEqual([{ $match: { vendor: '' } }]); // empty string, still runnable
  });

  it('a filled string value substitutes as a JSON string', () => {
    const p = getPipeline();
    p.setPlaceholder('vendor', 'ACME');
    expect(p.computeEditorState('[{"$match":{"vendor":"{vendor}"}}]').parsed)
      .toEqual([{ $match: { vendor: 'ACME' } }]);
  });

  it('a filled numeric value substitutes as a JSON number (type-aware)', () => {
    const p = getPipeline();
    p.setPlaceholder('amount', '5');
    expect(p.computeEditorState('[{"$match":{"amount":"{amount}"}}]').parsed)
      .toEqual([{ $match: { amount: 5 } }]);
  });

  it('bool/null values substitute as JSON literals', () => {
    const p = getPipeline();
    p.setPlaceholder('flag', 'true');
    expect(p.computeEditorState('[{"$match":{"active":"{flag}"}}]').parsed)
      .toEqual([{ $match: { active: true } }]);
  });

  it('multiple variables: unfilled ones default to empty until filled', () => {
    const p = getPipeline();
    p.setPlaceholder('a', '1');
    let r = p.computeEditorState('[{"$match":{"a":"{a}","b":"{b}"}}]');
    expect([...r.placeholders].sort()).toEqual(['a', 'b']);
    expect(r.parsed).toEqual([{ $match: { a: 1, b: '' } }]); // b unfilled → empty
    p.setPlaceholder('b', '2');
    r = p.computeEditorState('[{"$match":{"a":"{a}","b":"{b}"}}]');
    expect(r.parsed).toEqual([{ $match: { a: 1, b: 2 } }]);
  });

  it('genuine syntax error: no variables, parsed null', () => {
    const p = getPipeline();
    const r = p.computeEditorState('[{"$match": ]');
    expect(r.placeholders).toEqual([]);
    expect(r.parsed).toBeNull();
  });

  it('valid JSON that is not an array yields parsed null', () => {
    const p = getPipeline();
    expect(p.computeEditorState('{"$match":{}}').parsed).toBeNull();
  });
});

describe('only a whole quoted "{name}" counts as a variable', () => {
  const lineDesc = '[{"$match":{"LINE DESC":"GBL CS WLD FLG {A105N} CSF DC N/STK"}},{"$sort":{"_id":-1}},{"$skip":0},{"$limit":50}]';

  it("treats {braces} inside a larger string as literal data (user's LINE DESC case)", () => {
    const p = getPipeline();
    expect(p.extractPlaceholders(lineDesc)).toEqual([]);
    const r = p.computeEditorState(lineDesc);
    expect(r.placeholders).toEqual([]);
    expect(r.parsed).not.toBeNull(); // → debug shows, query runs as a literal match
    expect(p.substitutePlaceholders(lineDesc)).toBe(lineDesc); // left untouched
  });

  it('a bare unquoted {name} is NOT a variable', () => {
    const p = getPipeline();
    expect(p.extractPlaceholders('[{"$match":{"amount":{amount}}}]')).toEqual([]);
  });

  it('detects a real "{name}" alongside an embedded literal of the same shape', () => {
    const p = getPipeline();
    const text = '[{"$match":{"vendor":"{vendor}","note":"see {A105N} ref"}}]';
    expect(p.extractPlaceholders(text)).toEqual(['vendor']);
  });

  it('handles escaped quotes without breaking string tracking', () => {
    const p = getPipeline();
    const text = '[{"$match":{"q":"a \\" b {x} c"}}]';
    expect(p.extractPlaceholders(text)).toEqual([]);
  });
});
