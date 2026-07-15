// Pure display helpers for the deliverable list.
export function deliverableTitle(text) {
  const line = String(text || '').split('\n').map((l) => l.trim()).find((l) => l.length);
  if (!line) return 'Untitled';
  return line.replace(/^#+\s*/, '').replace(/[*_`>]/g, '').trim().slice(0, 80) || 'Untitled';
}

// The title to show for a deliverable: an explicit (AI-generated or renamed)
// title if present, else derived from the Markdown first line.
export function displayTitle(d) {
  const t = d && typeof d.title === 'string' ? d.title.trim() : '';
  return t || deliverableTitle(d ? d.text : '');
}

// One-line plain-text summary of Markdown evidence for the collapsed verdict
// banner: first non-empty, non-fence line, stripped of markdown marks + capped.
export function summaryLine(text, max = 120) {
  const line = String(text || '').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('```')) || '';
  const clean = line.replace(/^#+\s*/, '').replace(/^[-*>]\s+/, '').replace(/[*_`]/g, '').trim();
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
}

export function relativeTime(ms, now) {
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
