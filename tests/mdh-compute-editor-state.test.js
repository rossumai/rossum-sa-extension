// @vitest-environment jsdom
//
// A variable is ONLY a whole quoted value "{name}" (what MDH supports). A {...}
// that is part of a larger string is literal data — e.g. the user's
// "BLUE WIDGET {part_no} LARGE". Unfilled variables substitute to an
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

// A variable lives inside a string literal in two forms: WHOLE "{name}" (typed)
// and EMBEDDED "...{name}..." (substituted into the text as a string). Embedded
// is valid in Rossum/MDH — confirmed by the user and mirrored in
// src/popup/mdh-provenance.js. Only a bare {name} outside any string is not one.
describe('variables: whole-quoted (typed) and embedded (string)', () => {
  const lineDesc = '[{"$match":{"LINE DESC":"BLUE WIDGET {part_no} LARGE"}},{"$sort":{"_id":-1}},{"$skip":0},{"$limit":50}]';

  it("a {name} inside a larger string is an embedded variable (user's LINE DESC case)", () => {
    const p = getPipeline();
    expect(p.extractPlaceholders(lineDesc)).toEqual(['part_no']);
    p.setPlaceholder('part_no', 'XYZ');
    expect(p.computeEditorState(lineDesc).parsed).toEqual([
      { $match: { 'LINE DESC': 'BLUE WIDGET XYZ LARGE' } },
      { $sort: { _id: -1 } }, { $skip: 0 }, { $limit: 50 },
    ]);
  });

  it('an unfilled embedded variable substitutes to nothing (empty string), query still runs', () => {
    const p = getPipeline();
    const r = p.computeEditorState('[{"$match":{"d":"flag {part_no} stk"}}]');
    expect(r.placeholders).toEqual(['part_no']);
    expect(r.parsed).toEqual([{ $match: { d: 'flag  stk' } }]); // emptied, two spaces
  });

  it('an embedded number-looking value stays a string (only a whole "{name}" is type-aware)', () => {
    const p = getPipeline();
    p.setPlaceholder('id', '5');
    expect(p.computeEditorState('[{"$match":{"code":"id-{id}"}}]').parsed)
      .toEqual([{ $match: { code: 'id-5' } }]); // "id-5", not a number
  });

  it('multiple embedded variables in one string both substitute', () => {
    const p = getPipeline();
    p.setPlaceholder('a', 'X'); p.setPlaceholder('b', 'Y');
    expect(p.computeEditorState('[{"$match":{"k":"{a}/{b}"}}]').parsed)
      .toEqual([{ $match: { k: 'X/Y' } }]);
  });

  it('a bare unquoted {name} is NOT a variable (not inside a string literal)', () => {
    const p = getPipeline();
    expect(p.extractPlaceholders('[{"$match":{"amount":{amount}}}]')).toEqual([]);
  });

  it('detects both a whole "{name}" and an embedded {name} of the same shape', () => {
    const p = getPipeline();
    const text = '[{"$match":{"vendor":"{vendor}","note":"see {part_no} ref"}}]';
    expect([...p.extractPlaceholders(text)].sort()).toEqual(['part_no', 'vendor']);
  });

  it('handles escaped quotes without breaking string tracking, still finds the embedded var', () => {
    const p = getPipeline();
    const text = '[{"$match":{"q":"a \\" b {x} c"}}]';
    expect(p.extractPlaceholders(text)).toEqual(['x']);
    p.setPlaceholder('x', 'Z');
    expect(p.computeEditorState(text).parsed).toEqual([{ $match: { q: 'a " b Z c' } }]);
  });

  it('an embedded value with special chars is JSON-escaped (stays valid)', () => {
    const p = getPipeline();
    p.setPlaceholder('x', 'a"b\\c');
    expect(p.computeEditorState('[{"$match":{"v":"p={x}"}}]').parsed)
      .toEqual([{ $match: { v: 'p=a"b\\c' } }]);
  });
});

