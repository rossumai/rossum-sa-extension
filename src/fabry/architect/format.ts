// Pure display helpers for the deliverable list.
export function deliverableTitle(text: unknown): string {
  const line = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length);
  if (!line) return 'Untitled';
  return (
    line
      .replace(/^#+\s*/, '')
      .replace(/[*_`>]/g, '')
      .trim()
      .slice(0, 80) || 'Untitled'
  );
}

// The name a deliverable declares for ITSELF: a Markdown heading on the first
// non-empty line. The pattern is copied from src/ui/fabry/markdown.js:76 on
// purpose — it must accept exactly what the Preview tab RENDERS as a heading
// (`#`–`####`, a space after the hashes, column 0, untrimmed), so a deliverable
// is never named after a line the user sees as plain text.
export function headingTitle(text: unknown): string | null {
  const line = String(text || '')
    .split('\n')
    .find((l) => l.trim());
  const m = line && line.match(/^(#{1,4})\s+(.*)$/);
  if (!m) return '';
  return m[2].replace(/[*_`]/g, '').trim().slice(0, 80);
}

// The title to show for a deliverable, most explicit first:
//   1. a manual rename (titleSource 'manual') — the one deliberate user override
//   2. the Markdown heading the text declares for itself
//   3. a stored title: AI-generated, or LEGACY (written before titleSource
//      existed, so it reads as AI-generated — which is what lets the heading
//      rule reach deliverables that already exist)
//   4. the derived first line, else 'Untitled'
export function displayTitle(d: any): string {
  const t = d && typeof d.title === 'string' ? d.title.trim() : '';
  if (t && d.titleSource === 'manual') return t;
  return headingTitle(d ? d.text : '') || t || deliverableTitle(d ? d.text : '');
}

// One-line plain-text summary of Markdown evidence for the collapsed verdict
// banner: first non-empty, non-fence line, stripped of markdown marks + capped.
export function summaryLine(text: unknown, max = 120): string {
  const line =
    String(text || '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('```')) || '';
  const clean = line
    .replace(/^#+\s*/, '')
    .replace(/^[-*>]\s+/, '')
    .replace(/[*_`]/g, '')
    .trim();
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
}

export function relativeTime(ms: number | null, now?: number): string {
  if (!ms) return '';
  const diff = Math.max(0, (now || 0) - ms);
  if (diff < 45_000) return 'just now';
  const m = Math.round(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(diff / 3_600_000);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(diff / 86_400_000);
  return `${d}d ago`;
}
