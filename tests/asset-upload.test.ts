// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createAssetStore } from '../src/fabry/architect/assets.js';
import type { AssetRow } from '../src/fabry/architect/assets.js';

// What Data Storage holds, before the store maps it: `_id`, not `key`.
type IndexDoc = {
  _id: string;
  kind: string;
  documentId: number;
  mime: string;
  name: string;
  size: number;
  sha256: string;
  aliases: string[];
};

const file = (name: string, text: string) =>
  new File([text], name, { type: 'application/octet-stream' });

const existingDoc = (extra: Partial<IndexDoc> = {}): IndexDoc => ({
  _id: 'assets/diagram.png',
  kind: 'asset',
  documentId: 1234,
  mime: 'image/png',
  name: 'diagram.png',
  size: 1,
  sha256: 'sha-of-a',
  aliases: [],
  ...extra,
});

const docOf = (row: AssetRow): IndexDoc => ({
  _id: row.key,
  kind: 'asset',
  documentId: row.documentId,
  mime: row.mime,
  name: row.name,
  size: row.size,
  sha256: row.sha256,
  aliases: row.aliases,
});

// A fake index with the ONE property the write path rests on: `_id` is unique, so an insert
// against a taken key fails rather than replacing what is there. `server` is handed back so a
// test can write to it directly — that is another session, which this store cannot see and cannot
// order itself against.
function harness(rows: IndexDoc[] = []) {
  const calls = {
    post: [] as string[],
    insert: [] as string[],
    updated: [] as AssetRow[],
    delDoc: [] as number[],
    delRow: [] as string[],
    finds: 0,
    hashed: 0,
  };
  const server = new Map(rows.map((r) => [r._id, r]));
  // Distinct ids, so an overlapping pair of uploads cannot look correct by coincidence.
  let nextId = 4242;
  const store = createAssetStore({
    find: async () => {
      calls.finds += 1;
      return { result: [...server.values()] };
    },
    fetchBytes: async () => new Blob(['x']),
    sha256: async (buf: ArrayBuffer) => {
      calls.hashed += 1;
      return `sha-of-${new TextDecoder().decode(buf)}`;
    },
    postDocument: async (f: File) => {
      calls.post.push(f.name);
      return nextId++;
    },
    insertRow: async (row: AssetRow) => {
      calls.insert.push(row.key);
      if (server.has(row.key)) throw new Error(`E11000 duplicate key: ${row.key}`);
      server.set(row.key, docOf(row));
    },
    updateRow: async (row: AssetRow) => {
      // What `upsert: false` gives the transport: a row that is gone is not re-created.
      if (!server.has(row.key)) throw new Error(`${row.key} is no longer in the index`);
      server.set(row.key, docOf(row));
      calls.updated.push(row);
    },
    deleteDocument: async (id: number) => {
      calls.delDoc.push(id);
    },
    deleteRow: async (key: string) => {
      server.delete(key);
      calls.delRow.push(key);
    },
  });
  return { store, calls, server };
}

