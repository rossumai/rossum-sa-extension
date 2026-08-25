// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { annotationIdFromPath, init } from '../src/rossum/features/track-viewed.js';
import { VIEWED_KEY } from '../src/inspector/viewed.js';

describe('annotationIdFromPath', () => {
  it('matches /document/<id> routes only', () => {
    expect(annotationIdFromPath('/document/4718203')).toBe('4718203');
    expect(annotationIdFromPath('/document/4718203/edit')).toBe('4718203');
    expect(annotationIdFromPath('/documents')).toBe(null);
    expect(annotationIdFromPath('/queues/1')).toBe(null);
  });
});

describe('viewed tracking', () => {
  let state: any;
  beforeEach(() => {
    state = {};
    globalThis.chrome = {
      storage: {
        local: {
          get: vi.fn(async () => ({ ...state })),
          set: vi.fn(async (obj) => Object.assign(state, obj)),
        },
      } as any,
    } as any;
  });

  it('records {id, origin, at} when on an annotation route', async () => {
    window.history.replaceState(null, '', '/document/501');
    init({ intervalMs: 0 });
    await new Promise((r) => setTimeout(r, 0));
    const list: any = state[VIEWED_KEY];
    expect(list[0].id).toBe('501');
    expect(list[0].origin).toBe(window.location.origin);
    expect(typeof list[0].at).toBe('number');
  });

  it('does not record on non-annotation routes and injects NO DOM anywhere', async () => {
    window.history.replaceState(null, '', '/queues/9');
    const before = document.body.innerHTML;
    init({ intervalMs: 0 });
    await new Promise((r) => setTimeout(r, 0));
    expect(state[VIEWED_KEY]).toBeUndefined();
    expect(document.body.innerHTML).toBe(before); // pure tracker — the old button is gone
  });

  it('dedups repeated syncs of the same annotation, records a new one on route change', async () => {
    window.history.replaceState(null, '', '/document/601');
    init({ intervalMs: 0 });
    init({ intervalMs: 0 }); // second sync, same route
    await new Promise((r) => setTimeout(r, 0));
    expect(state[VIEWED_KEY].filter((e: any) => e.id === '601')).toHaveLength(1);
    window.history.replaceState(null, '', '/document/602');
    init({ intervalMs: 0 });
    await new Promise((r) => setTimeout(r, 0));
    expect(state[VIEWED_KEY][0].id).toBe('602');
    expect(state[VIEWED_KEY]).toHaveLength(2);
  });
});
