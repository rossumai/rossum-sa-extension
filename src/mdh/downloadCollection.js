import * as api from './api.js';

// Streamed JSON export of a collection's documents.
//
// Two write strategies:
//  1. showSaveFilePicker (preferred): user picks a destination up-front,
//     each batch is written to disk as it arrives. Memory stays bounded
//     at roughly maxBuffered batches + concurrency in-flight requests.
//  2. Blob-parts fallback (no picker support, or non-AbortError throw):
//     each batch is serialized to its own string and pushed into a parts
//     array; one Blob is built from the parts at the very end. The parts
//     never get concatenated into a single huge JS string, so we never
//     trip V8's max string length (which is what produces "Invalid string
//     length" on the JSON.stringify(everything) path).
//
// Concurrency model: a sliding window of CONCURRENCY workers. Each worker
// pulls the next-available offset, fetches it, deposits the result, and
// loops. There's no barrier — slot N+1 can start the moment slot N
// finishes, so a slow batch only stalls the *write* (which has to wait
// for its in-order predecessors) and never the *fetch* pipeline. The
// workers naturally prioritize earlier offsets because they pull from a
// monotonically-increasing counter in source order.
//
// Writes are still serialized in source order via a chained-promise flush
// so the on-disk JSON stays sequential. A pending buffer holds completed
// batches that are still waiting for their in-order predecessor; if it
// fills (writes lagging behind fetches), workers pause until the writer
// drains.
//
// Cancellation (opt-in via isCancelled()) is checked between fetches and
// inside the buffer-room wait. The streaming file, if any, is aborted on
// cancel so the partial file is discarded rather than left as half-valid
// JSON on the user's disk.
//
// Stable ordering across batches: each worker issues its OWN aggregate
// call, and MongoDB does not guarantee a stable natural order across
// independent aggregations on the same collection. Without an explicit
// sort, adjacent $skip/$limit windows can overlap (the same doc appears
// in two batches) AND leave gaps (other docs missed entirely). We append
// {$sort: {_id: 1}} to the pipeline when the caller hasn't provided
// their own sort, so every worker scans in the same deterministic order.
// {_id: 1} uses the always-present _id index, so this is free.

export const BATCH_SIZE = 1000;
export const CONCURRENCY = 10;
// Cap on completed-but-not-yet-written batches. Bounds memory when the
// writer is slower than the fetcher (uncommon — writes are usually
// instant for FS Access API and Blob parts — but worth bounding anyway).
export const MAX_BUFFERED = CONCURRENCY * 2;

