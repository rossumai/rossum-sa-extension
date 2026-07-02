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

// A string that is exactly 24 hex chars is the canonical MongoDB ObjectId form.
const OBJECTID_RE = /^[0-9a-fA-F]{24}$/;

// Normalize a document's `_id` so an ObjectId-looking string imports as a real
// MongoDB ObjectId. A 24-hex-char string `_id` becomes EJSON `{$oid: <hex>}`,
// which the Data Storage API parses into a BSON ObjectId on insert (the same
// EJSON-on-input path the $in conflict probe relies on). Everything else is left
// as-is: non-hex string keys (e.g. "US", a SKU) stay strings, numeric and
// already-`{$oid}` ids are untouched, and a doc without `_id` is unchanged.
// Returns a shallow copy only when it coerces; never mutates the input.
export function normalizeDocId(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return doc;
  if (typeof doc._id === 'string' && OBJECTID_RE.test(doc._id)) {
    return { ...doc, _id: { $oid: doc._id } };
  }
  return doc;
}

// Keep only the first occurrence of each _id; documents without _id pass
// through unchanged (the server assigns ObjectIds). Also normalizes
// ObjectId-looking string _ids to {$oid} (see normalizeDocId) so the dedup keys
// on — and the insert/overwrite write — real ObjectIds.
export function dedupeById(docs) {
  const seen = new Set();
  const kept = [];
  let dropped = 0;
  for (const raw of docs) {
    const d = normalizeDocId(raw);
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

function makeAbortError() {
  if (typeof DOMException === 'function') return new DOMException('aborted', 'AbortError');
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}
