// Asset bytes, fetched once and held as an object URL.
//
// Bounded by TOTAL BYTES rather than entry count: a workbook and an icon are not the same cost, and
// a count-based cap would happily hold twenty workbooks. Transport is injected so this tests without
// a browser or a live org.
import { signal } from '@preact/signals';
import { cleanHref, keyForFile, mimeForName } from './assetKeys.js';
// Never the empty string: `indexError` doubles as the flag for "the read failed" — in
// `uploadNow`'s guard, in the panel's error banner and in what disables its upload controls — so a
// rejection carrying no message would otherwise leave a failed read reading as no error at all.
import { message } from './errorText.js';

export type AssetRow = {
  key: string;
  documentId: number;
  mime: string;
  name: string;
  size: number;
  sha256: string;
  aliases: string[];
  uploadedAt: number | null;
};

export type Held = { row: AssetRow; url?: string; error?: string };

// The store's byte budget when a caller names none. NOT exported: `createAssetStore`'s own default
// is the only consumer, and an exported knob nothing turns is a knob that reads as configurable.
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

// Rossum's per-document ceiling. Enforced HERE rather than in any one caller so every upload path
// inherits it — the panel, the editor's paste, and whatever comes next; a caller that forgot would
// turn a named refusal into an opaque API error. The figure is documented and was confirmed by the
// 2026-08-24 live test, recorded in
// docs/superpowers/specs/2026-08-24-architect-assets-design.md §3 ("Deletion is clean").
//
// The message does NOT name the file: the panel's log row already carries the name in its own
// column, and the editor prefixes it — which it must do for every store rejection anyway.
const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;

function toRow(d: Record<string, any>): AssetRow | null {
  if (!d || d.kind !== 'asset' || d.documentId == null) return null;
  return {
    key: String(d._id),
    documentId: Number(d.documentId),
    mime: typeof d.mime === 'string' ? d.mime : 'application/octet-stream',
    name: typeof d.name === 'string' ? d.name : String(d._id).split('/').pop() || 'file',
    size: typeof d.size === 'number' ? d.size : 0,
    sha256: typeof d.sha256 === 'string' ? d.sha256 : '',
    aliases: Array.isArray(d.aliases) ? d.aliases.filter((a: any) => typeof a === 'string') : [],
    uploadedAt: typeof d.uploadedAt === 'number' ? d.uploadedAt : null,
  };
}

// The row for a file that has just been posted. Named so the collision retry can re-key it without
// rebuilding every other field from the File again.
function rowFor(f: File, key: string, documentId: number, digest: string): AssetRow {
  return {
    key,
    documentId,
    mime: mimeForName(f.name),
    name: f.name,
    size: f.size,
    sha256: digest,
    aliases: [],
    uploadedAt: Date.now(),
  };
}

