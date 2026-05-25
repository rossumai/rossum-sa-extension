import * as api from './api.js';
import { BATCH_SIZE } from './downloadCollection.js';

// Pure helpers for importing a parsed JSON document array into a collection.
//
// Why chunking:
//
// The original "Import from JSON file" sent the entire parsed array in one
// /data/insert_many call. When the server hits a write error on any document
// in the batch, pymongo raises BulkWriteError("batch op errors occurred")
// and the Rossum data-storage backend collapses the per-doc writeErrors
// array, so the only thing the user sees is the bare "batch op errors
// occurred" message — with no indication of which document failed or why.
//
// We chunk so that:
//   1) a server-side failure narrows the blast radius to a single batch
//      (the summary lists which record ranges failed)
//   2) the request body and request time per call stay bounded
//   3) cancellation has a tight checkpoint between batches
//
// We use the same chunk size as the dataset downloader so the same shape of
// data round-trips with the same per-call cost on both directions.
//
// The chunked overwrite path uses deleteMany(_id $in [...]) followed by
// insertMany — the same two-call pattern used by bulkOps.js for snapshot
// undo, which was specifically chosen over bulk_write replaceOne because the
// data-storage service's bulk_write wire format proved unreliable.

const PROBE_BATCH = 1000;

export function stableKey(id) {
  if (id === undefined) return 'u:';
  if (id === null) return 'n:';
  const t = typeof id;
  if (t === 'string') return 's:' + id;
  if (t === 'number') return 'd:' + id;
  if (t === 'boolean') return 'b:' + id;
  if (t === 'bigint') return 'i:' + id.toString();
  // Object _ids (e.g. EJSON {$oid: "..."} or {$date: ...}).
  // Sort keys recursively so {$oid: "x"} stringifies identically regardless
  // of property declaration order.
  return 'o:' + canonicalJson(id);
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

function hasOwn(obj, key) {
  return obj !== null && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);
}

// Quick stats on the parsed file, used to drive the wizard UI. Local-only —
// does not touch the network.
export function analyzeDocs(docs) {
  const stats = {
    total: docs.length,
    withId: 0,
    withoutId: 0,
    uniqueIdCount: 0,
    inFileDupeCount: 0,
    inFileDupeIdSample: [],
  };

  const seen = new Set();
  const dupKeys = new Set();
  for (const d of docs) {
    if (hasOwn(d, '_id')) {
      stats.withId++;
      const key = stableKey(d._id);
      if (seen.has(key)) {
        if (!dupKeys.has(key)) {
          stats.inFileDupeCount++;
          dupKeys.add(key);
          if (stats.inFileDupeIdSample.length < 5) stats.inFileDupeIdSample.push(d._id);
        }
      } else {
        seen.add(key);
      }
    } else {
      stats.withoutId++;
    }
  }
  stats.uniqueIdCount = seen.size;
  return stats;
}

// Keep only the first occurrence of each _id; documents without _id pass
// through unchanged (the server assigns ObjectIds).
export function dedupeById(docs) {
  const seen = new Set();
  const kept = [];
  let dropped = 0;
  for (const d of docs) {
    if (hasOwn(d, '_id')) {
      const k = stableKey(d._id);
      if (seen.has(k)) { dropped++; continue; }
      seen.add(k);
    }
    kept.push(d);
  }
  return { kept, dropped };
}

// Probe the collection for any of the given _ids. Returns a Set of canonical
// keys for ids that already exist. Used internally by runChunkedInsert after
// a batch failure to count how many of that batch's docs actually landed —
// pymongo BulkWriteError is raised AFTER each unordered batch attempts every
// doc, so we'd otherwise under-count successes.
async function findExistingIds(collection, ids, { signal } = {}) {
  const existing = new Set();
  if (!ids.length) return existing;
  for (let i = 0; i < ids.length; i += PROBE_BATCH) {
    if (signal?.aborted) throw makeAbortError();
    const chunk = ids.slice(i, i + PROBE_BATCH);
    const res = await api.find(collection, {
      query: { _id: { $in: chunk } },
      projection: { _id: 1 },
      limit: 0,
    });
    for (const doc of (res.result || [])) {
      existing.add(stableKey(doc._id));
    }
  }
  return existing;
}