export async function downloadCollection(collectionName, opts = {}) {
  const {
    fetchCount = async () => 0,
    isCancelled = () => false,
    onProgress = () => {},
    pickFile = defaultPickFile,
    downloadBlob = defaultDownloadBlob,
    batchSize = BATCH_SIZE,
    concurrency = CONCURRENCY,
    maxBuffered = MAX_BUFFERED,
    // Prepended to every batch's aggregate call. Default downloads the raw
    // collection; pass `[{$match: ...}, {$sort: ...}, ...]` to export the
    // result of a filtered/transformed pipeline. The downloader appends its
    // own `$sort` (if absent), `$skip`, and `$limit` per batch — callers
    // should strip those. Callers sorting on a non-unique field should
    // include `_id` as a tie-breaker (e.g. `{$sort: {name: 1, _id: 1}}`)
    // to keep batch boundaries stable.
    pipelineStages = [{ $match: {} }],
    filename: filenameOpt,
  } = opts;

  const filename = filenameOpt || `${collectionName}.json`;

  // Picker must be the first await after the user gesture — any earlier
  // await would invalidate transient activation and the browser would
  // refuse the call.
  let writer = null;
  try {
    const handle = await pickFile(filename);
    if (handle) writer = await handle.createWritable();
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return { fetched: 0, cancelled: true, streamed: false };
    }
    // Anything else (no support, permission denied, security) → Blob fallback.
  }

  try {
    let total = await fetchCount();
    if (!Number.isFinite(total) || total < 0) total = 0;
    onProgress({ fetched: 0, total });

    if (isCancelled()) {
      await safeAbort(writer);
      return { fetched: 0, cancelled: true, streamed: !!writer };
    }

    const offsets = [];
    for (let s = 0; s < total; s += batchSize) offsets.push(s);

    // Inject a deterministic sort unless the caller already ended their
    // pipeline with one. Without this, separate aggregate calls can iterate
    // the collection in different orders and the workers' $skip/$limit
    // windows overlap.
    const stages = pipelineEndsWithSort(pipelineStages)
      ? pipelineStages
      : [...pipelineStages, { $sort: { _id: 1 } }];

    const parts = [];
    let docsWritten = 0;
    let fetched = 0;
    const pending = new Map();
    let nextFetchIdx = 0;
    let nextWriteIdx = 0;
    let flushChain = Promise.resolve();
    let workerError = null;
    // Resolvers for workers parked on backpressure. Woken one-at-a-time
    // by the writer as it drains pending, or all-at-once on cancel/error.
    const bufferWaiters = [];

    async function writeChunk(text) {
      if (writer) await writer.write(text);
      else parts.push(text);
    }

    function wakeOneWaiter() {
      const r = bufferWaiters.shift();
      if (r) r();
    }
    function wakeAllWaiters() {
      while (bufferWaiters.length > 0) bufferWaiters.shift()();
    }

    function scheduleFlush() {
      flushChain = flushChain.then(async () => {
        while (pending.has(nextWriteIdx)) {
          const docs = pending.get(nextWriteIdx);
          pending.delete(nextWriteIdx);
          let buf = '';
          for (const doc of docs) {
            if (docsWritten > 0) buf += ',\n';
            buf += formatDoc(doc);
            docsWritten++;
          }
          if (buf) await writeChunk(buf);
          nextWriteIdx++;
          wakeOneWaiter();
        }
      });
    }

    function stopped() {
      return isCancelled() || workerError !== null;
    }

    async function workerLoop() {
      while (true) {
        if (stopped()) return;

        // Backpressure: pause if the writer is lagging behind. Re-checks
        // after each wake-up in case the user cancelled while parked.
        while (pending.size >= maxBuffered && !stopped()) {
          await new Promise((r) => bufferWaiters.push(r));
        }
        if (stopped()) return;

        if (nextFetchIdx >= offsets.length) return;
        const myIdx = nextFetchIdx++;
        const myOffset = offsets[myIdx];

        try {
          const res = await api.aggregate(collectionName, [
            ...stages,
            { $skip: myOffset },
            { $limit: batchSize },
          ]);
          const docs = res?.result || [];
          pending.set(myIdx, docs);
          fetched += docs.length;
          onProgress({ fetched, total });
          scheduleFlush();
        } catch (err) {
          if (workerError === null) workerError = err;
          wakeAllWaiters();
          return;
        }
      }
    }

    await writeChunk('[\n');

    const workers = Array.from(
      { length: Math.min(concurrency, offsets.length) },
      () => workerLoop(),
    );
    await Promise.all(workers);
    await flushChain;

    if (workerError) throw workerError; // outer catch aborts the writer

    if (isCancelled()) {
      await safeAbort(writer);
      return { fetched, cancelled: true, streamed: !!writer };
    }

    await writeChunk('\n]\n');

    if (writer) {
      await writer.close();
    } else {
      downloadBlob(new Blob(parts, { type: 'application/json' }), filename);
    }
    return { fetched, cancelled: false, streamed: !!writer };
  } catch (err) {
    await safeAbort(writer);
    throw err;
  }
}

// Match JSON.stringify(array, null, 2)'s per-element indent: prepend two
// spaces to the doc and to every internal newline.
function formatDoc(doc) {
  return '  ' + JSON.stringify(doc, null, 2).replace(/\n/g, '\n  ');
}

function pipelineEndsWithSort(stages) {
  if (!Array.isArray(stages) || stages.length === 0) return false;
  const last = stages[stages.length - 1];
  return last && typeof last === 'object' && Object.prototype.hasOwnProperty.call(last, '$sort');
}

async function safeAbort(writer) {
  if (!writer || typeof writer.abort !== 'function') return;
  try { await writer.abort('cancelled'); } catch { /* writer may already be closed */ }
}

function defaultPickFile(suggestedName) {
  if (typeof window === 'undefined' || typeof window.showSaveFilePicker !== 'function') {
    return Promise.resolve(null);
  }
  return window.showSaveFilePicker({
    suggestedName,
    types: [{ description: 'JSON file', accept: { 'application/json': ['.json'] } }],
  });
}

function defaultDownloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
