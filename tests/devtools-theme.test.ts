// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { isDark } from '../src/devtools/theme.js';

describe('isDark', () => {
  const origMatchMedia = window.matchMedia;
  afterEach(() => { delete (globalThis as any).chrome; window.matchMedia = origMatchMedia; });

  it('true when DevTools themeName is dark', () => {
    globalThis.chrome = ({ devtools: { panels: { themeName: 'dark' } } } as any);
    expect(isDark()).toBe(true);
  });
  it('false when DevTools themeName is default (light)', () => {
    globalThis.chrome = ({ devtools: { panels: { themeName: 'default' } } } as any);
    expect(isDark()).toBe(false);
  });
  it('falls back to matchMedia dark when DevTools theme is absent', () => {
    delete (globalThis as any).chrome;
    window.matchMedia = ((q) => ({ matches: q.includes('dark') }) as any);
    expect(isDark()).toBe(true);
  });
  it('is crash-safe and false when neither chrome nor matchMedia is available', () => {
    delete (globalThis as any).chrome;
    window.matchMedia = (undefined as any);
    expect(isDark()).toBe(false);
  });
});
