import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../src/mdh/api.js', () => ({
  createCollection: vi.fn(),
  find: vi.fn(),
  insertOne: vi.fn(),
  updateOne: vi.fn(),
  deleteOne: vi.fn(),
}));
import * as mdh from '../src/mdh/api.js';
import * as api from '../src/fabry/architect/api.js';

beforeEach(() => vi.clearAllMocks());

describe('loadDeliverables (implement fields)', () => {
  it('returns persisted (stale) implement state', async () => {
    vi.mocked(mdh.find).mockResolvedValue({
      result: [
        {
          _id: 'a',
          kind: 'requirement',
          text: 'A',
          order: 1,
          implementStatus: 'passing',
          attempts: 2,
          implementRanAt: 5,
          lastImplementSummary: 'made rule',
          lastImplementWrites: [{ tool: 'create_rule', ok: true }],
          implementTasks: [{ id: 'k1', text: 't1', status: 'done' }],
        },
        { _id: 'b', kind: 'requirement', text: 'B', order: 2 },
        { _id: 'c', kind: 'requirement', text: 'C', order: 3, implementStatus: 'failed' },
      ],
    });
    const { deliverables, implement } = await api.loadDeliverables();
    expect(deliverables[0]).toMatchObject({ id: 'a', text: 'A', order: 1 });
    expect(implement.a).toMatchObject({
      status: 'passing',
      attempt: 2,
      stale: true,
      summary: 'made rule',
    });
    expect(implement.a.tasks).toEqual([{ id: 'k1', text: 't1', status: 'done' }]); // tasks (fix_plan) round-trip
    expect(implement.c.tasks).toEqual([]); // back-compat: doc with implementStatus but no implementTasks → []
    expect(implement.b).toBeUndefined();
  });
});
describe('saveImplementResult', () => {
  it('persists status + tasks + caps the journal to the last 10', async () => {
    const journal = Array.from({ length: 15 }, (_, i) => ({ attempt: i }));
    const tasks = [
      { id: 'k1', text: 't1', status: 'done' },
      { id: 'k2', text: 't2', status: 'failed' },
    ];
    await api.saveImplementResult('a', {
      status: 'failed',
      attempts: 3,
      writes: [],
      summary: 's',
      chatId: 'c',
      ranAt: 9,
      journal,
      tasks,
    });
    const set = vi.mocked(mdh.updateOne).mock.calls[0][2].$set;
    expect(set.implementStatus).toBe('failed');
    expect(set.implementJournal.length).toBe(10);
    expect(set.implementJournal[0].attempt).toBe(5);
    expect(set.implementTasks).toEqual(tasks); // fix_plan persisted
  });
  it('defaults implementTasks to [] when none passed', async () => {
    await api.saveImplementResult('a', {
      status: 'passing',
      attempts: 1,
      writes: [],
      summary: '',
      chatId: null,
      ranAt: 1,
      journal: [],
    });
    expect(vi.mocked(mdh.updateOne).mock.calls[0][2].$set.implementTasks).toEqual([]);
  });
});
