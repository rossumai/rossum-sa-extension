import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import * as cache from '../src/devtools/resourceCache.js';

beforeEach(() => cache.clear());
afterEach(() => vi.restoreAllMocks());

describe('pickName', () => {
  it('shows a user as "username (First Last)", degrading gracefully', () => {
    expect(cache.pickName('user', { username: 'jdoe', first_name: 'Jane', last_name: 'Doe' })).toBe('jdoe (Jane Doe)');
    expect(cache.pickName('user', { username: 'jdoe' })).toBe('jdoe'); // no name → username only
    expect(cache.pickName('user', { username: 'jdoe', first_name: 'Jane' })).toBe('jdoe (Jane)');
    expect(cache.pickName('user', { email: 'j@x.io' })).toBe('j@x.io'); // no username → email
    expect(cache.pickName('user', {})).toBeNull();
  });
  it('shows a document by original_file_name', () => {
    expect(cache.pickName('documents', { original_file_name: 'invoice.pdf', name: 'ignored' })).toBe('invoice.pdf');
    expect(cache.pickName('documents', {})).toBeNull();
  });
  it('uses .name for name-bearing types and falls back to null', () => {
    expect(cache.pickName('queue', { name: 'Invoices' })).toBe('Invoices');
    expect(cache.pickName('schema', { name: 'S' })).toBe('S');
    expect(cache.pickName('anything', { name: 'X' })).toBe('X');
    expect(cache.pickName('queue', {})).toBeNull();
    expect(cache.pickName('queue', null)).toBeNull();
  });
});

describe('cache', () => {
  it('put derives + stores the name and returns it; nameFor reads it', () => {
    expect(cache.put('/api/v1/queues/1', { name: 'Q' })).toBe('Q');
    expect(cache.nameFor('/api/v1/queues/1')).toEqual({ status: 'done', name: 'Q' });
    expect(cache.nameFor('/api/v1/queues/2')).toBeNull(); // absent
  });
  it('put derives a user name from an apiPath', () => {
    expect(cache.put('/api/v1/users/7', { username: 'ab', first_name: 'A', last_name: 'B' })).toBe('ab (A B)');
  });
  it('getFresh returns the object only within the TTL', () => {
    const now = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    cache.put('/api/v1/queues/1', { name: 'Q', id: 1 });
    expect(cache.getFresh('/api/v1/queues/1', 60000)).toEqual({ name: 'Q', id: 1 });
    vi.mocked(Date.now).mockReturnValue(now + 61000);
    expect(cache.getFresh('/api/v1/queues/1', 60000)).toBeNull(); // expired
  });
  it('setStatus marks loading/error (nameFor reflects status; getFresh only for done)', () => {
    cache.setStatus('/api/v1/queues/1', 'loading');
    expect(cache.nameFor('/api/v1/queues/1')).toEqual({ status: 'loading', name: null });
    cache.setStatus('/api/v1/queues/1', 'error');
    expect(cache.nameFor('/api/v1/queues/1')!.status).toBe('error');
    expect(cache.getFresh('/api/v1/queues/1')).toBeNull();
  });
  it('evicts the oldest entry past the cap', () => {
    let t = 0; vi.spyOn(Date, 'now').mockImplementation(() => (t += 1));
    for (let i = 0; i < 205; i++) cache.put(`/api/v1/queues/${i}`, { name: `Q${i}` });
    expect(cache.nameFor('/api/v1/queues/0')).toBeNull();   // oldest evicted
    expect(cache.nameFor('/api/v1/queues/204')).not.toBeNull();
  });
});
