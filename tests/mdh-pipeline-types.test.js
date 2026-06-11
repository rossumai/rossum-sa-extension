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
const strInfo = { dominant: 'string', dominantBson: 'string', share: 1, distribution: [], mixed: false };

describe('usePipeline type-aware functions', () => {
  it('computeEditorStateWithTypes uses the dataset field type as default', () => {
    const p = getPipeline();
    p.setPlaceholder('code', '123');
    p.fieldTypes.value = { code: strInfo };
    expect(p.computeEditorStateWithTypes(M).parsed).toEqual([{ $match: { code: '123' } }]);
  });
  it('explicit override beats the dataset type', () => {
    const p = getPipeline();
    p.setPlaceholder('code', '123');
    p.fieldTypes.value = { code: strInfo };
    p.setPlaceholderType('code', 'number');
    expect(p.computeEditorStateWithTypes(M).parsed).toEqual([{ $match: { code: 123 } }]);
    p.setPlaceholderType('code', 'auto'); // clears
    expect(p.placeholderTypes.value.code).toBeUndefined();
  });
  it('substituteWithTypes produces the typed string', () => {
    const p = getPipeline();
    p.setPlaceholder('code', '123');
    p.fieldTypes.value = { code: strInfo };
    expect(p.substituteWithTypes(M)).toBe('[{"$match":{"code":"123"}}]');
  });
  it('referencedFields lists comparison fields, skipping ambiguous', () => {
    const p = getPipeline();
    expect(p.referencedFields(M)).toEqual(['code']);
    expect(p.referencedFields('[{"$match":{"$or":[{"a":"{x}"},{"b":"{x}"}]}}]')).toEqual([]);
  });
  it('ensureFieldTypes merges resolver output and reports change', async () => {
    const p = getPipeline();
    const fake = async () => ({ code: strInfo });
    expect(await p.ensureFieldTypes('col', ['code'], fake)).toBe(true);
    expect(p.fieldTypes.value.code.dominant).toBe('string');
    expect(await p.ensureFieldTypes('col', ['code'], fake)).toBe(false); // already known
  });
  it('resolvedTypeForName reports the source for the badge', () => {
    const p = getPipeline();
    p.fieldTypes.value = { code: strInfo };
    expect(p.resolvedTypeForName('code', { code: { field: 'code', op: '$eq' } }, true)).toMatchObject({ type: 'string', source: 'field' });
  });
  it('reset clears type state', () => {
    const p = getPipeline();
    p.setPlaceholderType('code', 'number');
    p.fieldTypes.value = { code: strInfo };
    p.reset();
    expect(p.placeholderTypes.value).toEqual({});
    expect(p.fieldTypes.value).toEqual({});
  });
});
