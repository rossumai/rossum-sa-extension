import { joinPath, splitPath, isOpaqueKey } from './flatten.js';

// Exhaustive discovery of the leaf paths an export's header must carry.
//
// Why not one clever recursive pipeline: MongoDB has no recursive
// $objectToArray. Why not a sample: a leaf missing from the header is data
// silently dropped from the file. So we walk one level per round trip, batching
// every parent at that level into a single $facet — typically 1-3 calls for
// real master data, and it terminates on its own when no object-valued key is
// left.

export const MAX_DISCOVERY_DEPTH = 5;

// A pending parent never holds an opaque segment (see isOpaqueKey), so every
// one of its segments is dot-free and splitPath(p).join('.') is exactly its
// Mongo field path. That invariant is what makes this substitution safe.
function fieldExpr(parent: string): string {
  return parent === '' ? '$$ROOT' : '$' + splitPath(parent).join('.');
}

export function buildLevelPipeline(filterStages: any[], parents: string[]): any[] {
  const facet: Record<string, any[]> = {};
  parents.forEach((p, i) => {
    const expr = fieldExpr(p);
    // Positional keys (f0, f1, …), not the parent path itself: a $facet key
    // cannot contain a dot, and a parent path routinely does.
    facet[`f${i}`] = [
      // $objectToArray errors on a non-document, and a path can hold an array or
      // a scalar in some records — the guard is required, not defensive.
      { $project: { kv: { $cond: [{ $eq: [{ $type: expr }, 'object'] }, { $objectToArray: expr }, []] } } },
      { $unwind: '$kv' },
      { $group: { _id: '$kv.k', types: { $addToSet: { $type: '$kv.v' } } } },
    ];
  });
  return [...filterStages, { $facet: facet }];
}

export async function discoverLeafPaths(
  collectionName: string,
  filterStages: any[],
  { aggregate, maxDepth = MAX_DISCOVERY_DEPTH, signal }: {
    aggregate: (c: string, p: any[], o?: any) => Promise<any>;
    maxDepth?: number;
    signal?: AbortSignal;
  },
): Promise<string[]> {
  const leaves = new Set<string>();
  let parents = [''];

  for (let depth = 1; depth <= maxDepth && parents.length > 0; depth++) {
    const res = await aggregate(collectionName, buildLevelPipeline(filterStages, parents), { signal });
    const facet = res?.result?.[0] || {};
    const next: string[] = [];

    parents.forEach((p, i) => {
      const rows = facet[`f${i}`] || [];
      // A pending parent whose children query returns nothing was an EMPTY object in
      // every record that had it. $type reports {} as 'object' just like a populated
      // sub-document, so it got queued as a parent — but flattenDoc treats {} as a
      // LEAF, so without this the header loses a column flattenDoc still fills.
      if (p !== '' && rows.length === 0) leaves.add(p);
      for (const row of rows) {
        const key = row?._id;
        if (typeof key !== 'string') continue;
        const path = p === '' ? joinPath([key]) : `${p}.${joinPath([key])}`;
        const types: string[] = Array.isArray(row.types) ? row.types : [];
        const opaque = isOpaqueKey(key);
        const objectOnly = types.length === 1 && types[0] === 'object';

        if (types.includes('object') && !opaque && depth < maxDepth) next.push(path);
        if (!objectOnly || opaque || depth >= maxDepth) leaves.add(path);
      }
    });

    parents = next;
  }

  return [...leaves];
}