// Mirrors MDH's server-side substitution grammar (src/popup/mdh-provenance.js):
// a whole-quoted "{name | modifier(arg)}" — `split` → JSON array, `re` →
// regex-escaped string. Lets a provenance query open with its placeholders
// intact and still run with the right value.
describe('placeholder modifiers', () => {
  it('split(sep) substitutes a JSON array', () => {
    const p = getPipeline();
    p.setPlaceholder('cats', 'food,drink');
    const r = p.computeEditorState('[{"$match":{"tags":"{cats | split(\',\')}"}}]');
    expect(r.placeholders).toEqual(['cats']);
    expect(r.parsed).toEqual([{ $match: { tags: ['food', 'drink'] } }]);
  });

  it('split with an unfilled value yields [""] (empty-string split), still runnable', () => {
    const p = getPipeline();
    const r = p.computeEditorState('[{"$match":{"tags":"{cats | split(\',\')}"}}]');
    expect(r.placeholders).toEqual(['cats']);
    expect(r.parsed).toEqual([{ $match: { tags: [''] } }]);
  });

  // `re` mirrors the service's Python re.escape (verified live 2026-07-04):
  // spaces, `-&~#`, and whitespace/control chars are escaped too.
  it('re escapes regex specials and stays a JSON string', () => {
    const p = getPipeline();
    p.setPlaceholder('v', 'A.C. Corp');
    expect(p.computeEditorState('[{"$match":{"name":"{v | re}"}}]').parsed)
      .toEqual([{ $match: { name: 'A\\.C\\.\\ Corp' } }]);
  });

  it('re escapes space/dash/amp like the live service ("ACME (US)" → "ACME\\ \\(US\\)")', () => {
    const p = getPipeline();
    p.setPlaceholder('v', 'ACME (US)');
    expect(p.computeEditorState('[{"$match":{"name":"{v | re}"}}]').parsed)
      .toEqual([{ $match: { name: 'ACME\\ \\(US\\)' } }]);
    p.setPlaceholder('v', 'dash-mid amp&ers til~de hash#tag');
    expect(p.computeEditorState('[{"$match":{"name":"{v | re}"}}]').parsed)
      .toEqual([{ $match: { name: 'dash\\-mid\\ amp\\&ers\\ til\\~de\\ hash\\#tag' } }]);
  });

  it('re applies inside embedded placeholders ("^{v | re}$")', () => {
    const p = getPipeline();
    p.setPlaceholder('v', 'ACME (US)');
    expect(p.computeEditorState('[{"$match":{"name":{"$regex":"^{v | re}$"}}}]').parsed)
      .toEqual([{ $match: { name: { $regex: '^ACME\\ \\(US\\)$' } } }]);
  });

  it('tolerates whitespace inside the braces ("{ amount }")', () => {
    const p = getPipeline();
    p.setPlaceholder('amount', '5');
    const r = p.computeEditorState('[{"$match":{"amount":"{ amount }"}}]');
    expect(r.placeholders).toEqual(['amount']);
    expect(r.parsed).toEqual([{ $match: { amount: 5 } }]);
  });

  it('a name shared by a bare and a split placeholder uses one input value', () => {
    const p = getPipeline();
    p.setPlaceholder('x', 'a,b');
    const r = p.computeEditorState('[{"$match":{"raw":"{x}","arr":"{x | split(\',\')}"}}]');
    expect(r.placeholders).toEqual(['x']); // one variable, two uses
    expect(r.parsed).toEqual([{ $match: { raw: 'a,b', arr: ['a', 'b'] } }]);
  });

  it('an embedded split modifier stringifies the array into the surrounding text', () => {
    const p = getPipeline();
    p.setPlaceholder('x', 'a,b');
    // Embedded (not whole-quoted): mirrors mdh-provenance — the split array is
    // JSON-stringified into the string.
    expect(p.computeEditorState('[{"$match":{"note":"see {x | split(\',\')} ref"}}]').parsed)
      .toEqual([{ $match: { note: 'see ["a","b"] ref' } }]);
  });
});
