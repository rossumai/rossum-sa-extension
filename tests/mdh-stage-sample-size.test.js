// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { coerceStageSampleSize, STAGE_SAMPLE_SIZES } from '../src/mdh/store.js';

describe('coerceStageSampleSize', () => {
  it('passes through the allowed sizes', () => {
    for (const n of STAGE_SAMPLE_SIZES) {
      expect(coerceStageSampleSize(n)).toBe(n);
    }
  });

  it('coerces stringified allowed sizes (storage round-trips can stringify)', () => {
    expect(coerceStageSampleSize('25')).toBe(25);
    expect(coerceStageSampleSize('50')).toBe(50);
  });

  it('falls back to 10 for out-of-set, junk, or missing values', () => {
    expect(coerceStageSampleSize(7)).toBe(10);
    expect(coerceStageSampleSize(1000)).toBe(10);
    expect(coerceStageSampleSize(0)).toBe(10);
    expect(coerceStageSampleSize(-5)).toBe(10);
    expect(coerceStageSampleSize('lots')).toBe(10);
    expect(coerceStageSampleSize(null)).toBe(10);
    expect(coerceStageSampleSize(undefined)).toBe(10);
    expect(coerceStageSampleSize(NaN)).toBe(10);
  });

  it('keeps 10 (the default) in the allowed set for backward compatibility', () => {
    expect(STAGE_SAMPLE_SIZES).toContain(10);
  });
});
