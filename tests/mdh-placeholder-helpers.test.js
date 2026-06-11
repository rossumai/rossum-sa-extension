import { describe, it, expect } from 'vitest';
import { isCompatibleWithType, valueBasedType, typeOptionsFor } from '../src/mdh/components/PlaceholderInputs.jsx';

describe('isCompatibleWithType', () => {
  it('number accepts numeric literals only', () => {
    expect(isCompatibleWithType('123', 'number')).toBe(true);
    expect(isCompatibleWithType('007', 'number')).toBe(false);
    expect(isCompatibleWithType('abc', 'number')).toBe(false);
  });
  it('boolean accepts only true/false', () => {
    expect(isCompatibleWithType('true', 'boolean')).toBe(true);
    expect(isCompatibleWithType('yes', 'boolean')).toBe(false);
  });
  it('string/null/auto always compatible', () => {
    expect(isCompatibleWithType('whatever', 'string')).toBe(true);
    expect(isCompatibleWithType('whatever', 'null')).toBe(true);
    expect(isCompatibleWithType('whatever', undefined)).toBe(true);
  });
});

describe('valueBasedType', () => {
  it('mirrors the value-based coercion order', () => {
    expect(valueBasedType('true')).toBe('boolean');
    expect(valueBasedType('false')).toBe('boolean');
    expect(valueBasedType('null')).toBe('null');
    expect(valueBasedType('123')).toBe('number');
    expect(valueBasedType('007')).toBe('string'); // not a JSON5 number
    expect(valueBasedType('abc')).toBe('string');
    expect(valueBasedType('')).toBe('string');
  });
});

describe('typeOptionsFor', () => {
  it('Auto/String/Number are always offered', () => {
    expect(typeOptionsFor('acme', '')).toEqual(['auto', 'string', 'number']);
  });
  it('Boolean only when the value is true/false', () => {
    expect(typeOptionsFor('true', '')).toEqual(['auto', 'string', 'number', 'boolean']);
    expect(typeOptionsFor('false', '')).toEqual(['auto', 'string', 'number', 'boolean']);
  });
  it('Null only when the value is empty or "null"', () => {
    expect(typeOptionsFor('', '')).toEqual(['auto', 'string', 'number', 'null']);
    expect(typeOptionsFor('null', '')).toEqual(['auto', 'string', 'number', 'null']);
  });
  it('a saved override is always included even if the value no longer qualifies', () => {
    expect(typeOptionsFor('acme', 'boolean')).toEqual(['auto', 'string', 'number', 'boolean']);
    expect(typeOptionsFor('acme', 'null')).toEqual(['auto', 'string', 'number', 'null']);
  });
});
