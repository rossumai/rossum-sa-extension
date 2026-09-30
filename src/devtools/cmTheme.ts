// Editor palettes shared by the JSON editor and the version diff, so both read alike.
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

// Approximate DevTools' JSON/source palette (exact tokens aren't exposed to
// extension panels — only the theme name). Tune in dogfood.
export const lightHL = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.propertyName, color: '#881391' },
    { tag: tags.string, color: '#c41a16' },
    { tag: tags.number, color: '#1c00cf' },
    { tag: tags.bool, color: '#0842a0' },
    { tag: tags.null, color: '#808080' },
    { tag: tags.keyword, color: '#881391' },
  ]),
);
export const darkHL = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.propertyName, color: '#5db0d7' },
    { tag: tags.string, color: '#f29766' },
    { tag: tags.number, color: '#9980ff' },
    { tag: tags.bool, color: '#569cd6' },
    { tag: tags.null, color: '#808080' },
    { tag: tags.keyword, color: '#c586c0' },
  ]),
);
// Editor surface inherits the panel's theme-aware background (no oneDark dark surface).
// The gutter is sticky, so it needs a REAL background: a transparent one lets horizontally
// scrolled code show through the line numbers.
export const surfaceTheme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'var(--fg)' },
  '.cm-gutters': { backgroundColor: 'var(--bg)', color: '#888', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'rgba(128,128,128,0.08)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
});