describe('write path', () => {
  it('uploads a new file, then writes the row', async () => {
    const { store, calls } = harness();
    await store.load();
    const { row, reused } = await store.upload(file('diagram.png', 'a'));
    expect(reused).toBe(false);
    expect(calls.post).toEqual(['diagram.png']);
    expect(row.key).toBe('assets/diagram.png');
    expect(row.documentId).toBe(4242);
    expect(row.mime).toBe('image/png');
    expect(calls.insert).toEqual(['assets/diagram.png']);
    expect(store.lookup('assets/diagram.png')).toBeTruthy();
  });

  it('reuses the document when the bytes already exist, adding an alias', async () => {
    const { store, calls } = harness([existingDoc()]);
    await store.load();
    const { row, reused } = await store.upload(file('copy.png', 'a'));
    expect(reused).toBe(true);
    expect(calls.post).toEqual([]);
    expect(row.documentId).toBe(1234);
    expect(calls.updated[0].aliases).toContain('assets/copy.png');
    expect(store.lookup('assets/copy.png')!.documentId).toBe(1234);
  });

  it('names a colliding reference rather than overwriting one', async () => {
    const { store } = harness([existingDoc({ sha256: 'sha-of-other' })]);
    await store.load();
    const { row } = await store.upload(file('diagram.png', 'a'));
    expect(row.key).toBe('assets/diagram-2.png');
  });

  it('re-points every alias when the same bytes are uploaded a third time', async () => {
    const { store } = harness([existingDoc()]);
    await store.load();
    await store.upload(file('copy.png', 'a'));
    await store.upload(file('copy2.png', 'a'));
    for (const href of ['assets/diagram.png', 'assets/copy.png', 'assets/copy2.png']) {
      expect(store.lookup(href)!.aliases).toEqual(['assets/copy.png', 'assets/copy2.png']);
    }
  });

  it('removing via an alias leaves no reference to the deleted document', async () => {
    const { store } = harness([existingDoc()]);
    await store.load();
    await store.upload(file('copy.png', 'a'));
    await store.upload(file('copy2.png', 'a'));
    await store.remove('assets/copy.png');
    for (const href of ['assets/diagram.png', 'assets/copy.png', 'assets/copy2.png']) {
      expect(store.lookup(href)).toBe(null);
    }
  });

  it('deletes the row before the document, so a partial failure cannot strand a live row', async () => {
    const order: string[] = [];
    const store = createAssetStore({
      find: async () => ({ result: [existingDoc({ sha256: 's' })] }),
      fetchBytes: async () => new Blob(['x']),
      sha256: async () => 's',
      postDocument: async () => 1,
      insertRow: async () => {},
      updateRow: async () => {},
      deleteRow: async () => {
        order.push('row');
      },
      deleteDocument: async () => {
        order.push('document');
      },
    });
    await store.load();
    await store.remove('assets/diagram.png');
    expect(order).toEqual(['row', 'document']);
  });

  it('removes the row and the document', async () => {
    const { store, calls } = harness([existingDoc({ sha256: 's' })]);
    await store.load();
    await store.remove('assets/diagram.png');
    expect(calls.delDoc).toEqual([1234]);
    expect(calls.delRow).toEqual(['assets/diagram.png']);
    expect(store.lookup('assets/diagram.png')).toBe(null);
  });
});