// Chunked insert with continue-past-failure semantics. Each chunk is sent
// with ordered:false so the server inserts everything it can within the
// chunk; if the backend collapses the BulkWriteError detail we still know
// the surviving chunk range. The caller decides how to surface partial
// success.
//
// On a failed batch where the docs carry _ids, we re-probe the collection
// for that batch to count how many actually landed. This is a *post-failure*
// probe, not a pre-upload conflict check — it only fires when a batch error
// has already happened and we want accurate "inserted" numbers.
export async function runChunkedInsert(collection, docs, { batchSize = BATCH_SIZE, signal, onProgress } = {}) {
  const result = {
    attempted: docs.length,
    inserted: 0,
    failedBatches: [],
    cancelled: false,
  };
  let processed = 0;
  for (let i = 0; i < docs.length; i += batchSize) {
    if (signal?.aborted) { result.cancelled = true; break; }
    const chunk = docs.slice(i, i + batchSize);
    try {
      await api.insertMany(collection, chunk, false);
      result.inserted += chunk.length;
    } catch (err) {
      const failure = {
        startIdx: i,
        endIdx: i + chunk.length - 1,
        count: chunk.length,
        message: err?.message || String(err),
        landedFromChunk: null,
      };
      try {
        const idsInChunk = chunk
          .filter((d) => hasOwn(d, '_id'))
          .map((d) => d._id);
        if (idsInChunk.length > 0) {
          const existing = await findExistingIds(collection, idsInChunk, { signal });
          failure.landedFromChunk = existing.size;
          result.inserted += existing.size;
        }
      } catch (_probeErr) {
        // Best-effort. If the probe itself fails (e.g. aborted), skip it.
      }
      result.failedBatches.push(failure);
    }
    processed = i + chunk.length;
    onProgress?.({
      inserted: result.inserted,
      processed,
      total: docs.length,
      failedBatches: result.failedBatches.length,
    });
  }
  return result;
}

// Idempotent re-import: delete any document whose _id appears in the file
// (no-op for _ids the server doesn't have), then chunked-insert the full
// deduped file. Docs without an _id field skip the delete pass and get a
// server-assigned ObjectId on insert.
export async function runChunkedOverwrite(collection, docs, { batchSize = BATCH_SIZE, deleteBatch = PROBE_BATCH, signal, onProgress } = {}) {
  const result = {
    attempted: docs.length,
    deleted: 0,
    inserted: 0,
    failedBatches: [],
    deleteError: null,
    cancelled: false,
  };

  const idsToClear = [];
  for (const d of docs) {
    if (hasOwn(d, '_id')) idsToClear.push(d._id);
  }

  for (let i = 0; i < idsToClear.length; i += deleteBatch) {
    if (signal?.aborted) { result.cancelled = true; return result; }
    const chunk = idsToClear.slice(i, i + deleteBatch);
    try {
      const del = await api.deleteMany(collection, { _id: { $in: chunk } });
      result.deleted += del?.result?.deleted_count ?? 0;
    } catch (err) {
      result.deleteError = err?.message || String(err);
      return result;
    }
    onProgress?.({
      phase: 'delete',
      processed: Math.min(i + deleteBatch, idsToClear.length),
      total: idsToClear.length,
    });
  }

  const insertRes = await runChunkedInsert(collection, docs, {
    batchSize,
    signal,
    onProgress: (p) => onProgress?.({ phase: 'insert', ...p }),
  });
  result.inserted = insertRes.inserted;
  result.failedBatches = insertRes.failedBatches;
  result.cancelled = insertRes.cancelled;
  return result;
}

function makeAbortError() {
  if (typeof DOMException === 'function') return new DOMException('aborted', 'AbortError');
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}
