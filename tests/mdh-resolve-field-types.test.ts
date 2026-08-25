import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/mdh/api.js', () => ({ aggregate: vi.fn() }));
vi.mock('../src/mdh/cache.js', () => ({ get: vi.fn(() => null), set: vi.fn() }));

import * as api from '../src/mdh/api.js';
import * as cache from '../src/mdh/cache.js';
import { resolveFieldTypes } from '../src/mdh/fieldTypes.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(cache.get).mockReturnValue(null);
});

describe('resolveFieldTypes', () => {
  it('probes missing fields and transforms the facet', async () => {
    vi.mocked(api.aggregate).mockResolvedValue({
      result: [
        {
          code: [
            { _id: 'string', count: 8 },
            { _id: 'int', count: 2 },
          ],
        },
      ],
    });
    const out = await resolveFieldTypes('col', ['code']);
    expect(out.code.dominant).toBe('string');
    expect(out.code.mixed).toBe(true);
    expect(out.code.share).toBeCloseTo(0.8);
    expect(cache.set).toHaveBeenCalledWith('col', 'stats_fieldTypes', expect.any(Object));
  });
  it('encodes dotted field names for the facet key', async () => {
    vi.mocked(api.aggregate).mockResolvedValue({
      result: [{ a__DOT__b: [{ _id: 'long', count: 5 }] }],
    });
    const out = await resolveFieldTypes('col', ['a.b']);
    expect(out['a.b'].dominant).toBe('number');
  });
  it('reuses the Stats raw facet (stats_types) without probing', async () => {
    vi.mocked(cache.get).mockImplementation((c, f) =>
      f === 'stats_types' ? { result: [{ vendor: [{ _id: 'string', count: 3 }] }] } : null,
    );
    const out = await resolveFieldTypes('col', ['vendor']);
    expect(api.aggregate).not.toHaveBeenCalled();
    expect(out.vendor.dominant).toBe('string');
  });
  it('probe failure → null (value-based fallback)', async () => {
    vi.mocked(api.aggregate).mockRejectedValue(new Error('timeout'));
    const out = await resolveFieldTypes('col', ['x']);
    expect(out.x).toBeNull();
  });
});
