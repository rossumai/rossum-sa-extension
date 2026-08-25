// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import * as store from '../src/inspector/store.js';
import { investigation, synthesis, evidence, setInvestigation } from '../src/inspector/store.js';

describe('inspector store', () => {
  beforeEach(() => store.reset());

  it('has connection + data signals with safe initial values', () => {
    expect(store.connected.value).toBe(null);
    expect(store.annotationId.value).toBe(null);
    expect(store.data.value).toBe(null);
    expect(store.enrichment.value).toEqual({
      audit: null,
      hookLogs: null,
      ruleLogs: null,
      workflow: null,
      notes: null,
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

describe('investigation signals', () => {
  beforeEach(() => store.reset());

  it('setInvestigation shallow-merges', () => {
    setInvestigation({ stage: 'gathering', sourcesTotal: 8 });
    setInvestigation({ sourcesDone: 3 });
    expect(investigation.value.stage).toBe('gathering');
    expect(investigation.value.sourcesDone).toBe(3);
    expect(investigation.value.sourcesTotal).toBe(8);
  });
  it('setAnnotationId resets investigation, synthesis, evidence', () => {
    synthesis.value = { status: 'done', text: 'x', reasoning: '', tools: [], error: null };
    evidence.value = { items: [], verdict: {} };
    store.setAnnotationId('42');
    expect(investigation.value.stage).toBe('idle');
    expect(synthesis.value).toBe(null);
    expect(evidence.value).toBe(null);
  });
});