// Two batches CAN overlap: the panel's drop target and its file input each start their own loop,
// and Task 7 adds a second caller in a different component. Key allocation reads `byRef` two
// awaits before it writes it back, so without a single write chain both files claim the same
// sanitised key, the second row overwrites the first, and one document is orphaned and invisible
// while both files report `added`.
describe('overlapping writes', () => {
  it('gives two files whose names sanitise alike two distinct keys, rows and documents', async () => {
    const { store, calls } = harness();
    await store.load();
    const [first, second] = await Promise.all([
      store.upload(file('Screen Shot.png', 'a')),
      store.upload(file('screen-shot.png', 'b')),
    ]);
    expect(first.row.key).toBe('assets/screen-shot.png');
    expect(second.row.key).toBe('assets/screen-shot-2.png');
    expect(first.row.documentId).not.toBe(second.row.documentId);
    expect(calls.post).toEqual(['Screen Shot.png', 'screen-shot.png']);
    expect(calls.insert).toEqual(['assets/screen-shot.png', 'assets/screen-shot-2.png']);
    expect(store.entries().map((r) => r.key)).toEqual([
      'assets/screen-shot.png',
      'assets/screen-shot-2.png',
    ]);
    expect(store.lookup('assets/screen-shot.png')!.documentId).toBe(first.row.documentId);
  });

  it('hands a rejection to its own caller without wedging the upload behind it', async () => {
    let posts = 0;
    const store = createAssetStore({
      find: async () => ({ result: [] }),
      fetchBytes: async () => new Blob(['x']),
      sha256: async (buf: ArrayBuffer) => `sha-of-${new TextDecoder().decode(buf)}`,
      postDocument: async () => {
        posts += 1;
        if (posts === 1) throw new Error('502');
        return 7;
      },
      insertRow: async () => {},
      updateRow: async () => {},
      deleteDocument: async () => {},
      deleteRow: async () => {},
    });
    await store.load();
    const bad = store.upload(file('one.png', 'a'));
    const good = store.upload(file('two.png', 'b'));
    await expect(bad).rejects.toThrow('502');
    expect((await good).row.key).toBe('assets/two.png');
    expect(store.entries().map((r) => r.key)).toEqual(['assets/two.png']);
  });

  // `remove` shares the chain because the worse outcome is not a wasted key: a delete interleaved
  // with upload's alias branch re-adds both keys AFTER the row is gone, leaving live references to
  // an already-deleted document.
  it('a delete racing an alias-reuse upload cannot resurrect the deleted row', async () => {
    const { store, calls } = harness([existingDoc()]);
    await store.load();
    const up = store.upload(file('copy.png', 'a'));
    const gone = store.remove('assets/diagram.png');
    await Promise.all([up, gone]);
    expect(store.entries()).toEqual([]);
    expect(store.lookup('assets/diagram.png')).toBe(null);
    expect(store.lookup('assets/copy.png')).toBe(null);
    expect(calls.delDoc).toEqual([1234]);
  });

  // The index read is a write to `rows`/`byRef` too, so it shares the chain. A Retry issued while
  // an upload is in flight reads a server state that predates that upload's row; landing after it
  // would replace the local index with a snapshot the new asset is missing from, and a memoised
  // success means nothing ever reads again to correct it.
  it('a retry landing mid-upload cannot drop the uploaded row from the index', async () => {
    const server: IndexDoc[] = [];
    let attempt = 0;
    let release: (() => void) | null = null;
    const store = createAssetStore({
      find: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('503');
        // Snapshotted when the request is ISSUED, resolved later: what a server that computed its
        // answer before the upload committed would return.
        const snapshot = [...server];
        await new Promise<void>((r) => {
          release = r;
        });
        return { result: snapshot };
      },
      fetchBytes: async () => new Blob(['x']),
      sha256: async () => 'sha-of-a',
      postDocument: async () => 9001,
      insertRow: async (row: AssetRow) => {
        server.push({ ...(row as unknown as IndexDoc), _id: row.key, kind: 'asset' });
      },
      deleteDocument: async () => {},
      deleteRow: async () => {},
    });

    await store.load();
    expect(store.stats().indexError).toBe('503');

    const retry = store.load();
    const up = store.upload(file('late.png', 'a'));
    await new Promise((r) => setTimeout(r, 0));
    release!();
    await Promise.all([retry, up]);

    expect(store.stats().indexError).toBe(null);
    expect(store.entries().map((r) => r.key)).toEqual(['assets/late.png']);
    expect(store.lookup('assets/late.png')).not.toBe(null);
  });
});

// R3. The write chain orders LOCAL writers only, so a key allocated against an index that was
// never read is allocated against nothing: every name looks free. The insert would fail on the
// first name that is already published, which costs a document uploaded for no row — so the read
// is checked before anything is posted.
describe('an index that has not been read', () => {
  const failingStore = (find: () => Promise<any>) => {
    const calls = { post: [] as string[], insert: [] as string[] };
    const store = createAssetStore({
      find,
      fetchBytes: async () => new Blob(['x']),
      sha256: async (buf: ArrayBuffer) => `sha-of-${new TextDecoder().decode(buf)}`,
      postDocument: async (f: File) => {
        calls.post.push(f.name);
        return 4242;
      },
      insertRow: async (row: AssetRow) => {
        calls.insert.push(row.key);
      },
      updateRow: async () => {},
      deleteDocument: async () => {},
      deleteRow: async () => {},
    });
    return { store, calls };
  };

  it('refuses the upload rather than allocating a key nothing checked', async () => {
    const { store, calls } = failingStore(async () => {
      throw new Error('401');
    });
    await store.load();
    await expect(store.upload(file('diagram.png', 'a'))).rejects.toThrow(
      /file index could not be read \(401\)/,
    );
    expect(calls.post).toEqual([]);
    expect(calls.insert).toEqual([]);
  });

  // The read runs ON the write chain, so awaiting it from INSIDE a serialized job would wait for
  // work queued behind itself and wedge the store for the session. Queued in front of the upload
  // instead, this passes; awaited from inside the job, it times out.
  it('reads the index itself when nothing has, without deadlocking the chain', async () => {
    const { store, calls } = harness();
    const { row } = await store.upload(file('diagram.png', 'a'));
    expect(row.key).toBe('assets/diagram.png');
    expect(calls.post).toEqual(['diagram.png']);
    expect(store.lookup('assets/diagram.png')).toBeTruthy();
  });

  // The store is DESTRUCTURED by its callers, so the index read `upload` needs cannot be reached
  // through `this` — an earlier round of this file shipped exactly that and it broke here.
  it('still refuses, and still uploads, when destructured off the store', async () => {
    const { store } = harness();
    const { upload, load } = store;
    await load();
    expect((await upload(file('diagram.png', 'a'))).row.key).toBe('assets/diagram.png');
  });

  // The refusal is never for the session: the upload asks for the index itself, so a transient
  // failure costs the user a second click, not the tab.
  it('re-reads after a failed read, and uploads when that one succeeds', async () => {
    let attempt = 0;
    const { store, calls } = failingStore(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('503');
      return { result: [] };
    });
    await store.load();
    expect(store.stats().indexError).toBe('503');
    const { row } = await store.upload(file('one.png', 'a'));
    expect(attempt).toBe(2);
    expect(row.key).toBe('assets/one.png');
    expect(calls.insert).toEqual(['assets/one.png']);
  });

  // T2. A rejection carrying no message at all — `Promise.reject('')`, or a gateway that returns an
  // empty body — is still a failed read, and `indexError` is what everything downstream reads as
  // the flag for that: this guard, and the panel's error banner. So `message()` never returns the
  // empty string. Without that, a read that failed leaves `indexError` reading as "no error" and
  // the refusal cannot say what went wrong.
  it('refuses with a reason when the read fails carrying no message', async () => {
    const { store, calls } = failingStore(() => Promise.reject(''));
    await store.load();
    expect(store.stats().indexError).toBeTruthy();
    await expect(store.upload(file('diagram.png', 'a'))).rejects.toThrow(
      /file index could not be read \(.+\); retry it/,
    );
    expect(calls.post).toEqual([]);
    expect(calls.insert).toEqual([]);
  });
});

