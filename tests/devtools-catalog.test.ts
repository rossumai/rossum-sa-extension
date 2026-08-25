// tests/devtools-catalog.test.js
import { describe, it, expect } from 'vitest';
import { ENDPOINTS, suggest, relPath, shortPath } from '../src/devtools/catalog.js';

describe('catalog', () => {
  it('ships a non-trivial curated catalog of {collection,kind,pathTemplate,label,description}', () => {
    expect(ENDPOINTS.length).toBeGreaterThan(15);
    for (const e of ENDPOINTS) {
      expect(typeof e.collection).toBe('string');
      expect(['list', 'detail', 'sub']).toContain(e.kind);
      expect(e.pathTemplate.startsWith('/api/v1/')).toBe(true);
      expect(typeof e.label).toBe('string');
      expect(typeof e.description).toBe('string');
    }
  });
  it('suggest ranks prefix matches first and includes sub-resources', () => {
    const s = suggest('ann');
    expect(s.length).toBeGreaterThan(0);
    expect(s[0].collection).toBe('annotations');
    expect(s.some((e) => e.pathTemplate.includes('/content'))).toBe(true);
  });
  it('suggest matches on a typed path and is capped at 8', () => {
    expect(suggest('/api/v1/queues')[0].collection).toBe('queues');
    expect(suggest('e').length).toBeLessThanOrEqual(8);
  });
  it('suggest returns [] for empty input', () => {
    expect(suggest('')).toEqual([]);
    expect(suggest('   ')).toEqual([]);
  });
});

describe('relPath / shortPath (assume /api/v1/ prefix)', () => {
  it('strips a full or host-qualified /api/v1/ prefix', () => {
    expect(relPath('/api/v1/queues/9')).toBe('queues/9');
    expect(relPath('https://x.rossum.app/api/v1/hooks')).toBe('hooks');
  });
  it('passes relative input through, tolerating a lone leading slash', () => {
    expect(relPath('queues')).toBe('queues');
    expect(relPath('annotations?queue=1')).toBe('annotations?queue=1');
    expect(relPath('/queues')).toBe('queues');
  });
  it('treats a partially-typed prefix as empty (the old "v1" dead spot)', () => {
    expect(relPath('/')).toBe('');
    expect(relPath('/api')).toBe('');
    expect(relPath('/api/v1')).toBe('');
    expect(relPath('/api/v1/')).toBe('');
  });
  it('shortPath drops /api/v1/ from a template', () => {
    expect(shortPath('/api/v1/annotations/{id}/content')).toBe('annotations/{id}/content');
    expect(shortPath('/api/v1/queues')).toBe('queues');
  });
});

describe('suggest survives the /api/v1/ prefix (regression for the v1 bug)', () => {
  it('keeps suggesting while the prefix is being typed', () => {
    expect(suggest('/api/v').length).toBeGreaterThan(0);
    expect(suggest('/api/v1').length).toBeGreaterThan(0);
    expect(suggest('/api/v1/').length).toBeGreaterThan(0);
  });
  it('matches a bare, prefix-free collection', () => {
    expect(suggest('queues')[0].collection).toBe('queues');
  });
});
