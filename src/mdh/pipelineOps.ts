// Pure helpers that mutate an aggregation pipeline array in response to a
// UI event (sort click, filter toggle, pagination). Unlike a full rebuild,
// these preserve any stages the user wrote directly in the editor ($match
// conditions, $project, $lookup, etc.) — only the stage owned by the UI
// event is inserted, updated, or removed.

import JSON5 from 'json5';

function hasKey(stage: any, key: string): boolean {
  return stage && typeof stage === 'object' && key in stage;
}

function findIndexBy(pipeline: any[], key: string): number {
  return pipeline.findIndex((s) => hasKey(s, key));
}

// Apply the UI sort state to an existing pipeline. If `sortSpec` has keys,
// replace or insert a `$sort` stage; if empty, remove any existing `$sort`.
export function applySortToPipeline(pipeline: any[], sortSpec: any): any[] {
  const sortIdx = findIndexBy(pipeline, '$sort');
  if (Object.keys(sortSpec).length > 0) {
    const stage = { $sort: { ...sortSpec } };
    if (sortIdx >= 0) {
      pipeline[sortIdx] = stage;
      return pipeline;
    }
    // Insert after the last $match, else before the first $skip/$limit, else at start.
    let insertAt = -1;
    for (let i = pipeline.length - 1; i >= 0; i--) {
      if (hasKey(pipeline[i], '$match')) {
        insertAt = i + 1;
        break;
      }
    }
    if (insertAt === -1) {
      const pagIdx = pipeline.findIndex((s) => hasKey(s, '$skip') || hasKey(s, '$limit'));
      insertAt = pagIdx >= 0 ? pagIdx : pipeline.length;
    }
    pipeline.splice(insertAt, 0, stage);
  } else if (sortIdx >= 0) {
    pipeline.splice(sortIdx, 1);
  }
  return pipeline;
}

// Toggle a single filter key in the first `$match` stage. If the filter was
// just activated, add/overwrite `field: value`; if deactivated, delete that
// key only. Other keys in `$match` (user-written or other UI filters) remain.
export function applyFilterDeltaToPipeline(
  pipeline: any[],
  field: string,
  value: any,
  active: boolean,
): any[] {
  const matchIdx = findIndexBy(pipeline, '$match');
  if (active) {
    if (matchIdx >= 0) {
      pipeline[matchIdx] = { $match: { ...pipeline[matchIdx].$match, [field]: value } };
    } else {
      pipeline.unshift({ $match: { [field]: value } });
    }
  } else if (matchIdx >= 0) {
    const next = { ...pipeline[matchIdx].$match };
    delete next[field];
    pipeline[matchIdx] = { $match: next };
  }
  return pipeline;
}

// Update or insert a `$skip` stage. When inserting, place it before `$limit`
// if present so skip/limit pagination semantics are preserved.
export function applySkipToPipeline(pipeline: any[], skipValue: number): any[] {
  const skipIdx = findIndexBy(pipeline, '$skip');
  if (skipIdx >= 0) {
    pipeline[skipIdx] = { $skip: skipValue };
    return pipeline;
  }
  const limitIdx = findIndexBy(pipeline, '$limit');
  if (limitIdx >= 0) pipeline.splice(limitIdx, 0, { $skip: skipValue });
  else pipeline.push({ $skip: skipValue });
  return pipeline;
}

// Reverse direction of the mutators: derive UI state (column sort arrows,
// filter chips) from a pipeline. Reads the *first* `$sort` and `$match` —
// subsequent ones (e.g., post-$group filters) remain implicit in the editor.
// Only primitive-valued `$match` entries become filter chips; operator-valued
// entries like `{price: {$gt: 10}}` can't be toggled from the UI, so they
// stay in the pipeline as-is without a chip.
// Takes `unknown` because it VALIDATES: the Array.isArray guard below is the contract,
// and callers hand it whatever came out of the editor.
export function extractUIStateFromPipeline(pipeline: unknown) {
  const sorts: Record<string, number> = {};
  const filters: Record<string, any> = {};
  if (!Array.isArray(pipeline)) return { sorts, filters };

  const sortStage = pipeline.find((s) => hasKey(s, '$sort'));
  if (sortStage && sortStage.$sort && typeof sortStage.$sort === 'object') {
    for (const [k, v] of Object.entries(sortStage.$sort)) {
      if (v === 1 || v === -1) sorts[k] = v;
    }
  }

  const matchStage = pipeline.find((s) => hasKey(s, '$match'));
  if (matchStage && matchStage.$match && typeof matchStage.$match === 'object') {
    for (const [k, v] of Object.entries(matchStage.$match)) {
      // Primitive values only — nested objects/arrays are operator expressions.
      if (v === null || (typeof v !== 'object' && typeof v !== 'function')) {
        filters[k] = v;
      }
    }
  }

  return { sorts, filters };
}

