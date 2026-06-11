import { describe, it, expect, beforeEach, vi } from 'vitest';

// chrome.storage.local stub backed by a plain object so we can assert writes.
let store;
beforeEach(() => {
  store = {};
  globalThis.chrome = {
    storage: {
      local: {
        set: vi.fn((obj) => { Object.assign(store, obj); return Promise.resolve(); }),
        get: vi.fn((key) => Promise.resolve(key in store ? { [key]: store[key] } : {})),
        remove: vi.fn((key) => { delete store[key]; return Promise.resolve(); }),
      },
    },
  };
  orgId.value = 7;
  domain.value = 'https://x.rossum.app';
});

import { lastPipelineKey, saveLastPipeline, bootPrefillFor } from '../src/mdh/lastPipeline.js';
import { orgId, domain } from '../src/mdh/store.js';

describe('lastPipeline persistence', () => {
  it('writes text + variables under the org-scoped key', () => {
    saveLastPipeline('[{"$match":{"v":"{vendor}"}}]', { vendor: 'ACME' });
    expect(lastPipelineKey()).toBe('mdhLastPipeline::org:7');
    expect(store[lastPipelineKey()]).toEqual({
      pipelineText: '[{"$match":{"v":"{vendor}"}}]',
      variables: { vendor: 'ACME' },
      placeholderTypes: {},
    });
  });

  it('copies variables (later mutation of the source does not leak in)', () => {
    const vars = { a: '1' };
    saveLastPipeline('[]', vars);
    vars.a = 'mutated';
    expect(store[lastPipelineKey()].variables).toEqual({ a: '1' });
  });

  it('tolerates missing variables', () => {
    saveLastPipeline('[]');
    expect(store[lastPipelineKey()]).toEqual({ pipelineText: '[]', variables: {}, placeholderTypes: {} });
  });

  it('falls back to a domain-scoped key when org id is null', () => {
    orgId.value = null;
    saveLastPipeline('[]');
    expect(lastPipelineKey()).toBe('mdhLastPipeline::domain:https://x.rossum.app');
    expect(store['mdhLastPipeline::domain:https://x.rossum.app']).toBeTruthy();
  });
});

describe('bootPrefillFor', () => {
  const stored = { pipelineText: '[{"$limit":5}]', variables: { x: '1' } };

  it('returns a prefill for the restored collection, carrying text + variables', () => {
    expect(bootPrefillFor(stored, 'vendors', false)).toEqual({
      collection: 'vendors',
      pipelineText: '[{"$limit":5}]',
      variables: { x: '1' },
      placeholderTypes: {},
    });
  });

  it('returns null when a popup prefill already claimed the slot', () => {
    expect(bootPrefillFor(stored, 'vendors', true)).toBeNull();
  });

  it('returns null when no collection was restored', () => {
    expect(bootPrefillFor(stored, null, false)).toBeNull();
    expect(bootPrefillFor(stored, '', false)).toBeNull();
  });

  it('returns null when there is nothing remembered', () => {
    expect(bootPrefillFor(null, 'vendors', false)).toBeNull();
    expect(bootPrefillFor({ variables: { x: '1' } }, 'vendors', false)).toBeNull(); // no pipelineText
  });

  it('defaults variables to an empty object when absent', () => {
    expect(bootPrefillFor({ pipelineText: '[]' }, 'vendors', false)).toEqual({
      collection: 'vendors',
      pipelineText: '[]',
      variables: {},
      placeholderTypes: {},
    });
  });
});