// R7's other half: `resolve` treats a row as stale by DOCUMENT, not by object identity. The alias
// branch of an upload replaces the row object for the same document, and dropping a resolve that
// raced it would blank an asset the reader is looking at.
describe('a row replaced while its bytes are in flight', () => {
  it('still caches the bytes when the document behind the key is the same', async () => {
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:asset');
    globalThis.URL.revokeObjectURL = vi.fn();
    let release: (() => void) | null = null;
    const store = createAssetStore({
      find: async () => ({ result: [existingDoc()] }),
      fetchBytes: async () => {
        await new Promise<void>((r) => {
          release = r;
        });
        return new Blob(['x']);
      },
      sha256: async (buf: ArrayBuffer) => `sha-of-${new TextDecoder().decode(buf)}`,
      postDocument: async () => 1,
      insertRow: async () => {},
      updateRow: async () => {},
      deleteDocument: async () => {},
      deleteRow: async () => {},
    });
    await store.load();
    const pending = store.resolve('assets/diagram.png');
    await new Promise((r) => setTimeout(r, 0));
    const { reused } = await store.upload(file('copy.png', 'a'));
    release!();
    const held = await pending;

    expect(reused).toBe(true);
    expect(held!.error).toBeUndefined();
    expect(held!.url).toBe('blob:asset');
    expect(store.peek('assets/diagram.png')).toBe(held);
    expect(globalThis.URL.revokeObjectURL).not.toHaveBeenCalled();
  });
});

