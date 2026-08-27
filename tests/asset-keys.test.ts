import { describe, expect, it } from 'vitest';
import {
  cleanHref,
  isImageMime,
  keyForFile,
  mimeForName,
} from '../src/fabry/architect/assetKeys.js';

describe('keyForFile', () => {
  it('derives a reference from a filename', () => {
    expect(keyForFile('diagram.png', new Set())).toBe('assets/diagram.png');
  });

  it('suffixes a collision the way deliverable slugs do', () => {
    const taken = new Set(['assets/diagram.png', 'assets/diagram-2.png']);
    expect(keyForFile('diagram.png', taken)).toBe('assets/diagram-3.png');
  });

  it('normalises a name that would be awkward in a reference', () => {
    expect(keyForFile('Screen Shot 2026.png', new Set())).toBe('assets/screen-shot-2026.png');
  });
});

describe('mimeForName', () => {
  it('reads the extension, never the server', () => {
    expect(mimeForName('a.xlsm')).toBe('application/vnd.ms-excel.sheet.macroEnabled.12');
    expect(mimeForName('a.eml')).toBe('message/rfc822');
    expect(mimeForName('a.csv')).toBe('text/csv');
    expect(mimeForName('a.unknown')).toBe('application/octet-stream');
  });
});

describe('cleanHref and isImageMime', () => {
  it('strips a fragment or query before lookup', () => {
    expect(cleanHref('assets/diagram.png#top')).toBe('assets/diagram.png');
    expect(cleanHref('assets/diagram.png?v=2')).toBe('assets/diagram.png');
  });

  it('rejects anything that cannot be an asset reference', () => {
    expect(cleanHref('#section')).toBe('');
    expect(cleanHref('/api/v1/hooks/1')).toBe('');
    expect(cleanHref('https://example.test/a.png')).toBe('');
  });

  it('knows an image from a file', () => {
    expect(isImageMime('image/png')).toBe(true);
    expect(isImageMime('text/csv')).toBe(false);
  });
});
