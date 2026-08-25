import { describe, it, expect, beforeEach } from 'vitest';
import * as store from '../src/fabry/architect/store.js';

beforeEach(() => {
  store.implement.value = {};
  store.implementRunning.value = false;
});

describe('implement store', () => {
  it('setImplement merges a patch onto per-id state', () => {
    store.setImplement('a', { status: 'running', attempt: 1 });
    store.setImplement('a', { attempt: 2, writes: [{ tool: 'create_rule' }] });
    expect(store.implement.value.a).toMatchObject({ status: 'running', attempt: 2 });
    expect(store.implement.value.a.writes!.length).toBe(1);
  });
  it('clearImplement removes one id', () => {
    store.setImplement('a', { status: 'passing' });
    store.clearImplement('a');
    expect(store.implement.value.a).toBeUndefined();
  });
});
