// Pure helpers for the sidebar's search-first filtering (design round 6, F1).
import { chatTitle } from './format.js';

// Case-insensitive substring filter over the display title.
export function filterChats(chats, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return chats;
  return (chats || []).filter((c) => chatTitle(c).toLowerCase().includes(q));
}

// Split a title into segments for match highlighting: [{text, hit}].
export function titleSegments(title, query) {
  const s = String(title || '');
  const q = String(query || '').trim();
  if (!q) return [{ text: s, hit: false }];
  const out = [];
  const lower = s.toLowerCase();
  const ql = q.toLowerCase();
  let i = 0;
  for (;;) {
    const at = lower.indexOf(ql, i);
    if (at === -1) { if (i < s.length) out.push({ text: s.slice(i), hit: false }); break; }
    if (at > i) out.push({ text: s.slice(i, at), hit: false });
    out.push({ text: s.slice(at, at + q.length), hit: true });
    i = at + q.length;
  }
  return out.length ? out : [{ text: s, hit: false }];
}
