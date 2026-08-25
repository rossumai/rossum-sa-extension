import { describe, it, expect } from 'vitest';
import {
  EJSON_TYPES,
  getEjsonType,
  formatEjsonValue,
  displayValue,
  copyTextFor,
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

  it('detects the legacy 2-key $regex/$options form', () => {
    expect(getEjsonType({ $regex: 'ab', $options: 'i' })).toBe('$regex');
  });

  it('does not loosen the 2-key match beyond $date and $regex/$options', () => {
    expect(getEjsonType({ $regex: 'ab', extra: 1 })).toBeNull();
    expect(getEjsonType({ $options: 'i', extra: 1 })).toBeNull();
  });

  it('every EJSON type has a non-empty short tag and a label', () => {
    for (const [key, info] of Object.entries(EJSON_TYPES)) {
      expect(typeof info.label, key).toBe('string');
      expect(info.label.length, key).toBeGreaterThan(0);
      expect(typeof info.short, key).toBe('string');
      expect(info.short.length, key).toBeGreaterThan(0);
      // tags are meant to be compact + lowercase
      expect(info.short, key).toBe(info.short.toLowerCase());
      expect(info.short.length, key).toBeLessThanOrEqual(4);
    }
  });

  it('uses the agreed compact tags', () => {
    expect(EJSON_TYPES.$oid.short).toBe('oid');
    expect(EJSON_TYPES.$date.short).toBe('date');
    expect(EJSON_TYPES.$timestamp.short).toBe('ts');
    expect(EJSON_TYPES.$binary.short).toBe('bin');
    expect(EJSON_TYPES.$regex.short).toBe('re');
    // numeric subtypes fold to "num"
    expect(EJSON_TYPES.$numberLong.short).toBe('num');
    expect(EJSON_TYPES.$numberInt.short).toBe('num');
    expect(EJSON_TYPES.$numberDouble.short).toBe('num');
    expect(EJSON_TYPES.$numberDecimal.short).toBe('num');
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

  // Regression: $binary and $timestamp carry OBJECT payloads, and the final
  // `return String(inner)` fallback is only correct for a scalar payload.
  it('never yields "[object Object]" for an object-payload EJSON wrapper', () => {
    const binary = { $binary: { base64: 'AA==', subType: '00' } };
    const formatted = formatEjsonValue(binary, '$binary');
    expect(formatted).not.toBe('[object Object]');
    expect(formatted).toBe(JSON.stringify(binary.$binary));
  });

  it('JSON-encodes a $timestamp payload rather than stringifying the object', () => {
    const timestamp = { $timestamp: { t: 1, i: 2 } };
    expect(formatEjsonValue(timestamp, '$timestamp')).toBe(JSON.stringify(timestamp.$timestamp));
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

  it('renders the legacy 2-key regex form as /pattern/flags, not {...}', () => {
    expect(displayValue({ $regex: 'ab', $options: 'i' })).toBe('/ab/i');
  });
});

describe('copyTextFor', () => {
  it('returns strings without surrounding quotes', () => {
    expect(copyTextFor('hello world')).toBe('hello world');
    expect(copyTextFor('')).toBe('');
  });

  it('returns numbers and booleans as plain strings', () => {
    expect(copyTextFor(42)).toBe('42');
    expect(copyTextFor(3.14)).toBe('3.14');
    expect(copyTextFor(true)).toBe('true');
    expect(copyTextFor(false)).toBe('false');
  });

  it('returns the literal "null" for null', () => {
    expect(copyTextFor(null)).toBe('null');
  });

  it('returns the inner formatted EJSON value, not the wrapper', () => {
    expect(copyTextFor({ $oid: '507f1f77bcf86cd799439011' })).toBe('507f1f77bcf86cd799439011');
    expect(copyTextFor({ $date: '2024-01-01T00:00:00Z' })).toBe('2024-01-01T00:00:00.000Z');
    expect(copyTextFor({ $numberLong: '123' })).toBe('123');
    expect(copyTextFor({ $numberDecimal: '1.5' })).toBe('1.5');
    expect(copyTextFor({ $regex: 'foo' })).toBe('/foo/');
  });

  it('returns pretty-printed JSON for plain objects', () => {
    expect(copyTextFor({ a: 1, b: 'two' })).toBe('{\n  "a": 1,\n  "b": "two"\n}');
  });

  it('returns pretty-printed JSON for arrays', () => {
    expect(copyTextFor([1, 2, 3])).toBe('[\n  1,\n  2,\n  3\n]');
  });

  it('preserves long strings verbatim (no truncation, no quotes)', () => {
    const long = 'a'.repeat(100);
    expect(copyTextFor(long)).toBe(long);
  });
});
