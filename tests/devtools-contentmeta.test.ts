import { describe, it, expect } from 'vitest';
import { extFor, formatBytes, filenameFrom } from '../src/devtools/contentMeta.js';

describe('extFor', () => {
  it('maps common content-types to extensions', () => {
    expect(extFor('application/pdf')).toBe('pdf');
    expect(extFor('image/png')).toBe('png');
    expect(extFor('image/jpeg')).toBe('jpg');
    expect(extFor('image/svg+xml')).toBe('svg');
    expect(extFor('image/webp')).toBe('webp');
    expect(extFor('image/tiff')).toBe('tiff'); // generic image/* fallback
    expect(extFor('application/pdf; charset=binary')).toBe('pdf'); // params tolerated
    expect(extFor('application/octet-stream')).toBe('');
    expect(extFor('')).toBe('');
  });
});

describe('formatBytes', () => {
  it('formats byte counts', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1048576)).toBe('1 MB');
    expect(formatBytes(undefined)).toBe('unknown size');
  });
});

describe('filenameFrom', () => {
  it('prefers a quoted Content-Disposition filename', () => {
    expect(filenameFrom('attachment; filename="invoice 12.pdf"', '/api/v1/documents/5/content', 'application/pdf')).toBe('invoice 12.pdf');
  });
  it('supports RFC 5987 filename*', () => {
    expect(filenameFrom("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf", '/api/v1/documents/5/content', 'application/pdf')).toBe('résumé.pdf');
  });
  it('strips a non-UTF-8 RFC 5987 charset prefix generically', () => {
    expect(filenameFrom("attachment; filename*=ISO-8859-1''caf%C3%A9.pdf", '/api/v1/documents/5/content', 'application/pdf')).toBe('café.pdf');
  });
  it('falls back to the path segment + extension from content-type', () => {
    expect(filenameFrom(null, '/api/v1/documents/152918702/content', 'application/pdf')).toBe('content.pdf');
    expect(filenameFrom('', '/api/v1/pages/9/preview', 'image/png')).toBe('preview.png');
  });
  it('uses a generic base when the last segment is numeric', () => {
    expect(filenameFrom(null, '/api/v1/documents/5/content/9', 'image/jpeg')).toBe('download.jpg');
  });
  it('omits the extension when the content-type is unknown', () => {
    expect(filenameFrom(null, '/api/v1/documents/5/content', 'application/octet-stream')).toBe('content');
  });
});
