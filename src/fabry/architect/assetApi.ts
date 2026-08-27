// The asset transport, and the only place that knows an asset is TWO things: bytes held in a
// Rossum document, and an index row in Data Storage that maps the reference an author writes to
// that document (design 2026-08-24, D1).
//
// Two different APIs, two different auth headers. Bytes go through the core Rossum API with
// `Authorization: Token …` (the convention src/docs/resources.ts documents), reading the
// connection off the Fabry store signals at CALL time, so this module can be imported before the
// console shell has a token. The index goes through src/mdh/api.js, which the console shell has
// already `init`'d — nothing here re-inits it.
import * as mdh from '../../mdh/api.js';
import * as fstore from '../store.js';
import { ASSET_COLLECTION } from './collectionNames.js';
import { createAssetStore } from './assets.js';
import type { AssetRow } from './assets.js';

const DOCUMENTS = '/api/v1/documents';

function auth(): Record<string, string> {
  return { Authorization: `Token ${fstore.token.value}` };
}

function httpError(res: { status: number; statusText?: string }): Error {
  return new Error(`${res.status} ${res.statusText || ''}`.trim());
}

// ── The index (Data Storage) ────────────────────────────────────────────────────
// mdh.find answers one page at a time and defaults to 30, so a single explicit `limit` would only
// move a silent truncation further out — and a truncated index renders an asset that exists as a
// broken reference, with no explanation anywhere.
const PAGE = 1000;
// A backend that keeps answering full pages must not spin forever. Twenty pages is far past any
// real specification, so reaching it means something is wrong: say so rather than truncate.
const MAX_PAGES = 20;

/** Read every row of a paged collection, each page resuming AFTER the last `_id` seen. Exported
 *  for the test: the loop, not the wiring, is the part that can silently lose rows. */
export async function readAllPages(
  page: (after: string | null, limit: number) => Promise<any>,
): Promise<{ result: any[] }> {
  const result: any[] = [];
  let after: string | null = null;
  for (let i = 0; i < MAX_PAGES; i += 1) {
    const res = await page(after, PAGE);
    const batch: any[] = (res && res.result) || [];
    result.push(...batch);
    if (batch.length < PAGE) return { result };
    after = String(batch[batch.length - 1]?._id ?? '');
    // With no key to resume from, `$gt: ''` would re-read the page just read — every row on it
    // returned twice, which is a duplicated Preact key and a double-counted total — until
    // MAX_PAGES ended it. Mongo cannot store a row without an `_id`, so this is a response
    // nothing should have produced: say so rather than hand back the duplicates.
    if (!after) throw new Error('the asset index returned a row with no _id');
  }
  throw new Error(`the asset index is larger than ${MAX_PAGES * PAGE} rows`);
}

// Paged by KEY, never by `skip`. A `skip` counts rows the server can delete under us: remove the
// row at sorted position 3 between two pages and page 2 starts one row late, so one asset is never
// returned — silently, and permanently for the session, because a memoised success means nothing
// ever re-reads to correct it. `_id > last` names where to resume instead of counting how far in it
// is, so a delete behind the cursor shifts nothing into or out of view. The ascending sort is the
// order the cursor advances along, so it stays on EVERY page — an unsorted page would resume from
// an arbitrary row. src/mdh/downloadCollection.ts sorts its parallel readers for the same reason.
function findAssetRows(): Promise<any> {
  return readAllPages((after, limit) =>
    mdh.find(ASSET_COLLECTION, {
      query: after ? { kind: 'asset', _id: { $gt: after } } : { kind: 'asset' },
      limit,
      sort: { _id: 1 },
    }),
  );
}

let ensured: Promise<void> | null = null;
function ensureAssetCollection(): Promise<void> {
  if (!ensured) {
    // `find` reads a missing collection as an empty one (api.js documents that), but a write to
    // one is not guaranteed to create it — the Architect's own ensureCollection takes the same
    // precaution. Any error other than 401 means it already exists; a 401 is a session problem,
    // so the memo is dropped rather than leaving every later write to inherit a dead promise.
    ensured = mdh.createCollection(ASSET_COLLECTION).then(
      () => undefined,
      (err) => {
        if ((err as mdh.ApiError)?.status === 401) {
          ensured = null;
          throw err;
        }
      },
    );
  }
  return ensured;
}

function rowDocument(row: AssetRow): Record<string, unknown> {
  return {
    _id: row.key,
    kind: 'asset',
    documentId: row.documentId,
    mime: row.mime,
    name: row.name,
    size: row.size,
    sha256: row.sha256,
    aliases: row.aliases,
    uploadedAt: row.uploadedAt,
  };
}

