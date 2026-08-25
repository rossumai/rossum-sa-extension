import { describe, it, expect } from 'vitest';
import {
  ANNOTATION_PATH_RE,
  annotationIdFromInput,
  annotationIdFromPath,
} from '../src/rossum/annotationUrl.js';

const APP = 'https://org.rossum.app';

describe('annotationIdFromPath — the dashboard-route question', () => {
  it('reads the id from every dashboard spelling', () => {
    expect(annotationIdFromPath('/document/4718203')).toBe('4718203');
    expect(annotationIdFromPath('/annotation/555')).toBe('555');
    expect(annotationIdFromPath('/annotations/555')).toBe('555');
  });

  it('accepts a full URL as well as a bare path', () => {
    expect(annotationIdFromPath(`${APP}/document/1250417`)).toBe('1250417');
    expect(annotationIdFromPath(`${APP}/document/1250417?tab=x#y`)).toBe('1250417');
  });

  it('tolerates a trailing segment or query', () => {
    expect(annotationIdFromPath('/document/4718203/edit')).toBe('4718203');
    expect(annotationIdFromPath('/document/7?datapointPath=1,2')).toBe('7');
  });

  it('rejects non-annotation routes', () => {
    expect(annotationIdFromPath('/documents')).toBeNull();
    expect(annotationIdFromPath('/documents?level=all')).toBeNull();
    expect(annotationIdFromPath('/queues/5')).toBeNull();
    expect(annotationIdFromPath('/documentation/12')).toBeNull();
  });

  // The reason this is anchored: the DevTools panel maps DASHBOARD routes, and
  // an API URL is not one. A lenient pattern would resolve it as a page route.
  it('does NOT treat an API path as a dashboard route', () => {
    expect(annotationIdFromPath('/api/v1/annotations/17213336')).toBeNull();
    expect(annotationIdFromPath(`${APP}/api/v1/annotations/17213336/content`)).toBeNull();
  });

  it('is null for junk', () => {
    expect(annotationIdFromPath(undefined)).toBeNull();
    expect(annotationIdFromPath('')).toBeNull();
    expect(annotationIdFromPath('not a url')).toBeNull();
    expect(annotationIdFromPath('/document/abc')).toBeNull();
  });
});

describe('annotationIdFromInput — the pasted-by-a-human question', () => {
  it('accepts a bare id', () => {
    expect(annotationIdFromInput('17213336')).toBe('17213336');
    expect(annotationIdFromInput('  17213336  ')).toBe('17213336');
  });

  it('accepts a dashboard URL in any spelling', () => {
    expect(annotationIdFromInput(`${APP}/document/17213336`)).toBe('17213336');
    expect(annotationIdFromInput(`${APP}/annotation/17213336`)).toBe('17213336');
    expect(annotationIdFromInput(`${APP}/annotations/17213336`)).toBe('17213336');
    expect(annotationIdFromInput(`${APP}/document/17213336?email=foo`)).toBe('17213336');
  });

  it('accepts an API URL, with or without a sub-resource', () => {
    expect(annotationIdFromInput('https://elis.rossum.com/api/v1/annotations/17213336')).toBe(
      '17213336',
    );
    expect(
      annotationIdFromInput('https://elis.rossum.com/api/v1/annotations/17213336/content'),
    ).toBe('17213336');
  });

  it('is null for junk', () => {
    expect(annotationIdFromInput('')).toBeNull();
    expect(annotationIdFromInput('https://example.com/')).toBeNull();
    expect(annotationIdFromInput('queue 5')).toBeNull();
  });
});

describe('ANNOTATION_PATH_RE', () => {
  // The DevTools route table reads capture group 1 off a shared regex.
  it('exposes the id as capture group 1', () => {
    expect('/document/18970431'.match(ANNOTATION_PATH_RE)![1]).toBe('18970431');
  });

  // A /g regex would carry lastIndex between the table's callers.
  it('is not global, so it holds no state between callers', () => {
    expect(ANNOTATION_PATH_RE.global).toBe(false);
  });
});
