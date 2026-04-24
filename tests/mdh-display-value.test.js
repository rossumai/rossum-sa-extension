import { describe, it, expect } from 'vitest';
import {
  EJSON_TYPES,
  getEjsonType,
  formatEjsonValue,
  displayValue,
} from '../src/mdh/displayValue.js';

describe('getEjsonType', () => {
  it('returns null for primitives and arrays', () => {
    expect(getEjsonType(null)).toBeNull();
    expect(getEjsonType(42)).toBeNull();
    expect(getEjsonType('hi')).toBeNull();
    expect(getEjsonType([1, 2, 3])).toBeNull();
  });

  it('detects every single-key EJSON type', () => {
    for (const key of Object.keys(EJSON_TYPES)) {
      expect(getEjsonType({ [key]: 'whatever' })).toBe(key);
    }
  });

  it('detects $date in two-key form (with $numberLong)', () => {
    expect(getEjsonType({ $date: { $numberLong: '1700000000000' } })).toBe('$date');
  });

  it('returns null for plain objects that happen to have $-prefixed keys mixed with others', () => {
    expect(getEjsonType({ $oid: 'x', extra: 1 })).toBeNull();
    expect(getEjsonType({ foo: 1, bar: 2 })).toBeNull();
  });
});

describe('formatEjsonValue', () => {
  it('formats ObjectId', () => {
    expect(formatEjsonValue({ $oid: 'abc123' }, '$oid')).toBe('abc123');
  });

  it('formats $date ISO strings', () => {
    expect(formatEjsonValue({ $date: '2024-01-01T00:00:00Z' }, '$date')).toBe('2024-01-01T00:00:00.000Z');
  });

  it('formats $date with numeric epoch ms as { $numberLong }', () => {
    expect(formatEjsonValue({ $date: { $numberLong: '0' } }, '$date')).toBe('1970-01-01T00:00:00.000Z');
  });

  it('formats $regex with options', () => {
    expect(formatEjsonValue({ $regex: 'foo.*', $options: 'i' }, '$regex')).toBe('/foo.*/i');
  });

  it('formats $regex without options', () => {
    expect(formatEjsonValue({ $regex: 'x' }, '$regex')).toBe('/x/');
  });

  it('stringifies numeric wrappers', () => {
    expect(formatEjsonValue({ $numberLong: '123' }, '$numberLong')).toBe('123');
    expect(formatEjsonValue({ $numberDecimal: '1.5' }, '$numberDecimal')).toBe('1.5');
  });
});

describe('displayValue', () => {
  it('renders null', () => {
    expect(displayValue(null)).toBe('null');
  });

  it('renders primitives', () => {
    expect(displayValue(42)).toBe('42');
    expect(displayValue(true)).toBe('true');
  });

  it('quotes and truncates strings over 20 chars', () => {
    expect(displayValue('short')).toBe('"short"');
    expect(displayValue('a'.repeat(30))).toBe(`"${'a'.repeat(20)}..."`);
  });

  it('renders arrays by length and objects as {...}', () => {
    expect(displayValue([1, 2, 3])).toBe('[3]');
    expect(displayValue({ a: 1, b: 2 })).toBe('{...}');
  });

  it('renders EJSON values inline with truncation over 24 chars', () => {
    expect(displayValue({ $oid: '507f1f77bcf86cd799439011' })).toBe('507f1f77bcf86cd799439011');
    // An ISO date is 24 chars exactly, so no truncation:
    expect(displayValue({ $date: '2024-01-01T00:00:00Z' })).toBe('2024-01-01T00:00:00.000Z');
  });
});