// S1. The remaining two-writers-one-key path, and the one a guard cannot close: the boot read
// SUCCEEDS against an index without `assets/diagram.png`, another session then publishes that key,
// and nothing here re-reads because a successful read is memoised by design and an Architect tab is
// long-lived. An upsert would overwrite their row — their document orphaned and invisible, every
// existing reference to the key silently serving this file's bytes. The insert cannot: it fails,
// and the failure is what the recovery is driven off.
describe('a key another session took after the read', () => {
  it('re-reads, re-allocates and inserts, leaving the other session’s row untouched', async () => {
    const { store, calls, server } = harness();
    await store.load();
    server.set('assets/diagram.png', existingDoc({ documentId: 777, sha256: 'sha-of-theirs' }));

    const { row, reused } = await store.upload(file('diagram.png', 'a'));

    expect(reused).toBe(false);
    expect(row.key).toBe('assets/diagram-2.png');
    // Attempted under the key the stale read said was free, then under the next one that is not.
    expect(calls.insert).toEqual(['assets/diagram.png', 'assets/diagram-2.png']);
    expect(calls.finds).toBe(2);
    // Their row, byte for byte as they wrote it.
    expect(server.get('assets/diagram.png')).toMatchObject({ documentId: 777 });
    // And the re-read is a real read: their key now resolves here too, to THEIR document.
    expect(store.lookup('assets/diagram.png')!.documentId).toBe(777);
    expect(store.lookup('assets/diagram-2.png')!.documentId).toBe(row.documentId);
    // One document for one file: the retry re-keys the row it already has, it does not re-upload.
    expect(calls.post).toEqual(['diagram.png']);
  });

  it('reports a second collision rather than retrying forever, and never claims the key', async () => {
    const posted: string[] = [];
    const attempts: string[] = [];
    const store = createAssetStore({
      find: async () => ({ result: [] }),
      fetchBytes: async () => new Blob(['x']),
      sha256: async () => 'sha-of-a',
      postDocument: async (f: File) => {
        posted.push(f.name);
        return 4242;
      },
      // Every insert refused. Whatever the reason, it is never treated as written.
      insertRow: async (row: AssetRow) => {
        attempts.push(row.key);
        throw new Error('E11000 duplicate key');
      },
      updateRow: async () => {},
      deleteDocument: async () => {},
      deleteRow: async () => {},
    });
    await store.load();

    await expect(store.upload(file('diagram.png', 'a'))).rejects.toThrow(
      /diagram\.png was uploaded but its index row could not be written \(E11000 duplicate key\)/,
    );
    expect(attempts).toHaveLength(2);
    // The document is orphaned — accepted by the design (§5.2) and reported, not silently kept.
    expect(posted).toEqual(['diagram.png']);
    // Nothing local claims a key no row was written for.
    expect(store.entries()).toEqual([]);
    expect(store.lookup('assets/diagram.png')).toBe(null);
    expect(store.lookup('assets/diagram-2.png')).toBe(null);
  });

  it('says so when the re-read fails too, and does not latch the index error', async () => {
    let finds = 0;
    const store = createAssetStore({
      find: async () => {
        finds += 1;
        if (finds === 2) throw new Error('401');
        return { result: [] };
      },
      fetchBytes: async () => new Blob(['x']),
      sha256: async () => 'sha-of-a',
      postDocument: async () => 4242,
      insertRow: async () => {
        throw new Error('E11000 duplicate key');
      },
      updateRow: async () => {},
      deleteDocument: async () => {},
      deleteRow: async () => {},
    });
    await store.load();

    await expect(store.upload(file('diagram.png', 'a'))).rejects.toThrow(
      /could not be re-read either \(401\)/,
    );
    expect(store.stats().indexError).toBe('401');
    // The recovery's own read is not memoised when it fails: Retry has to be able to clear it,
    // or every upload for the rest of the session is refused by a read nobody can re-run.
    await store.load();
    expect(finds).toBe(3);
    expect(store.stats().indexError).toBe(null);
  });

  it('never resurrects a row deleted elsewhere just to add an alias to it', async () => {
    const { store, calls, server } = harness([existingDoc()]);
    await store.load();
    server.delete('assets/diagram.png');

    await expect(store.upload(file('copy.png', 'a'))).rejects.toThrow(/no longer in the index/);

    // Not re-created as a row pointing at a document `remove` deleted in the same breath, and not
    // created under the new key either — the alias branch never falls through to an insert.
    expect(server.size).toBe(0);
    expect(calls.insert).toEqual([]);
    expect(calls.post).toEqual([]);
    expect(store.lookup('assets/copy.png')).toBe(null);
  });
});

