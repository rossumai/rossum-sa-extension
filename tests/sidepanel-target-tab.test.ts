import { describe, it, expect } from 'vitest';
import { isRossumTab, sameTarget, viewState } from '../src/sidepanel/targetTab.js';

const R = 'https://org.rossum.app';

// The annotation-id parsing this module used to own now lives in
// src/rossum/annotationUrl.js — see tests/rossum-annotation-url.test.js.

describe('isRossumTab / viewState', () => {
  it('accepts Rossum hosts and the localhost dev origin', () => {
    expect(isRossumTab({ url: `${R}/document/1` })).toBe(true);
    expect(isRossumTab({ url: 'https://elis.rossum.ai/queues/2' })).toBe(true);
    expect(isRossumTab({ url: 'http://localhost:3000/document/1' })).toBe(true);
  });

  it('rejects other sites and tabs whose URL is not readable', () => {
    expect(isRossumTab({ url: 'https://example.com/' })).toBe(false);
    expect(isRossumTab({})).toBe(false);
    expect(isRossumTab(null)).toBe(false);
  });

  it('maps a tab to a view state', () => {
    expect(viewState(null)).toBe('no-tab');
    expect(viewState({ url: 'https://example.com/' })).toBe('unsupported');
    expect(viewState({ url: `${R}/document/1` })).toBe('ready');
  });
});

describe('sameTarget', () => {
  it('is true only when both the tab id and the URL match', () => {
    expect(sameTarget({ id: 1, url: `${R}/document/1` }, { id: 1, url: `${R}/document/1` })).toBe(
      true,
    );
    expect(sameTarget({ id: 1, url: `${R}/document/1` }, { id: 1, url: `${R}/document/2` })).toBe(
      false,
    );
    expect(sameTarget({ id: 1, url: `${R}/document/1` }, { id: 2, url: `${R}/document/1` })).toBe(
      false,
    );
  });

  it('is false when either side is missing', () => {
    expect(sameTarget(null, { id: 1, url: R })).toBe(false);
    expect(sameTarget({ id: 1, url: R }, null)).toBe(false);
    expect(sameTarget(null, null)).toBe(false);
  });
});
