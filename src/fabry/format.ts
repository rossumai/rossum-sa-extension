// Server summaries are markdown-flavored ("# Summary …", "**bold**") — strip
// the syntax for display so sidebar rows and the header read as plain titles.
export function sanitizeTitle(s: unknown): string {
  return String(s || '')
    .replace(/^[#\s]+/, '')
    .replace(/[*`]+/g, '') // keep _ — snake_case field names appear in real titles
    .replace(/\s+/g, ' ')
    .trim();
}

export function chatTitle(
  summary?: { summary?: string; preview?: string; first_message?: string } | null,
): string {
  return (
    sanitizeTitle(summary?.summary || summary?.preview || summary?.first_message) || '(empty chat)'
  );
}