// T1. A rejected insert does NOT prove the insert did not land. `mdh.post` gives up on the response
// after 30s (`REQUEST_TIMEOUT`, src/mdh/api.ts) and rejects with a message that says nothing about
// what the server did; a gateway 502 after the commit behaves the same. Re-keying past a row that
// IS ours leaves one document with two rows, neither carrying the other as an alias — which defeats
// the whole point of aliases, because `remove` cleans up one row and the aliases on it, so deleting
// either row deletes the shared document and leaves the other resolving to nothing.
describe('an insert that landed and then failed', () => {
  const landedThenFailed = () => {
    const server = new Map<string, IndexDoc>();
    const calls = { post: [] as string[], insert: [] as string[] };
    const store = createAssetStore({
      find: async () => ({ result: [...server.values()] }),
      fetchBytes: async () => new Blob(['x']),
      sha256: async (buf: ArrayBuffer) => `sha-of-${new TextDecoder().decode(buf)}`,
      postDocument: async (f: File) => {
        calls.post.push(f.name);
        return 4242;
      },
      insertRow: async (row: AssetRow) => {
        calls.insert.push(row.key);
        if (server.has(row.key)) throw new Error(`E11000 duplicate key: ${row.key}`);
        server.set(row.key, docOf(row));
        // Committed server-side, then the client stopped waiting for the answer.
        if (calls.insert.length === 1) throw new Error('Request timed out after 30s');
      },
      updateRow: async () => {},
      deleteDocument: async () => {},
      deleteRow: async (key: string) => {
        server.delete(key);
      },
    });
    return { store, calls, server };
  };

  it('adopts its own row rather than allocating a second key for one document', async () => {
    const { store, calls, server } = landedThenFailed();
    await store.load();

    const { row, reused } = await store.upload(file('diagram.png', 'a'));

    // Newly added, not de-duplicated onto someone else's bytes: a document WAS posted for it.
    expect(reused).toBe(false);
    // The key the caller is told about is the key that exists.
    expect(row.key).toBe('assets/diagram.png');
    expect(row.documentId).toBe(4242);
    // One attempt, one document, ONE row.
    expect(calls.insert).toEqual(['assets/diagram.png']);
    expect(calls.post).toEqual(['diagram.png']);
    expect([...server.keys()]).toEqual(['assets/diagram.png']);
    // And listed once, not twice: the adopted row came from the re-read, which already holds it.
    expect(store.entries().map((r) => r.key)).toEqual(['assets/diagram.png']);
    expect(store.lookup('assets/diagram.png')!.documentId).toBe(4242);
  });

  // The adoption must be looked up by DOCUMENT, not by key. `byRef` maps aliases as well as keys, so
  // another session taking the sha256-twin branch in this window can alias OUR key onto one of its
  // own rows — its index read predates our insert, so our key still looked free to it. Sorted by
  // `_id` ascending (what `findAssetRows` sends), a shadow row sorting AFTER ours wins the
  // `byRef.set` race, and a key-based lookup then re-keys straight past our own landed row.
  it('adopts its own row even when another session has aliased our key onto theirs', async () => {
    const server = new Map<string, IndexDoc>();
    const calls = { post: [] as string[], insert: [] as string[] };
    const store = createAssetStore({
      // Ascending `_id`, mirroring the real transport: 'assets/diagram.png' < 'assets/logo.png'.
      find: async () => ({
        result: [...server.values()].sort((a, b) => a._id.localeCompare(b._id)),
      }),
      fetchBytes: async () => new Blob(['x']),
      sha256: async (buf: ArrayBuffer) => `sha-of-${new TextDecoder().decode(buf)}`,
      postDocument: async (f: File) => {
        calls.post.push(f.name);
        return 4242;
      },
      insertRow: async (row: AssetRow) => {
        calls.insert.push(row.key);
        if (server.has(row.key)) throw new Error(`E11000 duplicate key: ${row.key}`);
        server.set(row.key, docOf(row));
        if (calls.insert.length === 1) {
          // Our row committed. Before we can re-read, the other session aliases our key onto its
          // own row — whose `_id` sorts after ours, so it overwrites us in `byRef`.
          server.set('assets/logo.png', {
            _id: 'assets/logo.png',
            kind: 'asset',
            documentId: 555,
            mime: 'image/png',
            name: 'logo.png',
            size: 1,
            sha256: 'sha-of-elsewhere',
            aliases: ['assets/diagram.png'],
          });
          throw new Error('Request timed out after 30s');
        }
      },
      updateRow: async () => {},
      deleteDocument: async () => {},
      deleteRow: async (key: string) => {
        server.delete(key);
      },
    });
    await store.load();

    const { row, reused } = await store.upload(file('diagram.png', 'a'));

    expect(reused).toBe(false);
    expect(row.documentId).toBe(4242);
    expect(row.key).toBe('assets/diagram.png');
    // One attempt, and no second key for document 4242 — the whole point.
    expect(calls.insert).toEqual(['assets/diagram.png']);
    expect(
      store
        .entries()
        .filter((r) => r.documentId === 4242)
        .map((r) => r.key),
    ).toEqual(['assets/diagram.png']);
    // The other session's row is untouched, aliases and all.
    expect(server.get('assets/logo.png')!.aliases).toEqual(['assets/diagram.png']);
  });

  it('leaves nothing behind when the file it reported is then deleted', async () => {
    const { store, server } = landedThenFailed();
    await store.load();

    const { row } = await store.upload(file('diagram.png', 'a'));
    await store.remove(row.key);

    // The harm two rows for one document would do: deleting the reported one takes the shared
    // document with it and strands the other, and every reference to it renders as unpublished.
    expect([...server.keys()]).toEqual([]);
    expect(store.entries()).toEqual([]);
    expect(store.lookup('assets/diagram.png')).toBe(null);
  });
});