// A NEW row is INSERTED, and that is the whole safety property of the write path: `_id` carries
// Mongo's mandatory unique index, so an insert against a key another session has taken since our
// last read FAILS instead of overwriting it. An upsert here would orphan that session's document
// and leave every existing reference to its key serving these bytes, with no error anywhere.
// `src/mdh/importFile.ts` leans on the same semantics — its insert-mode import treats a duplicate
// `_id` as a failed batch and probes which ids landed, never as an overwrite.
async function insertAssetRow(row: AssetRow): Promise<void> {
  await ensureAssetCollection();
  await mdh.insertOne(ASSET_COLLECTION, rowDocument(row));
}

// An EXISTING row, rewritten to carry one more alias. `upsert: false` is load-bearing: the row may
// have been deleted since the read that found it, and re-creating it would publish a reference to
// a document `remove` deleted in the same breath — a broken asset for every reader.
async function updateAssetRow(row: AssetRow): Promise<void> {
  await ensureAssetCollection();
  const res = await mdh.replaceOne(ASSET_COLLECTION, { _id: row.key }, rowDocument(row), {
    upsert: false,
  });
  // Best-effort reporting, and ONLY on an explicit zero: this repo has never verified what the
  // service returns for a write, so an absent count means "no information", not "no match". The
  // no-resurrection guarantee comes from `upsert: false` above, never from this.
  if (res && res.matchedCount === 0) {
    throw new Error(`${row.key} is no longer in the index — reload the index and try again`);
  }
}

function deleteAssetRow(key: string): Promise<any> {
  return mdh.deleteOne(ASSET_COLLECTION, { _id: key });
}

// ── The bytes (core Rossum API) ────────────────────────────────────────────────

async function postDocument(file: File): Promise<number> {
  const form = new FormData();
  form.append('content', file, file.name);
  // No `queue` parameter, deliberately: the document then belongs to no queue and no annotation,
  // so nothing extracts it, no hook fires and no automation statistic is created (design §3).
  const res = await fetch(`${fstore.domain.value}${DOCUMENTS}`, {
    method: 'POST',
    headers: auth(),
    body: form,
  });
  if (!res.ok) throw httpError(res);
  const data = await res.json().catch(() => null);
  const id = Number(data && data.id);
  if (!Number.isFinite(id)) throw new Error('the upload returned no document id');
  return id;
}

async function fetchAssetBytes(documentId: number, mime: string): Promise<Blob> {
  const res = await fetch(`${fstore.domain.value}${DOCUMENTS}/${documentId}/content`, {
    headers: auth(),
  });
  if (!res.ok) throw httpError(res);
  // The blob carries the INDEX ROW's mime, never the response's: the API normalises a
  // macro-enabled workbook to the plain spreadsheet mime although the bytes are untouched (D7),
  // and a browser handed that type has a file whose content contradicts its name.
  return new Blob([await res.arrayBuffer()], { type: mime });
}

async function deleteDocument(documentId: number): Promise<void> {
  const res = await fetch(`${fstore.domain.value}${DOCUMENTS}/${documentId}`, {
    method: 'DELETE',
    headers: auth(),
  });
  // A 404 means it is already gone, which is the state this call was asking for.
  if (!res.ok && res.status !== 404) throw httpError(res);
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// The live store, wired to the org the user is already authenticated against. Called exactly
// once — see store.ts for why there must be only one instance.
export function createArchitectAssetStore() {
  const store = createAssetStore({
    find: findAssetRows,
    fetchBytes: (documentId) => fetchAssetBytes(documentId, mimeFor(documentId)),
    sha256: sha256Hex,
    postDocument,
    insertRow: insertAssetRow,
    updateRow: updateAssetRow,
    deleteDocument,
    deleteRow: deleteAssetRow,
  });
  // The store's transport is handed a document id and nothing else, but the mime we may trust is
  // the row's (D7), so it is read back off the index the store itself holds.
  function mimeFor(documentId: number): string {
    const row = store.entries().find((r) => r.documentId === documentId);
    return (row && row.mime) || 'application/octet-stream';
  }
  return store;
}

/**
 * Hand one asset to the browser as a download, under its original filename. Returns null on
 * success, or a message to show. This is the whole of D6 — with no repository copy and no
 * cross-organization copy, it is the only way an asset leaves the org it was uploaded to.
 */
export async function downloadAsset(
  store: {
    resolve: (
      href: string,
    ) => Promise<{ row: { name: string }; url?: string; error?: string } | null>;
  },
  href: string,
): Promise<string | null> {
  const held = await store.resolve(href);
  if (!held) return `${href} is not published`;
  if (!held.url) return `${held.row ? held.row.name : href}: ${held.error || 'unavailable'}`;
  const a = document.createElement('a');
  a.href = held.url;
  a.download = held.row.name;
  // Not revoked afterwards, unlike downloadCollection's own pattern: this object URL belongs to
  // the store's cache, and revoking it would blank the same asset wherever the document paints it.
  a.click();
  return null;
}
