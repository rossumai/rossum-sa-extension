// One highlighter for whatever the resource viewer is showing.
//
// The source modal used to be hardwired to JSON, which is right for a schema and wrong for
// a hook: its implementation is Python (see resources.js formatResource). This picks the
// grammar by name, falls back to JSON — the commonest case — and, if the grammar is not in
// the curated set (src/docs/hljs.js), returns escaped text so an unhighlighted preview is
// still a readable preview.
import hljs from './hljs.js';

export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function highlightCode(text: unknown, language?: string | null): string {
  const lang = language || 'json';
  if (hljs.getLanguage(lang)) {
    try { return hljs.highlight(String(text ?? ''), { language: lang, ignoreIllegals: true }).value; }
    catch { /* fall through to plain text */ }
  }
  return escapeHtml(text);
}
