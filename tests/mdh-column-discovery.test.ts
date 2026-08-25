import { describe, it, expect, vi } from 'vitest';
import {
  buildLevelPipeline,
  discoverLeafPaths,
  MAX_DISCOVERY_DEPTH,
} from '../src/mdh/columnDiscovery.js';

describe('buildLevelPipeline', () => {
  it('facets the root with a $cond guard and positional keys', () => {
    expect(buildLevelPipeline([{ $match: { active: true } }], [''])).toEqual([
      { $match: { active: true } },
      {
        $facet: {
          f0: [
            {
              $project: {
                kv: {
                  $cond: [
                    { $eq: [{ $type: '$$ROOT' }, 'object'] },
                    { $objectToArray: '$$ROOT' },
                    [],
                  ],
                },
              },
            },
            { $unwind: '$kv' },
            { $group: { _id: '$kv.k', types: { $addToSet: { $type: '$kv.v' } } } },
          ],
        },
      },
    ]);
  });

  it('uses positional facet keys because a $facet key cannot contain a dot', () => {
    const p = buildLevelPipeline([{ $match: {} }], ['address', 'id']);
    expect(Object.keys(p[1].$facet)).toEqual(['f0', 'f1']);
    expect(JSON.stringify(p)).toContain('"$address"');
    expect(JSON.stringify(p)).toContain('"$id"');
  });

  it('turns an encoded parent path back into a Mongo field path', () => {
    const p = buildLevelPipeline([{ $match: {} }], ['a.b']);
    expect(JSON.stringify(p)).toContain('"$a.b"');
  });
});

describe('discoverLeafPaths', () => {
  const level = (byParent: any) => ({ result: [byParent] });

  it('walks one level per depth and returns the exact leaf union', async () => {
    const aggregate = vi
      .fn()
      .mockResolvedValueOnce(
        level({
          f0: [
            { _id: '_id', types: ['objectId'] },
            { _id: 'name', types: ['string'] },
            { _id: 'address', types: ['object'] },
          ],
        }),
      )
      .mockResolvedValueOnce(
        level({
          f0: [
            { _id: 'city', types: ['string'] },
            { _id: 'line', types: ['array'] },
          ],
        }),
      );

    const paths = await discoverLeafPaths('c', [{ $match: {} }], { aggregate });
    expect(paths.sort()).toEqual(['_id', 'address.city', 'address.line', 'name']);
    expect(aggregate).toHaveBeenCalledTimes(2);
  });

  it('emits a path that is an object in some records and a scalar in others as BOTH', async () => {
    const aggregate = vi
      .fn()
      .mockResolvedValueOnce(level({ f0: [{ _id: 'v', types: ['object', 'string'] }] }))
      .mockResolvedValueOnce(level({ f0: [{ _id: 'inner', types: ['int'] }] }));

    const paths = await discoverLeafPaths('c', [{ $match: {} }], { aggregate });
    expect(paths.sort()).toEqual(['v', 'v.inner']);
  });

  it('never descends into an opaque key — it becomes a leaf instead', async () => {
    const aggregate = vi.fn().mockResolvedValueOnce(
      level({
        f0: [
          { _id: 'a.b', types: ['object'] },
          { _id: '$weird', types: ['object'] },
        ],
      }),
    );

    const paths = await discoverLeafPaths('c', [{ $match: {} }], { aggregate });
    expect(paths.sort()).toEqual(['$weird', 'a\\.b']);
    expect(aggregate).toHaveBeenCalledTimes(1); // no second level attempted
  });

  it('stops at the depth cap and emits what is still pending as a leaf', async () => {
    const aggregate = vi.fn().mockResolvedValue(level({ f0: [{ _id: 'k', types: ['object'] }] }));
    const paths = await discoverLeafPaths('c', [{ $match: {} }], { aggregate, maxDepth: 2 });
    expect(paths).toEqual(['k.k']);
    expect(aggregate).toHaveBeenCalledTimes(2);
  });

  it('caps at MAX_DISCOVERY_DEPTH by default', () => {
    expect(MAX_DISCOVERY_DEPTH).toBe(5);
  });

  it('emits an always-empty-object parent as its own leaf, matching flattenDoc({}) treating {} as a leaf', async () => {
    const aggregate = vi
      .fn()
      .mockResolvedValueOnce(level({ f0: [{ _id: 'address', types: ['object'] }] }))
      .mockResolvedValueOnce(level({ f0: [] }));

    const paths = await discoverLeafPaths('c', [{ $match: {} }], { aggregate });
    expect(paths).toEqual(['address']);
    expect(aggregate).toHaveBeenCalledTimes(2);
  });
});
