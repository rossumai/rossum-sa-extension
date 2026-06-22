// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import * as store from '../src/inspector/store.js';

describe('inspector store', () => {
  beforeEach(() => store.reset());

  it('has connection + data signals with safe initial values', () => {
    expect(store.connected.value).toBe(null);
    expect(store.annotationId.value).toBe(null);
    expect(store.data.value).toBe(null);
    expect(store.enrichment.value).toEqual({
      audit: null, hookLogs: null, ruleLogs: null, workflow: null, notes: null, emails: null,
    });
    expect(store.loading.value).toBe(false);
  });

  it('setAnnotationId stores the id and clears stale data/error', () => {
    store.error.value = 'boom';
    store.data.value = { annotation: {} };
    store.setAnnotationId('133641827');
    expect(store.annotationId.value).toBe('133641827');
    expect(store.data.value).toBe(null);
    expect(store.error.value).toBe(null);
  });
});
