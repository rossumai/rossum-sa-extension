// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h, render } from 'preact';
import { usePipeline } from '../src/mdh/hooks/usePipeline.js';

function getPipeline() {
  let api;
  render(h(() => { api = usePipeline(); return null; }, null), document.createElement('div'));
  return api;
}
const M = '[{"$match":{"code":"{code}"}}]';

describe('computeEditorState with explicit resolvedTypes', () => {
  it('string type forces a numeric-looking value to a string', () => {
    const p = getPipeline();
    p.setPlaceholder('code', '123');
    expect(p.computeEditorState(M, { code: 'string' }).parsed).toEqual([{ $match: { code: '123' } }]);
  });
  it('null vs string "null"', () => {
    const p = getPipeline();
    p.setPlaceholder('code', 'null');
    expect(p.computeEditorState(M, { code: 'string' }).parsed).toEqual([{ $match: { code: 'null' } }]);
    expect(p.computeEditorState(M, { code: 'null' }).parsed).toEqual([{ $match: { code: null } }]);
  });
  it('number type with non-numeric value falls back to a quoted string (parse-safe)', () => {
    const p = getPipeline();
    p.setPlaceholder('code', 'abc');
    expect(p.computeEditorState(M, { code: 'number' }).parsed).toEqual([{ $match: { code: 'abc' } }]);
  });
  it('boolean type with non-bool value falls back to a quoted string', () => {
    const p = getPipeline();
    p.setPlaceholder('code', 'yes');
    expect(p.computeEditorState(M, { code: 'boolean' }).parsed).toEqual([{ $match: { code: 'yes' } }]);
  });
  it('no resolvedTypes → byte-identical value-based (numeric → number)', () => {
    const p = getPipeline();
    p.setPlaceholder('code', '5');
    expect(p.computeEditorState(M).parsed).toEqual([{ $match: { code: 5 } }]);
  });
  it('computeEditorState returns a fieldMap', () => {
    const p = getPipeline();
    expect(p.computeEditorState(M).fieldMap).toEqual({ code: { field: 'code', op: '$eq' } });
  });
});
