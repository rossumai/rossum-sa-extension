// @vitest-environment node
// Spec 2026-10-13-api-call-reduction-design.md §4.2: a 429 is not "no hooks".
import { describe, it, expect, beforeEach, vi } from 'vitest';
vi.mock('../src/inspector/api.js');
vi.mock('../src/inspector/orchestrate.js', () => ({
  orchestrateAttributions: vi.fn(async () => {}),
}));
vi.mock('../src/agent/agentApi.js', () => ({
  init: vi.fn(),
  probeAgent: vi.fn(() => Promise.resolve(false)),
}));
import * as api from '../src/inspector/api.js';
import * as store from '../src/inspector/store.js';
import { loadAnnotation } from '../src/inspector/index.jsx';

const ANN = { id: 5, status: 'to_review', messages: [], queue: 'https://h/api/v1/queues/3' };
const throttled = (retryAfter: number | null) =>
  Object.assign(new Error('Request was throttled.'), { status: 429, retryAfter });

async function openAnnotation(id = '5') {
  store.setAnnotationId(id);
  await loadAnnotation(id);
}
const settled = () =>
  vi.waitFor(() => expect(store.investigation.value.stage).toBe('agent-offline'));

beforeEach(() => {
  store.reset();
  vi.clearAllMocks();
  vi.mocked(api.getAnnotation).mockResolvedValue(ANN);
  vi.mocked(api.getContent).mockResolvedValue({ content: [] });
  vi.mocked(api.getQueue).mockResolvedValue({ id: 3 });
  vi.mocked(api.listHooks).mockResolvedValue([{ id: 1, name: 'H', active: true }]);
  vi.mocked(api.listRules).mockResolvedValue([]);
  vi.mocked(api.listLabels).mockResolvedValue([]);
});

describe('Inspector under a 429', () => {
  it('records the 429 and leaves hooks unloaded instead of empty', async () => {
    vi.mocked(api.listHooks).mockRejectedValue(throttled(9));
    await openAnnotation();
    await settled();
    expect(store.rateLimited.value).toEqual({ retryAfter: 9 });
    expect(store.data.value.resolved._hooksLoaded).not.toBe(true);
    // loadLabelContext lists hooks too; it must not write a half-empty label context.
    expect(store.data.value.resolved.labelsById).toBeUndefined();
    expect(api.listHooks).toHaveBeenCalledTimes(1); // no automatic retry within the load
  });

  it('leaves rules unloaded on a 429', async () => {
    vi.mocked(api.listRules).mockRejectedValue(throttled(null));
    await openAnnotation();
    await settled();
    expect(store.rateLimited.value).toEqual({ retryAfter: null });
    expect(store.data.value.resolved._rulesLoaded).not.toBe(true);
  });

  it('leaves the label context unwritten when rules are throttled', async () => {
    vi.mocked(api.listRules).mockRejectedValue(throttled(2));
    await openAnnotation();
    await settled();
    expect(store.data.value.resolved.labelsById).toBeUndefined();
  });

  it('leaves the label context unwritten when labels are throttled', async () => {
    vi.mocked(api.listLabels).mockRejectedValue(throttled(2));
    await openAnnotation();
    await settled();
    expect(store.data.value.resolved.labelsById).toBeUndefined();
  });

  it('shows the rate-limit message when the annotation itself is throttled', async () => {
    vi.mocked(api.getAnnotation).mockRejectedValue(throttled(5));
    await openAnnotation();
    expect(store.error.value).toBe('Rossum is rate-limiting requests. Try again in 5 s.');
  });

  it('a throttled hook-log load is rate-limited, not an empty list or a 403', async () => {
    vi.mocked(api.listHookLogs).mockRejectedValueOnce(throttled(7));
    await openAnnotation();
    await settled();
    expect(store.enrichment.value.hookLogs).toBe('rate-limited');
    expect(store.rateLimited.value).toEqual({ retryAfter: 7 });
  });

  it('keeps today’s behaviour for a non-429 failure', async () => {
    vi.mocked(api.listHooks).mockRejectedValue(
      Object.assign(new Error('API error 500'), { status: 500 }),
    );
    await openAnnotation();
    await settled();
    expect(store.rateLimited.value).toBeNull();
    expect(store.data.value.resolved._hooksLoaded).toBe(true);
  });

  it('a 429 that lands after the user moved on does not flag the new annotation', async () => {
    vi.mocked(api.listHooks).mockImplementationOnce(
      () => new Promise((_resolve, reject) => setTimeout(() => reject(throttled(5)), 30)),
    );
    await openAnnotation('5');
    await openAnnotation('6');
    await settled();
    await new Promise((r) => setTimeout(r, 50)); // let the old 429 arrive
    expect(store.rateLimited.value).toBeNull();
  });

  it('opening another annotation clears the flag', async () => {
    vi.mocked(api.listHooks).mockRejectedValueOnce(throttled(9));
    await openAnnotation('5');
    await settled();
    expect(store.rateLimited.value).not.toBeNull();
    store.setAnnotationId('6');
    expect(store.rateLimited.value).toBeNull();
  });
});
