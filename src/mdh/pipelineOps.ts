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

// The window the pagination controls own: the contiguous trailing run of
// `$skip` / `$limit` stages — the same trailing-run rule `stripPaginationStages`
// below already applies, and for the same reason. Everything before that run is
// the user's query, so a `$skip` there is load-bearing (a deliberate offset, or
// a cap before a `$group`) and must never be rewritten as a page offset.
//
// Returns null when the run is not one the UI can drive, in which case the
// caller disables Prev/Next rather than inventing pagination stages:
//   • no `$limit` in the run — with no page size there is no next page;
//   • more than one `$skip` or `$limit`, or one stage carrying both;
//   • the `$skip` sits AFTER the `$limit`, where paging forward could only ever
//     return an empty page;
//   • either bound is not a usable count.
// Takes `unknown` because it VALIDATES: callers hand it whatever parsed out of
// the editor.
export type PaginationWindow = {
  skipIndex: number; // -1 when the run has a `$limit` but no `$skip` yet
  limitIndex: number;
  skip: number;
  limit: number;
};

export function findPaginationWindow(pipeline: unknown): PaginationWindow | null {
  if (!Array.isArray(pipeline)) return null;
  const skips: number[] = [];
  const limits: number[] = [];
  for (let i = pipeline.length - 1; i >= 0; i--) {
    const stage = pipeline[i];
    if (!stage || typeof stage !== 'object') break;
    // `applyMutationToText` rides disabled stages through the mutator as inert
    // objects with no own keys. Step over them, so this scan sees the same
    // trailing run as a scan over the active stages alone.
    if (Object.keys(stage).length === 0) continue;
    const isSkip = '$skip' in stage;
    const isLimit = '$limit' in stage;
    if (!isSkip && !isLimit) break;
    if (isSkip && isLimit) return null;
    (isSkip ? skips : limits).push(i);
  }
  if (limits.length !== 1 || skips.length > 1) return null;
  const limitIndex = limits[0];
  const skipIndex = skips.length > 0 ? skips[0] : -1;
  if (skipIndex > limitIndex) return null;
  const limit = pipeline[limitIndex].$limit;
  if (!Number.isInteger(limit) || limit <= 0) return null;
  const skip = skipIndex >= 0 ? pipeline[skipIndex].$skip : 0;
  if (!Number.isInteger(skip) || skip < 0) return null;
  return { skipIndex, limitIndex, skip, limit };
}

// Write the page offset into the pagination window, inserting the `$skip` in
// front of the window's `$limit` when the pipeline has none yet. A pipeline
// with no window is returned untouched.
export function applySkipToPipeline(pipeline: any[], skipValue: number): any[] {
  const win = findPaginationWindow(pipeline);
  if (!win) return pipeline;
  if (win.skipIndex >= 0) pipeline[win.skipIndex] = { $skip: skipValue };
  else pipeline.splice(win.limitIndex, 0, { $skip: skipValue });
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
