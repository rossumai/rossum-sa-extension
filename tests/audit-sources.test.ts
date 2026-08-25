import { describe, it, expect } from 'vitest';
import { SOURCES, SOURCE_ORDER } from '../src/audit/sources/index.js';

describe('audit sources registry', () => {
  it('exposes only the audit source in SOURCE_ORDER', () => {
    expect(SOURCE_ORDER).toEqual(['audit']);
    for (const k of SOURCE_ORDER) {
      expect(SOURCES[k].key).toBe(k);
      expect(typeof SOURCES[k].path).toBe('string');
      expect(['cursor', 'offset']).toContain(SOURCES[k].paginationMode);
      expect(typeof SOURCES[k].buildParams).toBe('function');
      expect(Array.isArray(SOURCES[k].columns)).toBe(true);
    }
  });

  it('audit descriptor: cursor mode, no server search, builds object_type/action params', () => {
    const d = SOURCES.audit;
    expect(d.paginationMode).toBe('cursor');
    expect(d.supportsServerSearch).toBe(false);
    const params = d.buildParams({ object_type: 'user', action: 'app_load', object_id: '', username: 'a@b.c', timestamp_after: '', timestamp_before: '' });
    expect(params).toMatchObject({ object_type: 'user', action: 'app_load', username: 'a@b.c' });
  });
});
