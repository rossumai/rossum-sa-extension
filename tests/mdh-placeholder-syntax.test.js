import { describe, it, expect } from 'vitest';
import { VAR_RE } from '../src/mdh/placeholderSyntax.js';
import { isJson5NumberLiteral } from '../src/mdh/hooks/usePipeline.js';

describe('placeholderSyntax + usePipeline exports', () => {
  it('VAR_RE matches a whole placeholder and captures name/modifier/arg', () => {
    expect(VAR_RE.exec('{code}')[1]).toBe('code');
    const m = VAR_RE.exec('{cats | split(\',\')}');
    expect([m[1], m[2], m[3]]).toEqual(['cats', 'split', "','"]);
    expect(VAR_RE.exec('id-{x}')).toBeNull();
  });
  it('isJson5NumberLiteral is exported and rejects padded/comma forms', () => {
    expect(isJson5NumberLiteral('123')).toBe(true);
    expect(isJson5NumberLiteral('1.5')).toBe(true);
    expect(isJson5NumberLiteral('007')).toBe(false);
    expect(isJson5NumberLiteral('5,000')).toBe(false);
    expect(isJson5NumberLiteral('')).toBe(false);
  });
});
