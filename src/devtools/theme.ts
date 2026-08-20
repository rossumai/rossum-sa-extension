// src/devtools/theme.ts
// Is the DevTools panel showing a dark theme? Prefer the canonical DevTools theme;
// fall back to the OS/browser color-scheme (guarded — jsdom lacks matchMedia).
export function isDark() {
  try {
    if (typeof chrome !== 'undefined' && chrome.devtools && chrome.devtools.panels && chrome.devtools.panels.themeName) {
      return chrome.devtools.panels.themeName === 'dark';
    }
  } catch { /* ignore */ }
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
}