// The documented per-document ceiling (design §3, "Deletion is clean"). It moved out of the panel
// and into the store in Task 7, so the editor's paste path inherits it too — a caller that forgot
// would turn a named refusal into an opaque API error.
describe('a file over the ceiling', () => {
  it('is refused before it is hashed and before anything is posted', async () => {
    const { store, calls } = harness();
    await store.load();
    const big = file('huge.xlsx', 'x');
    Object.defineProperty(big, 'size', { value: 41 * 1024 * 1024 });
    await expect(store.upload(big)).rejects.toThrow('over the 40 MB limit');
    // Hashing 200 MB to then refuse it is waste the user waits through.
    expect(calls.hashed).toBe(0);
    expect(calls.post).toEqual([]);
    expect(calls.insert).toEqual([]);
  });

  // The refusal does not depend on the index, so it must not be hidden behind an index failure.
  it('is refused with the size, not with an index error, when the index is unreadable too', async () => {
    const failing = createAssetStore({
      find: async () => {
        throw new Error('401');
      },
      fetchBytes: async () => new Blob(['x']),
      sha256: async () => 'sha',
      postDocument: async () => 1,
      insertRow: async () => {},
      updateRow: async () => {},
      deleteDocument: async () => {},
      deleteRow: async () => {},
    });
    await failing.load();
    const big = file('huge.xlsx', 'x');
    Object.defineProperty(big, 'size', { value: 41 * 1024 * 1024 });
    await expect(failing.upload(big)).rejects.toThrow('over the 40 MB limit');
  });
});

// The REACHABLE half of `uploadNow`'s two-part guard, which nothing pinned before (carried from the
// Task 6 round-4 review, verified pre-existing rather than a regression). `indexRead` is set by the
// boot read and never reset, so with only the `!indexRead` half a later failed read — a Retry, or
// the re-read after a failed insert — would leave an upload allocating a key against an index the
// store already knows is stale.
describe('an index that was read once and then went bad', () => {
  it('refuses the next upload rather than allocating against the stale read', async () => {
    let readable = true;
    const calls = { post: [] as string[], insert: [] as string[] };
    const store = createAssetStore({
      find: async () => {
        if (!readable) throw new Error('session expired');
        return { result: [] };
      },
      fetchBytes: async () => new Blob(['x']),
      sha256: async () => 'sha',
      postDocument: async (f: File) => {
        calls.post.push(f.name);
        return 4242;
      },
      insertRow: async (row: AssetRow) => {
        calls.insert.push(row.key);
        throw new Error('the row write failed');
      },
      updateRow: async () => {},
      deleteDocument: async () => {},
      deleteRow: async () => {},
    });
    // A boot read that SUCCEEDS: `indexRead` is now true for the rest of the session.
    await store.load();
    expect(store.stats().indexError).toBe(null);

    readable = false;
    // The insert fails, so the store re-reads to find out whether its row landed — and that read
    // fails. This is the moment `indexError` is set while `indexRead` is still true.
    await expect(store.upload(file('one.png', 'a'))).rejects.toThrow(/could not be re-read/);
    expect(store.stats().indexError).toBe('session expired');

    await expect(store.upload(file('two.png', 'b'))).rejects.toThrow(
      /the file index could not be read \(session expired\)/,
    );
    // Nothing was posted for the second file: the refusal came before the document.
    expect(calls.post).toEqual(['one.png']);
  });
});