export function createAssetStore({
  find,
  fetchBytes,
  maxBytes = DEFAULT_MAX_BYTES,
  sha256,
  postDocument,
  insertRow,
  updateRow,
  deleteDocument,
  deleteRow,
}: {
  find: () => Promise<any>;
  fetchBytes: (documentId: number) => Promise<Blob>;
  maxBytes?: number;
  sha256?: (buf: ArrayBuffer) => Promise<string>;
  postDocument?: (f: File) => Promise<number>;
  /** Creates a row that does not exist yet, and MUST fail rather than overwrite a taken key. */
  insertRow?: (row: AssetRow) => Promise<void>;
  /** Rewrites a row that already exists, and MUST NOT create one if it is gone. */
  updateRow?: (row: AssetRow) => Promise<void>;
  deleteDocument?: (id: number) => Promise<void>;
  deleteRow?: (key: string) => Promise<void>;
}) {
  let byRef = new Map<string, AssetRow>();
  let rows: AssetRow[] = [];
  let indexError: string | null = null;
  // Distinct from `indexError === null`, which is also the state before anything has been read.
  let indexRead = false;
  let loading: Promise<void> | null = null;
  const cache = new Map<string, Held>();
  // A failed fetch is NOT a cache entry: it carries no bytes and no object URL, so it must
  // never reach `bytes` or `evict` — a separate map is what keeps that true by construction
  // rather than by a scattered `if (held.error)` check at every cache touch-point.
  const failures = new Map<string, Held>();
  const inflight = new Map<string, Promise<Held>>();
  let bytes = 0;
  // A plain counter would not repaint anything: DocView reads `version()` directly during its
  // own render, and it is @preact/signals' auto-tracking of that `.value` read — not the number
  // itself — that turns "an asset finished fetching" into a second paint.
  const versionSignal = signal(0);
  function bumpVersion() {
    versionSignal.value += 1;
  }

  // Ruling 16: what a sync pass just painted is pinned, by row key, REPLACING the previous set
  // wholesale (never merged) — a ref that scrolled out of the live DOM stops being protected on
  // the very next pass. Without this, resolve()'s own evict() call could displace a ref the
  // reader is still looking at, its live <img> would go stale, and the sync effect would
  // re-request it on the next pass, evicting whatever displaced it in turn: an unbounded fetch
  // loop for any single document whose assets add up to more than maxBytes — the ordinary case
  // for a specification that puts every deliverable in one scroller, not an edge one.
  let pinned = new Set<string>();

  // Every WRITE runs on one chain. `upload` reads `byRef` for a free key and writes it back two
  // awaits later, so two overlapping calls both claim the same key and the second row overwrites
  // the first — one document orphaned, both reported as added. `remove` shares the chain because a
  // delete interleaved with upload's alias branch resurrects a row pointing at a deleted document.
  let writes: Promise<unknown> = Promise.resolve();
  function serialize<T>(job: () => Promise<T>): Promise<T> {
    const run = writes.then(job);
    // The chain remembers only that the job SETTLED, never how: a rejection left on `writes` would
    // wedge every later write behind it. The caller still gets it, through `run`.
    writes = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // `keep` is the entry just inserted: without it, an asset larger than the budget evicts ITSELF
  // and the caller receives an already-revoked object URL. An oversized lone asset stays cached.
  // A pinned entry is skipped the same way `keep` is: if the pinned set alone exceeds `maxBytes`,
  // the budget is deliberately exceeded — a document holds what it is currently displaying, and
  // that is bounded by the document's own asset set, not by an arbitrary byte cap. This is a
  // considered trade, not an oversight.
  function evict(keep: string) {
    for (const [ref, held] of cache) {
      if (bytes <= maxBytes) break;
      if (ref === keep || pinned.has(ref)) continue;
      cache.delete(ref);
      bytes -= held.row.size || 0;
      if (held.url) {
        try {
          URL.revokeObjectURL(held.url);
        } catch {
          /* no URL in tests without a stub */
        }
      }
    }
  }

  function lookup(href: string): AssetRow | null {
    // The fallback is NOT redundant: `cleanHref` rejects absolute URLs, but an alias may BE an
    // absolute URL (a reference written before this feature existed), so the raw form must still be
    // looked up. Remove it and every aliased reference silently misses.
    const h =
      cleanHref(href) ||
      String(href ?? '')
        .split('#')[0]
        .split('?')[0];
    return byRef.get(h) || null;
  }

  // One in-flight read per index and per key: `loaded = true` set before the await let a second
  // concurrent load() resolve against an empty index, and an unmemoised resolve() double-fetched,
  // double-counted bytes and leaked the first object URL.
  async function readIndex(): Promise<void> {
    try {
      const res = await find();
      rows = ((res && res.result) || []).map(toRow).filter(Boolean) as AssetRow[];
      byRef = new Map();
      for (const r of rows) {
        byRef.set(r.key, r);
        for (const a of r.aliases) byRef.set(a, r);
      }
      indexError = null;
      indexRead = true;
    } catch (err: any) {
      indexError = message(err);
    }
    bumpVersion();
  }

  // A re-read from INSIDE a job already holding the chain: `readIndex` is called directly, never
  // through `loadIndex`, which would enqueue behind this job and deadlock it permanently.
  async function rereadIndex(): Promise<void> {
    await readIndex();
    // `loadIndex`'s rule, applied to a read it did not start: a FAILED read is never memoised.
    // `loading` still holds the earlier successful attempt, so leaving it there would hand that
    // resolved promise to every later load() — `indexError` would never clear and every upload
    // for the rest of the session would be refused.
    if (indexError) loading = null;
  }

  // `insertRow` cannot overwrite — that is the whole guarantee here, and it is why a stale read is
  // survivable: the write chain orders LOCAL writers only, so another session (a second SA, or
  // this user's second tab) can have taken this key since the read that allocated it, and a
  // memoised successful read means nothing here would ever notice.
  //
  // EVERY failure is treated as "the row was not written", whatever it was: the service's error
  // shape for a taken `_id` is not something this repo has verified, and the recovery is correct
  // either way — re-read, re-allocate against what is now known to be taken, insert once more.
  // Never more than once: a key that collides twice means something other than a race.
  //
  // But a rejection is not evidence the row is absent: `mdh.post` abandons the response after 30s
  // (`REQUEST_TIMEOUT`, src/mdh/api.ts) and a gateway can fail after the commit, neither of them
  // saying what the server did. So the re-read is checked for OUR OWN row before a second key is
  // allocated, and adopted if it is there. `documentId` is server-assigned per POST, so a row under
  // our key naming our document can only be the insert that landed. Re-keying past it would leave
  // one document with two rows, neither carrying the other as an alias — and `remove` cleans up a
  // row plus its aliases, so deleting either would take the shared document and strand the other.
  async function insertNewRow(
    f: File,
    row: AssetRow,
  ): Promise<{ row: AssetRow; adopted: boolean }> {
    try {
      await insertRow!(row);
      return { row, adopted: false };
    } catch (first: any) {
      await rereadIndex();
      if (indexError) {
        throw new Error(
          `${f.name} was uploaded but its index row could not be written (${message(first)}); the index could not be re-read either (${indexError})`,
        );
      }
      // Looked up by DOCUMENT, not by key. `byRef` maps aliases too, so another session that
      // aliased our key onto one of its own rows in this window would shadow ours there — the
      // documentId would not match, we would re-key past our own landed row, and one document would
      // end up with two rows again. `rows` after the re-read is the server's row set, and our
      // documentId came from our own POST moments ago, so only our landed row can carry it.
      const landed = rows.find((r) => r.documentId === row.documentId);
      if (landed) return { row: landed, adopted: true };
      const retry = rowFor(
        f,
        keyForFile(f.name, new Set(byRef.keys())),
        row.documentId,
        row.sha256,
      );
      try {
        await insertRow!(retry);
        return { row: retry, adopted: false };
      } catch (second: any) {
        // The document is left behind with nothing referencing it — wasted storage, invisible,
        // and deliberately not auto-deleted (design §5.2). The panel reports the failure.
        throw new Error(
          `${f.name} was uploaded but its index row could not be written (${message(second)})`,
        );
      }
    }
  }

  async function uploadNow(f: File): Promise<{ row: AssetRow; reused: boolean }> {
    // Before the digest, which is before the bytes are read: hashing 200 MB to then refuse it is
    // waste the user waits through. First of the two refusals, because an oversized file is
    // oversized whatever the index says.
    if (f.size > MAX_UPLOAD_BYTES)
      throw new Error(`over the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit`);
    // No key is allocated against an index that was never read: `taken` would be empty, every name
    // would look free, and the insert below would fail on the first one already published — a
    // document uploaded for no row. Two conditions, because "no error" and "was read" are not the
    // same state. The `!indexRead` half is defence in depth: `readIndex` always returns with at
    // least one of the two set — `indexRead` on success, a NON-EMPTY `indexError` on failure, which
    // is the reason `message` never returns '' — and `upload` always queues behind a completed
    // read, so there is no path through the public surface that reaches here with both falsy.
    //
    // Checked HERE rather than in `upload`, on the chain and at the moment of allocation, so it
    // reflects the read that has just run and not one that was still in flight when the caller
    // asked.
    //
    // The `indexError` half is the REACHABLE one, and it is pinned (asset-upload.test.ts, "refuses
    // the next upload rather than allocating against the stale read"): the boot read succeeds, a
    // later one fails — a Retry, or the re-read after a failed insert — and `indexRead` is never
    // reset, so without this half an upload would allocate a key against an index known to be
    // stale.
    if (!indexRead || indexError) {
      throw new Error(
        `the file index could not be read${indexError ? ` (${indexError})` : ''}; retry it, then upload`,
      );
    }
    const digest = await sha256!(await f.arrayBuffer());
    const taken = new Set(byRef.keys());
    const key = keyForFile(f.name, taken);
    const twin = rows.find((r) => r.sha256 && r.sha256 === digest);

    if (twin) {
      const next: AssetRow = { ...twin, aliases: [...twin.aliases, key] };
      // An UPDATE, not an upsert: `twin` comes from the last read, and the row may have been
      // deleted since. Re-creating it would publish a reference to a document `remove` already
      // deleted — a broken asset for every reader, written deliberately. Local state is mutated
      // only after this resolves, so a refusal leaves nothing behind either.
      await updateRow!(next);
      rows = rows.map((r) => (r.key === next.key ? next : r));
      // EVERY key that reaches this row must be re-pointed, not just the new one: an alias added
      // by an earlier upload would otherwise keep pointing at a superseded row object whose
      // `aliases` array is missing everything added since — and `remove()` trusts that array to
      // clean up, so a stale one leaves live references to a deleted document.
      byRef.set(next.key, next);
      for (const a of next.aliases) byRef.set(a, next);
      bumpVersion();
      return { row: next, reused: true };
    }

    // Document first, row second: the reverse would leave a row pointing at nothing, which a
    // reader sees as a broken asset. A crash between the two leaves a document no row references
    // — wasted storage, invisible, and not auto-deleted (see the spec, §5.2). The collision
    // retry below needs this order too: the row it writes must already have a document to name.
    const documentId = await postDocument!(f);
    const { row, adopted } = await insertNewRow(f, rowFor(f, key, documentId, digest));
    // An ADOPTED row is the one the re-read just put in both of these; appending it again would
    // list the same file twice. `reused` stays false either way: a document was posted for this
    // file, which is what the panel's `added` reports and what `reused` would deny.
    if (!adopted) {
      rows = [...rows, row];
      byRef.set(row.key, row);
    }
    bumpVersion();
    return { row, reused: false };
  }

  async function removeNow(key: string): Promise<void> {
    const row = byRef.get(key);
    if (!row) return;
    // The mirror of the create ordering. Row first: if the second call fails, the leftover is an
    // orphaned document nothing references — invisible, and the failure mode this design already
    // accepts. Document first would leave a row pointing at a deleted document, which is a
    // visibly broken asset for every reader.
    await deleteRow!(row.key);
    await deleteDocument!(row.documentId);
    rows = rows.filter((r) => r.key !== row.key);
    byRef.delete(row.key);
    for (const a of row.aliases) byRef.delete(a);
    const held = cache.get(row.key);
    if (held) {
      cache.delete(row.key);
      bytes -= row.size || 0;
      if (held.url) {
        try {
          URL.revokeObjectURL(held.url);
        } catch {
          /* no URL in tests */
        }
      }
    }
    failures.delete(row.key);
    bumpVersion();
  }

  // A hoisted function, not a method on the returned literal: `upload` needs the same memoised
  // read, and `this` is undefined in these methods once the store is destructured — which is how
  // callers use it.
  function loadIndex(): Promise<void> {
    if (loading) return loading;
    // A FAILED read is not memoised: `loading` is cleared once it settles, so the next load()
    // retries. Otherwise one 401 at boot leaves every asset in the document unresolvable, and
    // the panel showing that error, for the rest of the session. The identity check is what
    // makes clearing safe — a slow failure must not drop a successor a later load() installed.
    // On the WRITE chain, not beside it: a Retry landing mid-upload would otherwise rebuild
    // `rows` from a server response computed BEFORE that upload's row was written, dropping the
    // new asset from the panel for the rest of the session — memoised success means no later
    // read corrects it. The document and the row are safe on the server; only the local view
    // loses them, which is exactly the confusion this chain exists to prevent.
    const settle = () => {
      if (indexError && loading === attempt) loading = null;
    };
    const attempt: Promise<void> = serialize(readIndex).then(settle, (err: any) => {
      // `readIndex` folds the read's own failure into `indexError` and is not expected to reject
      // — but the recovery above must not DEPEND on that. `bumpVersion` notifies subscribers
      // synchronously, so a throwing one rejects the attempt, and a rejected `attempt` left in
      // `loading` would latch: no later load() retries, and nobody awaits load(), so it would
      // surface only as an unhandled rejection. Recording it as an index error keeps both the
      // retry and the upload refusal working whatever happens in there.
      indexError = message(err);
      settle();
    });
    loading = attempt;
    return attempt;
  }

  return {
    load: loadIndex,
    entries(): AssetRow[] {
      return [...rows];
    },
    lookup,
    peek(href: string): Held | null {
      const row = lookup(href);
      if (!row) return null;
      return cache.get(row.key) || failures.get(row.key) || null;
    },
    resolve(href: string): Promise<Held | null> {
      const row = lookup(href);
      if (!row) return Promise.resolve(null);
      const hit = cache.get(row.key);
      if (hit) return Promise.resolve(hit);
      // A cached FAILURE is deliberately not checked here: only `peek` sees it. Short-circuiting
      // on it here would serve the same "unavailable" forever, even after the 401 or the outage
      // that caused it is long gone.
      const pending = inflight.get(row.key);
      if (pending) return pending;
      const p = (async (): Promise<Held> => {
        try {
          const blob = await fetchBytes(row.documentId);
          const url = URL.createObjectURL(blob);
          // The row can be deleted while its bytes are in flight. Caching under a key nothing
          // resolves to any more counts `row.size` against a budget no lookup can ever reach to
          // free, so `bytes` drifts up for the rest of the session and the eviction budget
          // shrinks with it. Liveness is checked by documentId, not by object identity: an
          // alias-reuse upload REPLACES the row object for the same document, and that is not a
          // stale read.
          const live = byRef.get(row.key);
          if (!live || live.documentId !== row.documentId) {
            try {
              URL.revokeObjectURL(url);
            } catch {
              /* no URL in tests without a stub */
            }
            return { row, error: 'deleted while it was loading' };
          }
          const held: Held = { row, url };
          failures.delete(row.key);
          cache.set(row.key, held);
          bytes += row.size || 0;
          evict(row.key);
          bumpVersion();
          return held;
        } catch (err: any) {
          const held: Held = { row, error: message(err) };
          failures.set(row.key, held);
          bumpVersion();
          return held;
        } finally {
          inflight.delete(row.key);
        }
      })();
      inflight.set(row.key, p);
      return p;
    },
    version(): number {
      return versionSignal.value;
    },
    // Called once per sync pass with EVERY ref currently in the live DOM (assetSync.js), whether
    // resolved, failed, or still pending — resolving `href` to its canonical `row.key` is what
    // lets `evict` recognise it regardless of which alias the author happened to write.
    // Unresolvable refs (no row yet) are simply not pinned: there is nothing in `cache` for them
    // to protect.
    pin(hrefs: string[]): void {
      const next = new Set<string>();
      for (const href of hrefs) {
        const row = lookup(href);
        if (row) next.add(row.key);
      }
      pinned = next;
    },
    upload(f: File): Promise<{ row: AssetRow; reused: boolean }> {
      // Ask for the index, then queue BEHIND that read — never `await` it here. `readIndex` runs on
      // this same chain, so a job that awaited it would be waiting for work queued behind itself
      // (a permanent deadlock), and awaiting before the enqueue would hand the queue slot to
      // whatever the caller asked for next: a `remove` issued in the same tick would overtake this
      // upload. Queued, the read is simply the job in front, and `uploadNow` reads its outcome.
      // `loadIndex` cannot reject, so this floating promise cannot become an unhandled rejection.
      void loadIndex();
      return serialize(() => uploadNow(f));
    },

    remove(key: string): Promise<void> {
      return serialize(() => removeNow(key));
    },

    stats() {
      return { bytes, entries: cache.size, indexed: byRef.size, indexError };
    },
  };
}
