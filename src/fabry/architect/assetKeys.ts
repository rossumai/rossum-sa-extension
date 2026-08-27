// Reference strings for uploaded files, and the mime they are served as.
//
// The reference an author writes IS the index key, so nothing derives a path and nothing can drift.
// Mime comes from the extension because the API normalises a macro-enabled workbook to the plain
// spreadsheet mime even though the bytes are untouched — trusting the stored value would hand a
// browser a type that contradicts the filename.
const PREFIX = 'assets/';

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  md: 'text/markdown',
  html: 'text/html',
  eml: 'message/rfc822',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function mimeForName(name: string): string {
  return MIME[extOf(name)] || 'application/octet-stream';
}

export function isImageMime(mime: string): boolean {
  return /^image\//i.test(String(mime || ''));
}

export function cleanHref(href: string): string {
  const h = String(href ?? '')
    .split('#')[0]
    .split('?')[0]
    .trim();
  if (
    !h ||
    h.startsWith('#') ||
    h.startsWith('/') ||
    /^[a-z][a-z0-9+.-]*:/i.test(h) ||
    h.startsWith('//')
  )
    return '';
  return h;
}

export function keyForFile(name: string, taken: Set<string>): string {
  const ext = extOf(name);
  const stem =
    (ext ? name.slice(0, -(ext.length + 1)) : name)
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '') || 'file';
  const tail = ext ? `.${ext}` : '';
  let key = `${PREFIX}${stem}${tail}`;
  let n = 2;
  while (taken.has(key)) key = `${PREFIX}${stem}-${n++}${tail}`;
  return key;
}
