import { describe, it, expect } from 'vitest';
import * as fabryStore from '../src/fabry/store.js';

describe('implementAllowed gate signal', () => {
  it('defaults to true (on by default — popup kill-switch removed 2026-07-14)', () => {
    expect(fabryStore.implementAllowed.value).toBe(true);
  });
});
