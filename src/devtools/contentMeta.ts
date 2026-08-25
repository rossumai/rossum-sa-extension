// PURE helpers for previewing binary API responses.
const EXT = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/svg+xml': 'svg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/csv': 'csv',
  'text/plain': 'txt',
  'application/zip': 'zip',
  'application/xml': 'xml',
  'text/xml': 'xml',
};

export function extFor(contentType?: string | null): string {
  const ct = (contentType || '').split(';')[0].trim().toLowerCase();
  if (EXT[ct as keyof typeof EXT]) return EXT[ct as keyof typeof EXT];
  const m = ct.match(/^image\/([a-z0-9.+-]+)$/);
  return m ? m[1] : '';
}

export function formatBytes(n: unknown): string {
  if (typeof n !== 'number' || !isFinite(n)) return 'unknown size';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024,
    i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const s = v >= 10 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(1);
  return `${s} ${units[i]}`;
}

export function filenameFrom(
  contentDisposition?: string | null,
  apiPath?: string | null,
  contentType?: string | null,
): string {
  const cd = contentDisposition || '';
  // RFC 5987: filename*=<charset>'<lang>'<pct-encoded> — strip any charset'lang' prefix.
  const star = cd.match(/filename\*=(?:[^']*'[^']*')?([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      /* fall through */
    }
  }
  const quoted = cd.match(/filename="?([^";]+)"?/i);
  if (quoted) return quoted[1].trim();
  const ext = extFor(contentType);
  const segs = (apiPath || '').split('/').filter(Boolean);
  const last = segs[segs.length - 1] || '';
  const base = last && !/^\d+$/.test(last) ? last : 'download';
  return ext ? `${base}.${ext}` : base;
}
