// tests/academy-store.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as store from '../src/academy/store.js';
import { PROGRESS_KEY } from '../src/training/storage.js';
import { TRACK } from '../src/training/track.js';

let state: any;
beforeEach(() => {
  state = {};
  globalThis.chrome = {
    storage: {
      local: {
        get: vi.fn(async (keys) => {
          const out = {};
          for (const k of Array.isArray(keys) ? keys : [keys])
            if (k in state) (out as any)[k] = state[k];
          return out;
        }),
        set: vi.fn(async (obj) => Object.assign(state, obj)),
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    } as any,
  } as any;
  store.setOrigin('https://x.rossum.app');
  store.progress.value = null;
  store.activeMissionId.value = null;
  store.error.value = null;
});

describe('startTrack', () => {
  it('creates empty progress for this org and selects the first mission', async () => {
    await store.startTrack();
    expect(store.progress.value!.trackId).toBe(TRACK.id);
    expect(state[PROGRESS_KEY]['https://x.rossum.app']).toBeTruthy();
    expect(store.activeMissionId.value).toBe('m1');
  });

  it('does not overwrite existing progress', async () => {
    await store.startTrack();
    const started = store.progress.value!.startedAt;
    await store.startTrack();
    expect(store.progress.value!.startedAt).toBe(started);
  });

  it('sets a human error and leaves the signals untouched when the storage write rejects', async () => {
    globalThis.chrome.storage.local.set = vi.fn(async () => {
      throw new Error('QuotaExceededError');
    });
    await expect(store.startTrack()).resolves.toBeUndefined(); // must not reject out of a click handler
    expect(store.progress.value).toBe(null); // untouched — never assigned before the throw
    expect(store.activeMissionId.value).toBe(null);
    expect(store.error.value).toMatch(/start.*training/i);
  });
});

describe('attestStep', () => {
  it('marks a self step and persists it', async () => {
    await store.startTrack();
    await store.attestStep('m1', 'm1.s4');
    expect(state[PROGRESS_KEY]['https://x.rossum.app'].missions.m1.steps['m1.s4'].state).toBe(
      'self',
    );
  });

  it('refuses to attest a step that is not kind self', async () => {
    await store.startTrack();
    await store.attestStep('m1', 'm1.s1');
    expect(
      state[PROGRESS_KEY]['https://x.rossum.app'].missions?.m1?.steps?.['m1.s1'],
    ).toBeUndefined();
  });

  it('refuses a nonexistent mission id — nothing written', async () => {
    await store.startTrack();
    const before: any = state[PROGRESS_KEY]['https://x.rossum.app'];
    const setCalls = vi.mocked(globalThis.chrome.storage.local.set).mock.calls.length;
    await store.attestStep('does-not-exist', 'does-not-exist.s1');
    expect(state[PROGRESS_KEY]['https://x.rossum.app']).toBe(before); // same reference — no write happened
    expect(vi.mocked(globalThis.chrome.storage.local.set).mock.calls.length).toBe(setCalls);
  });

  it('refuses a nonexistent step id — nothing written', async () => {
    await store.startTrack();
    const before: any = state[PROGRESS_KEY]['https://x.rossum.app'];
    const setCalls = vi.mocked(globalThis.chrome.storage.local.set).mock.calls.length;
    await store.attestStep('m1', 'does-not-exist');
    expect(state[PROGRESS_KEY]['https://x.rossum.app']).toBe(before);
    expect(vi.mocked(globalThis.chrome.storage.local.set).mock.calls.length).toBe(setCalls);
  });

  it('refuses an api-kind step — nothing written', async () => {
    await store.startTrack();
    const before: any = state[PROGRESS_KEY]['https://x.rossum.app'];
    const setCalls = vi.mocked(globalThis.chrome.storage.local.set).mock.calls.length;
    await store.attestStep('m2', 'm2.s2'); // m2.s2 is kind: 'api' (schemaFieldAdded) in the real TRACK
    expect(state[PROGRESS_KEY]['https://x.rossum.app']).toBe(before);
    expect(vi.mocked(globalThis.chrome.storage.local.set).mock.calls.length).toBe(setCalls);
  });
});

describe('restartTrack', () => {
  it('clears only this org and resets the signals', async () => {
    state[PROGRESS_KEY] = {
      'https://x.rossum.app': { trackId: 't' },
      'https://y.rossum.app': { trackId: 't' },
    };
    await store.restartTrack();
    expect(Object.keys(state[PROGRESS_KEY])).toEqual(['https://y.rossum.app']);
    expect(store.progress.value).toBe(null);
  });
});
