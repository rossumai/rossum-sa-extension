// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { isValidApp } from '../src/console/boot.js';

describe('console shell — inspector app', () => {
  it('inspector is a valid console app', () => {
    expect(isValidApp('inspector')).toBe(true);
    expect(isValidApp('mdh')).toBe(true);
    expect(isValidApp('audit')).toBe(true);
    expect(isValidApp('galaxy')).toBe(true);
    expect(isValidApp('nope')).toBe(false);
  });
});
