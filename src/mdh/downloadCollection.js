import * as api from './api.js';
import { csvHeader, csvRow, orderColumns, buildColumnDiscoveryPipeline } from './csv.js';
import { docToXml, toXmlName } from './xml.js';

// Streamed export of a collection's documents, format-agnostic via a pluggable
// serializer. The streaming engine (sliding-window workers, in-order flush,
// buffer-room backpressure, cancellation, FS-Access-vs-Blob) is unchanged from
// the JSON-only version; only serialization differs.
//
// A serializer is { ext, mimeType, pickerTypes, init?(ctx), preamble(), item(doc),
// separator, postamble() }. `init` (optional) runs AFTER the file picker — so the
// picker stays the first await after the user gesture — and before the preamble;
// the CSV serializer uses it to discover the column set.
//
// Stable ordering across batches: each worker issues its own aggregate, and Mongo
// gives no stable natural order across independent aggregations. We append
// {$sort:{_id:1}} unless the caller's pipeline already ends with a $sort, so every
// worker scans in the same deterministic order.

export const BATCH_SIZE = 1000;
export const CONCURRENCY = 10;
export const MAX_BUFFERED = CONCURRENCY * 2;

function formatJsonDoc(doc) {
  // Match JSON.stringify(array, null, 2)'s per-element indent.
  return '  ' + JSON.stringify(doc, null, 2).replace(/\n/g, '\n  ');
}

// Default serializer — byte-for-byte identical to the previous JSON output.
export function buildJsonSerializer() {
  return {
    ext: 'json',
    mimeType: 'application/json',
    pickerTypes: [{ description: 'JSON file', accept: { 'application/json': ['.json'] } }],
    preamble: () => '[\n',
    item: (doc) => formatJsonDoc(doc),
    separator: ',\n',
    postamble: () => '\n]\n',
  };
}

// CSV serializer. Columns are the exact union of top-level keys, discovered in
// init() (after the picker). Objects/arrays are JSON-encoded per csvCell.
export function buildCsvSerializer({ dialect = {}, header = true, bom = true, columns = null } = {}) {
  let cols = columns;
  return {
    ext: 'csv',
    mimeType: 'text/csv',
    pickerTypes: [{ description: 'CSV file', accept: { 'text/csv': ['.csv'] } }],
    async init({ collectionName, pipelineStages }) {
      if (cols != null) return;
      const res = await api.aggregate(collectionName, buildColumnDiscoveryPipeline(pipelineStages));
      cols = orderColumns(res?.result?.[0]?.keys ?? []);
    },
    preamble: () => (bom ? '﻿' : '') + (header ? csvHeader(cols, dialect) + '\r\n' : ''),
    item: (doc) => csvRow(doc, cols, dialect),
    separator: '\r\n',
    postamble: () => '',
  };
}

// XML serializer — plain text, streams incrementally like JSON/CSV. Every field
// becomes a child element (no attributes); keys are sanitized to valid XML names.
export function buildXmlSerializer({ rootName = 'records', recordName = 'record' } = {}) {
  const root = toXmlName(rootName);
  return {
    ext: 'xml',
    mimeType: 'application/xml',
    pickerTypes: [{ description: 'XML file', accept: { 'application/xml': ['.xml'] } }],
    preamble: () => `<?xml version="1.0" encoding="UTF-8"?>\n<${root}>\n`,
    item: (doc) => '  ' + docToXml(doc, recordName),
    separator: '\n',
    postamble: () => `\n</${root}>\n`,
  };
}

// NDJSON / JSON Lines serializer — one compact JSON object per line. Streams
// incrementally like JSON/CSV; preserves EJSON shapes ($oid/$date) as literal JSON.
export function buildNdjsonSerializer() {
  return {
    ext: 'jsonl',
    mimeType: 'application/x-ndjson',
    pickerTypes: [{ description: 'JSON Lines file', accept: { 'application/x-ndjson': ['.jsonl', '.ndjson'] } }],
    preamble: () => '',
    item: (doc) => JSON.stringify(doc),
    separator: '\n',
    postamble: () => '',
  };
}

export async function downloadCollection(collectionName, opts = {}) {
  const {
    fetchCount = async () => 0,
    isCancelled = () => false,
    onProgress = () => {},
    serializer = buildJsonSerializer(),
    pickFile = (name) => defaultPickFile(name, serializer.pickerTypes),
    downloadBlob = defaultDownloadBlob,
    batchSize = BATCH_SIZE,
    concurrency = CONCURRENCY,
    maxBuffered = MAX_BUFFERED,
    pipelineStages = [{ $match: {} }],
    filename: filenameOpt,
  } = opts;

  const filename = filenameOpt || `${collectionName}.${serializer.ext}`;

  // Picker must be the first await after the user gesture.
  let writer = null;
  try {
    const handle = await pickFile(filename);
    if (handle) writer = await handle.createWritable();
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return { fetched: 0, cancelled: true, streamed: false };
    }
    // Anything else (no support, permission denied) → Blob fallback.
  }

  try {
    let total = await fetchCount();
    if (!Number.isFinite(total) || total < 0) total = 0;
    onProgress({ fetched: 0, total });

    if (isCancelled()) {
      await safeAbort(writer);
      return { fetched: 0, cancelled: true, streamed: !!writer };
    }

    // Format-specific setup (CSV column discovery). After the picker, so the
    // picker keeps transient activation; cancellable on either side.
    if (serializer.init) {
      await serializer.init({ collectionName, pipelineStages });
      if (isCancelled()) {
        await safeAbort(writer);
        return { fetched: 0, cancelled: true, streamed: !!writer };
      }
    }

    const offsets = [];
    for (let s = 0; s < total; s += batchSize) offsets.push(s);

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
    const bufferWaiters = [];

    async function writeChunk(text) {
      if (writer) await writer.write(text);
      else parts.push(text);
    }
    function wakeOneWaiter() { const r = bufferWaiters.shift(); if (r) r(); }
    function wakeAllWaiters() { while (bufferWaiters.length > 0) bufferWaiters.shift()(); }

    function scheduleFlush() {
      flushChain = flushChain.then(async () => {
        while (pending.has(nextWriteIdx)) {
          const docs = pending.get(nextWriteIdx);
          pending.delete(nextWriteIdx);
          let buf = '';
          for (const doc of docs) {
            if (docsWritten > 0) buf += serializer.separator;
            buf += serializer.item(doc);
            docsWritten++;
          }
          if (buf) await writeChunk(buf);
          nextWriteIdx++;
          wakeOneWaiter();
        }
      });
    }

    function stopped() { return isCancelled() || workerError !== null; }

    async function workerLoop() {
      while (true) {
        if (stopped()) return;
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

    await writeChunk(serializer.preamble());

    const workers = Array.from(
      { length: Math.min(concurrency, offsets.length) },
      () => workerLoop(),
    );
    await Promise.all(workers);
    await flushChain;

    if (workerError) throw workerError;

    if (isCancelled()) {
      await safeAbort(writer);
      return { fetched, cancelled: true, streamed: !!writer };
    }

    await writeChunk(serializer.postamble());

    if (writer) {
      await writer.close();
    } else {
      downloadBlob(new Blob(parts, { type: serializer.mimeType }), filename);
    }
    return { fetched, cancelled: false, streamed: !!writer };
  } catch (err) {
    await safeAbort(writer);
    throw err;
  }
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

function defaultPickFile(suggestedName, types) {
  if (typeof window === 'undefined' || typeof window.showSaveFilePicker !== 'function') {
    return Promise.resolve(null);
  }
  return window.showSaveFilePicker({ suggestedName, types });
}

function defaultDownloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
