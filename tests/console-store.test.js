import { describe, it, expect } from 'vitest';
import { activeApp } from '../src/console/store.js';

describe('console store', () => {
  it('defaults to mdh', () => {
    expect(activeApp.value).toBe('mdh');
  });

  it('can switch to audit and back', () => {
    activeApp.value = 'audit';
    expect(activeApp.value).toBe('audit');
    activeApp.value = 'mdh';
    expect(activeApp.value).toBe('mdh');
  });
});
