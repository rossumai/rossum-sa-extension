// tests/devtools-requestinput.test.js
import { describe, it, expect } from 'vitest';
import { normalizeRequestInput } from '../src/devtools/requestInput.js';

const DOM = 'https://elis.rossum.app';

describe('normalizeRequestInput', () => {
  it('returns null for empty / whitespace / non-string', () => {
    expect(normalizeRequestInput('', DOM)).toBeNull();
    expect(normalizeRequestInput('   ', DOM)).toBeNull();
    expect(normalizeRequestInput(null, DOM)).toBeNull();
  });
  it('accepts a full URL of the current org and keeps path + query', () => {
    expect(normalizeRequestInput('https://elis.rossum.app/api/v1/queues/9?x=1', DOM)).toEqual({
      apiPath: '/api/v1/queues/9?x=1',
    });
  });
  it('rejects a full URL of a different host', () => {
    const r = normalizeRequestInput('https://other.rossum.app/api/v1/queues/9', DOM);
    expect(r!.error).toMatch(/elis\.rossum\.app/);
  });
  it('auto-prepends /api/v1 to a bare path', () => {
    expect(normalizeRequestInput('/queues/9', DOM)).toEqual({ apiPath: '/api/v1/queues/9' });
    expect(normalizeRequestInput('queues', DOM)).toEqual({ apiPath: '/api/v1/queues' });
    expect(normalizeRequestInput('annotations?queue=1', DOM)).toEqual({
      apiPath: '/api/v1/annotations?queue=1',
    });
  });
  it('leaves an already /api/v1 path unchanged (no double-prefix)', () => {
    expect(normalizeRequestInput('/api/v1/hooks/3', DOM)).toEqual({ apiPath: '/api/v1/hooks/3' });
    expect(normalizeRequestInput('/api/v1', DOM)).toEqual({ apiPath: '/api/v1' });
  });
  it('errors on an unresolved {id} placeholder', () => {
    expect(normalizeRequestInput('/api/v1/queues/{id}', DOM)!.error).toMatch(/\{id\}/);
  });
  it('errors on a path traversal attempt', () => {
    expect(normalizeRequestInput('/api/v1/../secrets', DOM)!.error).toMatch(/invalid/i);
  });
  it('rejects a full URL when the current domain cannot be resolved (empty / schemeless)', () => {
    expect(
      normalizeRequestInput('https://elis.rossum.app/api/v1/queues/9', '')!.error,
    ).toBeTruthy();
    expect(
      normalizeRequestInput('https://elis.rossum.app/api/v1/queues/9', 'elis.rossum.app')!.error,
    ).toBeTruthy();
  });
});
