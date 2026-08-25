import { describe, it, expect, vi } from 'vitest';
import { gatherRejectContext, gatherLabelContext, gatherMessageContext, gatherBlockerContext, gatherExportContext, gatherFieldsContext } from '../src/inspector/attributionContext.js';

function fakeStore(overrides: any = {}) {
  const d = {
    annotation: { id: 5, status: 'rejected', rejected_at: 't', queue: 'https://x/api/v1/queues/9' },
    content: [{ schema_id: 'total', category: 'datapoint', content: { value: '10' } }],
    resolved: { hooksById: { 7: { id: 7, name: 'H', type: 'function', events: ['annotation_content.confirm'] } } },
    ...overrides.data,
  };
  return { data: { value: d }, enrichment: { value: { hookLogs: [], ...overrides.enrichment } } };
}

describe('gatherRejectContext', () => {
  it('assembles a COMPACT candidate list (no code) + the queue id, without fetching code', async () => {
    const a = { getHook: vi.fn(), listHooks: vi.fn(async () => []) };
    const ctx = await gatherRejectContext({ api: a, store: fakeStore(), reason: 'bad total' });
    expect(ctx.annotation).toEqual({ id: 5, status: 'rejected', queueId: '9' });
    expect(ctx.target.reason).toBe('bad total');
    expect(ctx.candidates[0]).toEqual({ id: 7, name: 'H', type: 'function', events: ['annotation_content.confirm'] });
    expect(ctx.candidates[0]).not.toHaveProperty('code'); // agent fetches code itself
    expect(a.getHook).not.toHaveBeenCalled();             // no client-side code fetch
    expect(ctx).not.toHaveProperty('logs');               // logs/fields no longer seeded
    expect(ctx).not.toHaveProperty('fields');
  });

  it('uses resolved.hooksById without any API call when present', async () => {
    const a = {}; // no methods at all — must not be touched
    const ctx = await gatherRejectContext({ api: a, store: fakeStore(), reason: null });
    expect(ctx.candidates.map((c) => c.id)).toEqual([7]);
  });

  it('falls back to api.listHooks (compact) when resolved.hooksById is empty', async () => {
    const a = { listHooks: vi.fn(async () => [{ id: 5, name: 'WH', type: 'webhook', events: [] }]) };
    const store = fakeStore({ data: { resolved: { hooksById: {} }, annotation: { id: 1, status: 'rejected', queue: 'https://x/api/v1/queues/9' } } });
    const ctx = await gatherRejectContext({ api: a, store });
    expect(a.listHooks).toHaveBeenCalled();
    expect(ctx.candidates[0]).toEqual({ id: 5, name: 'WH', type: 'webhook', events: [] });
  });
});

describe('gatherLabelContext', () => {
  it('targets the label and includes compact candidates', async () => {
    const ctx = await gatherLabelContext({ api: {}, store: fakeStore(), labelId: '3', labelName: 'Urgent' });
    expect(ctx.target).toEqual({ id: '3', name: 'Urgent' });
    expect(ctx.candidates.length).toBe(1);
  });
});

const store = { data: { value: { annotation: { id: 9, status: 'to_review', queue: 'https://h/api/v1/queues/3' }, content: { content: [] }, resolved: { hooksById: { 5: { id: 5, name: 'H', type: 'function', events: [] } } } } }, enrichment: { value: { hookLogs: [] } } };
const apiSimple = { listHooks: async () => [] };

describe('new gatherers', () => {
  it('gatherMessageContext carries the message target + candidates + queue id', async () => {
    const ctx = await gatherMessageContext({ api: apiSimple, store, message: { level: 'error', content: 'x', schemaId: 'iban' } });
    expect(ctx.target).toEqual({ level: 'error', content: 'x', schemaId: 'iban' });
    expect((ctx.annotation as any).queueId).toBe('3');
    expect(ctx.candidates[0].id).toBe(5);
  });
  it('gatherBlockerContext + gatherExportContext carry their targets', async () => {
    expect((await gatherBlockerContext({ api: apiSimple, store, blocker: { type: 't', schemaId: 'f' } })).target).toEqual({ type: 't', schemaId: 'f' });
    expect((await gatherExportContext({ api: apiSimple, store, error: 'E' })).target).toEqual({ error: 'E' });
  });
  it('gatherExportContext narrows candidates to export-event hooks', async () => {
    const storeExp = { data: { value: { annotation: { id: 9, status: 'failed_export', queue: 'https://h/api/v1/queues/3' }, content: { content: [] }, resolved: { hooksById: {
      5: { id: 5, name: 'Exporter', type: 'function', events: ['annotation_content.export'] },
      6: { id: 6, name: 'Validator', type: 'function', events: ['annotation_content.updated'] },
    } } } }, enrichment: { value: { hookLogs: [] } } };
    const ctx = await gatherExportContext({ api: apiSimple, store: storeExp, error: 'E' });
    expect(ctx.candidates.map((c) => c.id)).toEqual([5]); // narrowed to the export hook only
  });
  it('gatherFieldsContext populates candidates from resolved hooks', async () => {
    const ctx = await gatherFieldsContext({ api: apiSimple, store });
    expect(ctx.candidates[0].id).toBe(5);
  });
  it('never throws on a store that would throw (returns a safe empty context)', async () => {
    const bad = await gatherFieldsContext({ api: apiSimple, store: {} }); // store.data is undefined → throws → caught
    expect(bad).toEqual({ annotation: {}, candidates: [] });
  });
});
