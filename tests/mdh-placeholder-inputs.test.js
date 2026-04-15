import { describe, it, expect } from 'vitest';
import { parseAnnotationId } from '../src/mdh/components/PlaceholderInputs.jsx';

describe('parseAnnotationId', () => {
  it('accepts a bare numeric ID', () => {
    expect(parseAnnotationId('17213336')).toBe('17213336');
  });

  it('extracts the ID from a Rossum UI URL with /document/<id>', () => {
    expect(parseAnnotationId('https://example.rossum.app/document/17213336')).toBe('17213336');
  });

  it('extracts the ID from a Rossum API URL with /annotations/<id>', () => {
    expect(parseAnnotationId('https://elis.rossum.com/api/v1/annotations/17213336')).toBe('17213336');
  });

  it('extracts the ID from an /annotations/<id>/content URL', () => {
    expect(parseAnnotationId('https://elis.rossum.com/api/v1/annotations/17213336/content')).toBe('17213336');
  });

  it('handles trailing query strings on /document/ URLs', () => {
    expect(parseAnnotationId('https://example.rossum.app/document/17213336?email=foo')).toBe('17213336');
  });

  it('handles deep-link query strings (datapointPath)', () => {
    expect(
      parseAnnotationId('https://example.rossum.app/document/17213336?datapointPath=7795699250,7795699273'),
    ).toBe('17213336');
  });

  it('returns null for unrecognized input', () => {
    expect(parseAnnotationId('not a url or id')).toBeNull();
    expect(parseAnnotationId('https://example.com/some/path')).toBeNull();
    expect(parseAnnotationId('')).toBeNull();
  });
});
