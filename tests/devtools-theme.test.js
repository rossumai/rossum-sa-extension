// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { isDark } from '../src/devtools/theme.js';

describe('isDark', () => {
  const origMatchMedia = window.matchMedia;
  afterEach(() => { delete globalThis.chrome; window.matchMedia = origMatchMedia; });

  it('true when DevTools themeName is dark', () => {
    globalThis.chrome = { devtools: { panels: { themeName: 'dark' } } };
    expect(isDark()).toBe(true);
  });
  it('false when DevTools themeName is default (light)', () => {
    globalThis.chrome = { devtools: { panels: { themeName: 'default' } } };
    expect(isDark()).toBe(false);
  });
  it('falls back to matchMedia dark when DevTools theme is absent', () => {
    delete globalThis.chrome;
    window.matchMedia = (q) => ({ matches: q.includes('dark') });
    expect(isDark()).toBe(true);
  });
  it('is crash-safe and false when neither chrome nor matchMedia is available', () => {
    delete globalThis.chrome;
    window.matchMedia = undefined;
    expect(isDark()).toBe(false);
  });
});
