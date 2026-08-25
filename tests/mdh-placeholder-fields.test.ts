import { describe, it, expect } from 'vitest';
import { mapPlaceholdersToFields as map, mapPlaceholdersToFields } from '../src/mdh/placeholderFields.js';

describe('mapPlaceholdersToFields', () => {
  it('direct equality maps to the field', () => {
    expect(map('[{"$match":{"code":"{code}"}}]')).toEqual({ code: { field: 'code', collection: null, op: '$eq' } });
  });
  it('comparison operators map to the field', () => {
    expect(map('[{"$match":{"qty":{"$gte":"{q}"}}}]')).toEqual({ q: { field: 'qty', collection: null, op: '$gte' } });
  });
  it('$in array element maps to the field', () => {
    expect(map('[{"$match":{"sku":{"$in":["{a}","x"]}}}]')).toEqual({ a: { field: 'sku', collection: null, op: '$in' } });
  });
  it('$expr maps the field-path operand', () => {
    expect(map('[{"$match":{"$expr":{"$eq":["$total","{t}"]}}}]')).toEqual({ t: { field: 'total', collection: null, op: '$eq' } });
  });
  it('dotted key maps to the dotted path; nested object does NOT', () => {
    expect(map('[{"$match":{"address.zip":"{z}"}}]')).toEqual({ z: { field: 'address.zip', collection: null, op: '$eq' } });
    expect(map('[{"$match":{"address":{"zip":"{z}"}}}]')).toEqual({});
  });
  it('same name on different fields across $or branches is ambiguous', () => {
    expect(map('[{"$match":{"$or":[{"a":{"$eq":"{x}"}},{"b":{"$eq":"{x}"}}]}}]')).toEqual({ x: { ambiguous: true } });
  });
  it('same name on the SAME field across $or branches resolves', () => {
    expect(map('[{"$match":{"$or":[{"a":"{x}"},{"a":{"$eq":"{x}"}}]}}]')).toEqual({ x: { field: 'a', collection: null, op: '$eq' } });
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

describe('mapPlaceholdersToFields — collection-aware', () => {
  it('top-level $match maps to the active collection (null)', () => {
    const text = JSON.stringify([{ $match: { vat: '{sender_vat}' } }]);
    expect(mapPlaceholdersToFields(text)).toEqual({
      sender_vat: { field: 'vat', collection: null, op: '$eq' },
    });
  });

  it('descends into $unionWith.coll (raw coll string, may contain vars)', () => {
    const text = JSON.stringify([
      { $match: { _id: '#' } },
      { $unionWith: { coll: '_{prefix}_material_match', pipeline: [
        { $match: { customer_match: '{customer_match}' } },
      ] } },
    ]);
    expect(mapPlaceholdersToFields(text)).toEqual({
      customer_match: { field: 'customer_match', collection: '_{prefix}_material_match', op: '$eq' },
    });
  });

  it('descends into $lookup.pipeline against the from collection', () => {
    const text = JSON.stringify([
      { $lookup: { from: 'PROD_Materials', as: 'm', pipeline: [
        { $match: { code: '{item_code}' } },
      ] } },
    ]);
    expect(mapPlaceholdersToFields(text)).toEqual({
      item_code: { field: 'code', collection: 'PROD_Materials', op: '$eq' },
    });
  });

  it('same name against two different collections → ambiguous', () => {
    const text = JSON.stringify([
      { $match: { id: '{x}' } },
      { $unionWith: { coll: 'other', pipeline: [{ $match: { id: '{x}' } }] } },
    ]);
    expect(mapPlaceholdersToFields(text)).toEqual({ x: { ambiguous: true } });
  });

  it('skips a $unionWith with no coll (e.g. $documents) — no false active-collection mapping', () => {
    const text = JSON.stringify([
      { $unionWith: { pipeline: [{ $match: { k: '{v}' } }] } },
    ]);
    expect(mapPlaceholdersToFields(text)).toEqual({});
  });

  it('$facet sub-pipelines resolve against the same (active) collection', () => {
    const text = JSON.stringify([
      { $facet: { a: [{ $match: { f: '{v}' } }] } },
    ]);
    expect(mapPlaceholdersToFields(text)).toEqual({
      v: { field: 'f', collection: null, op: '$eq' },
    });
  });

  it('returns {} on parse failure', () => {
    expect(mapPlaceholdersToFields('not json')).toEqual({});
  });
});
