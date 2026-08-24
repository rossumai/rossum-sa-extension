import * as api from './api.js';
import { csvHeader, csvRow, orderColumns } from './csv.js';
import { discoverLeafPaths } from './columnDiscovery.js';
import { docToXml, toXmlName } from './xml.js';

// Streamed binary serializer for .xlsx — re-exported so callers (DataPanel) get
// every serializer factory from one module.
export { buildXlsxSerializer } from './xlsxWrite.js';

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

function formatJsonDoc(doc: unknown) {
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
    item: (doc: unknown) => formatJsonDoc(doc),
    separator: ',\n',
    postamble: () => '\n]\n',
  };
}

// CSV serializer. Columns are the exact union of deep leaf paths (address.city,
// not a JSON blob under address), discovered in init() (after the picker).
// Objects/arrays past the depth cap are JSON-encoded per csvCell.
export function buildCsvSerializer(
  { dialect = {}, header = true, bom = true, columns = null }:
  { dialect?: any; header?: boolean; bom?: boolean; columns?: string[] | null } = {},
) {
  let cols: string[] | null = columns;
  return {
    ext: 'csv',
    mimeType: 'text/csv',
    pickerTypes: [{ description: 'CSV file', accept: { 'text/csv': ['.csv'] } }],
    async init({ collectionName, pipelineStages }: { collectionName: string; pipelineStages: any[] }) {
      if (cols != null) return;
      cols = orderColumns(await discoverLeafPaths(collectionName, pipelineStages, { aggregate: api.aggregate }));
    },
    preamble: () => (bom ? '﻿' : '') + (header ? csvHeader(cols!, dialect) + '\r\n' : ''),
    item: (doc: unknown) => csvRow(doc, cols!, dialect),
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
    item: (doc: any) => '  ' + docToXml(doc, recordName),
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
    item: (doc: unknown) => JSON.stringify(doc),
    separator: '\n',
    postamble: () => '',
  };
}

// Everything the streamed export needs, all injectable: the tests drive it with no picker, no
// network and no clock.
type DownloadOpts = {
  fetchCount?: () => Promise<number>;
  isCancelled?: () => boolean;
  onProgress?: (p: any) => void;
  serializer?: any;
  pickFile?: (name: string) => Promise<any>;
  downloadBlob?: (blob: Blob, filename: string) => void;
  batchSize?: number;
  concurrency?: number;
  maxBuffered?: number;
  pipelineStages?: any[];
  filename?: string;
};

export async function downloadCollection(collectionName: string, opts: DownloadOpts = {}) {
  const {
    fetchCount = async () => 0,
    isCancelled = () => false,
    onProgress = () => {},
    serializer = buildJsonSerializer(),
    pickFile = (name: string) => defaultPickFile(name, serializer.pickerTypes),
    downloadBlob = defaultDownloadBlob,
    batchSize = BATCH_SIZE,
    concurrency = CONCURRENCY,
    maxBuffered = MAX_BUFFERED,
    pipelineStages = [{ $match: {} }],
    filename: filenameOpt,
  } = opts;

  const filename = filenameOpt || `${collectionName}.${serializer.ext}`;

  // Picker must be the first await after the user gesture.
  let writer: any = null;
  try {
    const handle = await pickFile(filename);
    if (handle) writer = await handle.createWritable();
  } catch (err) {
    if (err && (err as any).name === 'AbortError') {
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

    const offsets: number[] = [];
    for (let s = 0; s < total; s += batchSize) offsets.push(s);

    const stages = pipelineEndsWithSort(pipelineStages)
      ? pipelineStages
      : [...pipelineStages, { $sort: { _id: 1 } }];

    const parts: (string | Uint8Array)[] = [];
    let docsWritten = 0;
    let fetched = 0;
    const pending = new Map();
    let nextFetchIdx = 0;
    let nextWriteIdx = 0;
    let flushChain = Promise.resolve();
    let workerError: unknown = null;
    const bufferWaiters: (() => void)[] = [];

    // Chunk may be a string (text serializers) or a Uint8Array (binary
    // serializers, e.g. xlsx). FS-Access write() and Blob both accept bytes.
    const isBinary = serializer.binary === true;
    async function writeChunk(chunk: string | Uint8Array) {
      if (writer) await writer.write(chunk);
      else parts.push(chunk);
    }
    function wakeOneWaiter() { const r = bufferWaiters.shift(); if (r) r(); }
    function wakeAllWaiters() { while (bufferWaiters.length > 0) bufferWaiters.shift()!(); }

    function scheduleFlush() {
      flushChain = flushChain.then(async () => {
        while (pending.has(nextWriteIdx)) {
          const docs = pending.get(nextWriteIdx);
          pending.delete(nextWriteIdx);
          if (isBinary) {
            await serializer.writeDocs(docs, writeChunk);
            docsWritten += docs.length;
          } else {
            let buf = '';
            for (const doc of docs) {
              if (docsWritten > 0) buf += serializer.separator;
              buf += serializer.item(doc);
              docsWritten++;
            }
            if (buf) await writeChunk(buf);
          }
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
          await new Promise<void>((r) => bufferWaiters.push(r));
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

    if (isBinary) await serializer.start(writeChunk, { collectionName, pipelineStages });
    else await writeChunk(serializer.preamble());

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

    if (isBinary) await serializer.finish(writeChunk);
    else await writeChunk(serializer.postamble());

    if (writer) {
      await writer.close();
    } else {
      downloadBlob(new Blob(parts as BlobPart[], { type: serializer.mimeType }), filename);
    }
    return { fetched, cancelled: false, streamed: !!writer };
  } catch (err) {
    await safeAbort(writer);
    throw err;
  }
}

function pipelineEndsWithSort(stages: unknown): boolean {
  if (!Array.isArray(stages) || stages.length === 0) return false;
  const last = (stages as any[])[(stages as any[]).length - 1];
  return last && typeof last === 'object' && Object.prototype.hasOwnProperty.call(last, '$sort');
}

async function safeAbort(writer: any) {
  if (!writer || typeof writer.abort !== 'function') return;
  try { await writer.abort('cancelled'); } catch { /* writer may already be closed */ }
}

// showSaveFilePicker is not in TS's DOM lib (File System Access is not in every engine), so the
// feature test that already guards it is the only contract there is.
function defaultPickFile(suggestedName: string, types: unknown) {
  if (typeof window === 'undefined' || typeof (window as any).showSaveFilePicker !== 'function') {
    return Promise.resolve(null);
  }
  return (window as any).showSaveFilePicker({ suggestedName, types });
}

function defaultDownloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
