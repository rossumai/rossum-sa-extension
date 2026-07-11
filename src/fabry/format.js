// ChatSummary.timestamp units are not documented; treat values that are too
// small to be milliseconds as seconds.
export function tsToMs(ts) {
  return ts > 1e12 ? ts : ts * 1000;
}

export function relativeTime(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

// Server summaries are markdown-flavored ("# Summary …", "**bold**") — strip
// the syntax for display so sidebar rows and the header read as plain titles.
export function sanitizeTitle(s) {
  return String(s || '')
    .replace(/^[#\s]+/, '')
    .replace(/[*`]+/g, '') // keep _ — snake_case field names appear in real titles
    .replace(/\s+/g, ' ')
    .trim();
}

export function chatTitle(summary) {
  return sanitizeTitle(summary?.summary || summary?.preview || summary?.first_message) || '(empty chat)';
}

