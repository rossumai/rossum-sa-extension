// W6: ONE copy of "a rejection may never say nothing".
//
// Ruling 27 fixed that at the root once and a later round found a fifth site that had missed it, so
// the rule had become four identical literals in four modules — `assets.ts`, `assetPrefetch.ts`,
// `AssetsPanel.tsx` and `SourceEditor.tsx`. Each of those four still has a test proving its own
// message; this one is about the shared answer, because that is what a fifth site will import.
import { describe, expect, it } from 'vitest';
import { message } from '../src/fabry/architect/errorText.js';

describe('message', () => {
  it('reads an Error', () => {
    expect(message(new Error('401 Unauthorized'))).toBe('401 Unauthorized');
  });

  it('reads a transport that rejected with a bare string', () => {
    expect(message('Session expired.')).toBe('Session expired.');
  });

  // The whole point. `indexError` doubles as the flag for "the read failed", so an empty answer here
  // is a failed read that reads as no error at all: nothing on screen, the upload controls still on,
  // and every upload refused one file at a time by a Retry button that was never rendered.
  // The whole point, and there is exactly ONE input that gets here: `Promise.reject('')`, which is
  // a gateway answering with an empty body. Everything else stringifies to something — an `Error`
  // with no message is 'Error', an object is '[object Object]', `null` is 'null'. All ugly, all
  // non-empty, and non-empty is the property `indexError` depends on.
  it('is never the empty string', () => {
    expect(message('')).toBe('the request failed with no reason given');
  });

  it('leaves every other shape with whatever it stringifies to, rather than inventing a message', () => {
    expect(message(new Error(''))).toBe('Error');
    expect(message(null)).toBe('null');
    expect(message({ message: '' })).toBe('[object Object]');
  });
});