const BROWSE_STAGES = new Set(['$sort', '$skip', '$limit']);

// True when the effective pipeline returns anything other than the whole
// collection, so the unfiltered $collStats total is NOT a valid page bound.
export function pipelineReducesResultSet(stages: any[]): boolean {
  for (const stage of stages || []) {
    if (!stage || typeof stage !== 'object') continue;
    const key = Object.keys(stage)[0];
    if (key === '$match') {
      if (stage.$match && Object.keys(stage.$match).length > 0) return true;
      continue; // empty $match preserves all docs
    }
    if (!BROWSE_STAGES.has(key)) return true;
  }
  return false;
}

// Remove any `$out` or `$merge` stages from a pipeline, returning a new array.
// Used by the debug panel so count/preview probes never execute a write.
// Stripping is safe: the count entering a write stage equals the docs-that-
// would-be-written, which is meaningful; non-write pipelines are unaffected.
// `(stages || [])` is the contract: a missing pipeline strips to nothing.
export function stripWriteStages(stages: any[] | null | undefined): any[] {
  return (stages || []).filter((s) => {
    if (!s || typeof s !== 'object') return true;
    const k = Object.keys(s)[0];
    return k !== '$out' && k !== '$merge';
  });
}

// Inspect the LAST stage of a pipeline to detect terminal write stages.
// Returns `{ op, target }` when the last stage is `$out` or `$merge`; null otherwise.
// `$out` target: string value, or `value.coll` / `value.collectionName`.
// `$merge` target: `value.into` when a string, else `value.into.coll`.
/** The write stage a pipeline ends on, if any — `$out`/`$merge` are never executed. */
export type WriteStage = { op: '$out' | '$merge'; target: string };

export function terminalWriteStage(stages: any[]): WriteStage | null {
  const list = stages || [];
  const last = list[list.length - 1];
  if (!last || typeof last !== 'object') return null;
  const key = Object.keys(last)[0];
  if (key === '$out') {
    const v = last.$out;
    const target = typeof v === 'string' ? v : v?.coll || v?.collectionName || null;
    return target ? { op: '$out', target } : { op: '$out', target: '(unknown)' };
  }
  if (key === '$merge') {
    const into = last.$merge?.into;
    const target = typeof into === 'string' ? into : into?.coll || null;
    return target ? { op: '$merge', target } : { op: '$merge', target: '(unknown)' };
  }
  return null;
}

// Drop the contiguous trailing run of `$skip` / `$limit` stages from a
// pipeline, returning a new array. Mid-pipeline `$skip` / `$limit` stages
// are preserved — they may be query-specific (e.g., a `$limit` cap before a
// `$group`, or a `$skip` that's part of the query semantics).
//
// Used by the download flow: the editor's trailing pagination stages are for
// paging the on-screen preview, not for the export — the downloader appends
// its own `$skip` / `$limit` per batch.
// Takes `unknown` and THROWS on anything that is not an array — that rejection is the
// documented behaviour, so the signature must let a caller reach it.
export function stripPaginationStages(pipeline: unknown): any[] {
  if (!Array.isArray(pipeline)) {
    throw new Error('Pipeline must be a JSON array');
  }
  let end = pipeline.length;
  while (end > 0) {
    const stage = pipeline[end - 1];
    if (!stage || typeof stage !== 'object') break;
    if (!('$skip' in stage) && !('$limit' in stage)) break;
    end--;
  }
  return pipeline.slice(0, end);
}

// Parse the editor pipeline for the export wizard's "Current filter" scope.
// substitute = the placeholder substituter (pipeline.substituteWithTypes).
// Never throws: any problem comes back as { available: false, reason }.
export function parseExportFilter(rawText: string, substitute: (t: string) => string) {
  try {
    const parsed = JSON5.parse(substitute(rawText));
    if (!Array.isArray(parsed)) throw new Error('pipeline must be a JSON array');
    const stages = stripPaginationStages(parsed);
    if (stages.length === 0)
      return {
        stages: null,
        available: false,
        reason: 'No filter is active — the pipeline is empty.',
      };
    if (terminalWriteStage(stages)) {
      return {
        stages: null,
        available: false,
        reason: 'The pipeline ends in a write stage ($out/$merge) — exports are read-only.',
      };
    }
    return {
      stages,
      available: true,
      trivial: stages.length === 1 && JSON.stringify(stages[0]) === '{"$match":{}}',
    };
  } catch (err) {
    return { stages: null, available: false, reason: (err as Error).message };
  }
}
