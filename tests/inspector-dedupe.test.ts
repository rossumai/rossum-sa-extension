// @vitest-environment node
// Spec 2026-10-13-api-call-reduction-design.md §4.2: one list per annotation load.
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
import { orchestrateAttributions } from '../src/inspector/orchestrate.js';
import { loadAnnotation, loadLabelContext, loadQueueHooks } from '../src/inspector/index.jsx';

const ANN = { id: 5, status: 'to_review', messages: [], queue: 'https://h/api/v1/queues/3' };

async function openAnnotation(id = '5') {
  store.setAnnotationId(id);
  await loadAnnotation(id);
}
// The investigation ends at agent-offline: the agent probe is mocked to false.
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

describe('Inspector request scope', () => {
  it('lists hooks, rules and labels once, even with panels calling the loaders mid-load', async () => {
    await openAnnotation();
    // What PipelinePanel, ProvenancePanel, ExportPanel and LabelsPanel do on mount:
    loadQueueHooks();
    loadQueueHooks();
    loadLabelContext();
    await settled();
    expect(api.listHooks).toHaveBeenCalledTimes(1);
    expect(api.listRules).toHaveBeenCalledTimes(1);
    expect(api.listLabels).toHaveBeenCalledTimes(1);
  });

  it("hands the attribution fallback the load's hooks list instead of a new request", async () => {
    vi.mocked(api.listHooks).mockResolvedValue([]); // no hooks → the fallback would fire
    vi.mocked(orchestrateAttributions).mockImplementationOnce((async (opts: any) => {
      await opts.api.listHooks('3');
    }) as any);
    await openAnnotation();
    await settled();
    expect(api.listHooks).toHaveBeenCalledTimes(1);
  });

  it('a new annotation load lists again', async () => {
    await openAnnotation('5');
    await settled();
    await openAnnotation('6');
    await settled();
    expect(api.listHooks).toHaveBeenCalledTimes(2);
  });
});
