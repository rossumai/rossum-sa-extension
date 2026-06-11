import { describe, it, expect } from 'vitest';
import { mapPlaceholdersToFields as map } from '../src/mdh/placeholderFields.js';

describe('mapPlaceholdersToFields', () => {
  it('direct equality maps to the field', () => {
    expect(map('[{"$match":{"code":"{code}"}}]')).toEqual({ code: { field: 'code', op: '$eq' } });
  });
  it('comparison operators map to the field', () => {
    expect(map('[{"$match":{"qty":{"$gte":"{q}"}}}]')).toEqual({ q: { field: 'qty', op: '$gte' } });
  });
  it('$in array element maps to the field', () => {
    expect(map('[{"$match":{"sku":{"$in":["{a}","x"]}}}]')).toEqual({ a: { field: 'sku', op: '$in' } });
  });
  it('$expr maps the field-path operand', () => {
    expect(map('[{"$match":{"$expr":{"$eq":["$total","{t}"]}}}]')).toEqual({ t: { field: 'total', op: '$eq' } });
  });
  it('dotted key maps to the dotted path; nested object does NOT', () => {
    expect(map('[{"$match":{"address.zip":"{z}"}}]')).toEqual({ z: { field: 'address.zip', op: '$eq' } });
    expect(map('[{"$match":{"address":{"zip":"{z}"}}}]')).toEqual({});
  });
  it('same name on different fields across $or branches is ambiguous', () => {
    expect(map('[{"$match":{"$or":[{"a":{"$eq":"{x}"}},{"b":{"$eq":"{x}"}}]}}]')).toEqual({ x: { ambiguous: true } });
  });
  it('same name on the SAME field across $or branches resolves', () => {
    expect(map('[{"$match":{"$or":[{"a":"{x}"},{"a":{"$eq":"{x}"}}]}}]')).toEqual({ x: { field: 'a', op: '$eq' } });
  });
  it('modifier placeholders are skipped (they force array/string)', () => {
    expect(map('[{"$match":{"tags":"{t | split(\',\')}"}}]')).toEqual({});
  });
  it('non-$match / non-comparison positions are unresolved', () => {
    expect(map('[{"$limit":"{n}"}]')).toEqual({});
    expect(map('[{"$project":{"x":"{p}"}}]')).toEqual({});
  });
  it('unparseable text yields {}', () => {
    expect(map('[{"$match": ]')).toEqual({});
  });
});
