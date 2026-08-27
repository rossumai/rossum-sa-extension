// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ASSET_COLLECTION } from '../src/fabry/architect/collectionNames.js';

// The live wiring, with one `fetch` standing in for both services. Data Storage lives under
// /svc/data-storage (Bearer, init'd by the console shell — here, by `fresh()`), the bytes under
// the core API (Token), which is what makes the two halves distinguishable in `calls` below.
const DOMAIN = 'https://example.test';

// A macro-enabled workbook: the case where the API's own mime cannot be trusted (design D7).
const ROW = {
  _id: 'assets/quarter-book.xlsm',
  kind: 'asset',
  documentId: 1234,
  mime: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  name: 'quarter-book.xlsm',
  size: 2048,
  sha256: 'whatever',
  aliases: [],
  uploadedAt: 1,
};

// Bytes and their real digest, so a test can put the SAME file in the index and on disk without
// hashing anything at run time. `node -e "crypto.createHash('sha256').update('same bytes')…"`.
const BYTES = 'same bytes';
const BYTES_SHA256 = '58100dc8fc06562ce3e578231dc948e083520ee49c4b4ee5a5a28bb4b4003feb';

type Call = { url: string; init: any };
let calls: Call[] = [];
let objectUrls: Blob[] = [];

function ds(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => null },
    json: async () => body,
  };
}

function fakeFetch(url: string, init: any = {}) {
  calls.push({ url: String(url), init });
  const u = String(url);
  if (u.includes('/svc/data-storage/api/v1/data/find')) {
    return Promise.resolve(ds({ result: [ROW] }));
  }
  if (u.includes('/svc/data-storage')) return Promise.resolve(ds({ ok: true }));
  if (u.endsWith('/api/v1/documents') && init.method === 'POST') {
    return Promise.resolve(ds({ id: 4242, annotations: [] }));
  }
  if (u.endsWith('/content')) {
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      // The lie this test exists for: untouched macro-enabled bytes, served as the plain
      // spreadsheet mime.
      headers: {
        get: () => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });
  }
  if (init.method === 'DELETE') {
    return Promise.resolve({ ok: true, status: 204, statusText: 'No Content' });
  }
  return Promise.resolve({ ok: false, status: 404, statusText: 'Not Found' });
}

// A FRESH module graph per test: `ensureAssetCollection` memoises its create for the lifetime of
// the module (one store per session in production), so order-independent tests need a new one.
// mdh/api.js is re-init'd on the fresh copy, standing in for the console shell.
async function fresh() {
  vi.resetModules();
  const [mdh, fstore, api] = await Promise.all([
    import('../src/mdh/api.js'),
    import('../src/fabry/store.js'),
    import('../src/fabry/architect/assetApi.js'),
  ]);
  mdh.init(DOMAIN, 'ds-token');
  fstore.domain.value = DOMAIN;
  fstore.token.value = 'core-token';
  return api;
}

const at = (fragment: string) => calls.filter((c) => c.url.includes(fragment));
const bodyOf = (c: Call) => JSON.parse(c.init.body);

beforeEach(() => {
  calls = [];
  objectUrls = [];
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b: any) => {
    objectUrls.push(b);
    return 'blob:asset-' + objectUrls.length;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the architect asset transport', () => {
  it('reads the whole index out of its own hidden collection', async () => {
    const store = (await fresh()).createArchitectAssetStore();
    await store.load();
    const find = at('/data/find')[0];
    expect(bodyOf(find).collectionName).toBe(ASSET_COLLECTION);
    expect(bodyOf(find).query).toEqual({ kind: 'asset' });
    // mdh.find defaults to 30, and one explicit limit only moves the truncation further out, so
    // the read is paged: the first page carries no cursor, and a short page ends it.
    expect(bodyOf(find).limit).toBe(1000);
    // Never stepped over: the cursor is the `_id` the next page resumes after, and `skip` stays at
    // the default nobody sets.
    expect(bodyOf(find).skip).toBe(0);
    expect(at('/data/find')).toHaveLength(1);
    expect(bodyOf(find).sort).toEqual({ _id: 1 });
    expect(find.init.headers.Authorization).toBe('Bearer ds-token');
    expect(store.entries().map((r) => r.key)).toEqual(['assets/quarter-book.xlsm']);
  });

  // S2: the second page asks for what comes AFTER the last key it saw, not for how many rows to
  // step over — a `skip` counts rows a concurrent delete can remove. Asserted on every page a real
  // multi-page read issues, since on the first page alone neither the sort nor the cursor shows.
  it('pages by the last _id seen, carrying the sort the cursor advances along', async () => {
    const api = await fresh();
    (globalThis.fetch as any).mockImplementation((url: string, init: any) => {
      calls.push({ url: String(url), init });
      if (!String(url).includes('/data/find')) return Promise.resolve(ds({ ok: true }));
      const { query, limit } = JSON.parse(init.body);
      // Keys are zero-padded so lexical order — the order `$gt` compares in — is the numeric one.
      const after = query._id ? Number(String(query._id.$gt).slice(-8, -4)) + 1 : 0;
      const rows = Array.from({ length: after ? 2 : limit }, (_, i) => ({
        ...ROW,
        _id: `assets/f-${String(after + i).padStart(4, '0')}.png`,
      }));
      return Promise.resolve(ds({ result: rows }));
    });
    const store = api.createArchitectAssetStore();
    await store.load();
    const finds = at('/data/find');
    expect(finds).toHaveLength(2);
    expect(finds.map((c) => bodyOf(c).query)).toEqual([
      { kind: 'asset' },
      { kind: 'asset', _id: { $gt: 'assets/f-0999.png' } },
    ]);
    expect(finds.map((c) => bodyOf(c).sort)).toEqual([{ _id: 1 }, { _id: 1 }]);
    expect(store.entries()).toHaveLength(1002);
  });

  // D7. The bytes are byte-identical either way; what would break is the browser handing the
  // reader a file whose type contradicts its name. (Blob lowercases a mime; it is case-insensitive.)
  it('tags the bytes with the INDEX row’s mime, never the one the API reports', async () => {
    const store = (await fresh()).createArchitectAssetStore();
    await store.load();
    const held = await store.resolve('assets/quarter-book.xlsm');
    expect(held!.url).toBe('blob:asset-1');
    expect(at('/documents/1234/content')[0].init.headers.Authorization).toBe('Token core-token');
    expect(objectUrls).toHaveLength(1);
    expect(objectUrls[0].type).toBe(ROW.mime.toLowerCase());
  });

  it('uploads bytes to no queue at all, then writes the row', async () => {
    const store = (await fresh()).createArchitectAssetStore();
    await store.load();
    const { row, reused } = await store.upload(
      new File(['fresh bytes'], 'diagram.png', { type: 'image/png' }),
    );
    expect(reused).toBe(false);
    expect(row.documentId).toBe(4242);
    expect(row.key).toBe('assets/diagram.png');

    const post = at('/api/v1/documents').filter((c) => c.init.method === 'POST');
    expect(post).toHaveLength(1);
    expect(post[0].url).toBe(`${DOMAIN}/api/v1/documents`);
    expect(post[0].init.headers.Authorization).toBe('Token core-token');
    // No `queue`: the document belongs to no queue and no annotation, so nothing extracts it, no
    // hook fires and no automation statistic is created.
    expect([...(post[0].init.body as FormData).keys()]).toEqual(['content']);

    // S1: an INSERT, and nothing else. `_id` is uniquely indexed, so this is the one write that
    // cannot overwrite a row another session put there since the read that allocated the key.
    expect(at('/data/replace_one')).toHaveLength(0);
    const written = bodyOf(at('/data/insert_one')[0]);
    expect(written.collectionName).toBe(ASSET_COLLECTION);
    expect(written.document).toMatchObject({
      _id: 'assets/diagram.png',
      kind: 'asset',
      documentId: 4242,
      mime: 'image/png',
      name: 'diagram.png',
    });
    // A real digest, computed before the upload — that is what makes D9's reuse possible.
    expect(written.document.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  // The other half of S1. Adding an alias to a row that already exists is an UPDATE, and it must
  // not create the row: it may have been deleted since the read that found it, and re-creating it
  // would publish a reference to a document `remove` deleted in the same breath.
  it('adds an alias with a non-upserting replace, and reports a row that is gone', async () => {
    // The real SHA-256 of the file below, so the upload takes D9's alias branch rather than
    // posting a second copy of bytes the index already has.
    const TWIN = { ...ROW, sha256: BYTES_SHA256 };
    let matched = 1;
    (globalThis.fetch as any).mockImplementation((url: string, init: any) => {
      calls.push({ url: String(url), init });
      const u = String(url);
      if (u.includes('/data/find')) return Promise.resolve(ds({ result: [TWIN] }));
      if (u.includes('/data/replace_one')) return Promise.resolve(ds({ matchedCount: matched }));
      return Promise.resolve(ds({ ok: true }));
    });
    const store = (await fresh()).createArchitectAssetStore();
    await store.load();
    const twin = (name: string) => store.upload(new File([BYTES], name));

    const { reused } = await twin('copy.xlsm');
    expect(reused).toBe(true);
    const replace = bodyOf(at('/data/replace_one')[0]);
    expect(replace.options).toEqual({ upsert: false });
    expect(replace.filter).toEqual({ _id: ROW._id });
    expect(replace.replacement.aliases).toEqual(['assets/copy.xlsm']);
    // Nothing was posted, and no row was inserted to stand in for the one being updated.
    expect(at('/data/insert_one')).toHaveLength(0);
    expect(at('/api/v1/documents').filter((c) => c.init.method === 'POST')).toHaveLength(0);

    // Now the row is gone. `upsert: false` is what stops it coming back; the count is only what
    // makes that silence reportable, and it is trusted solely because the service sent one.
    matched = 0;
    await expect(twin('other-copy.xlsm')).rejects.toThrow(/no longer in the index/);
    expect(at('/data/insert_one')).toHaveLength(0);
  });

  it('makes sure the collection exists before the first write, and only once', async () => {
    const store = (await fresh()).createArchitectAssetStore();
    await store.load();
    expect(at('/collections/create')).toHaveLength(0);
    await store.upload(new File(['a'], 'one.png', { type: 'image/png' }));
    await store.upload(new File(['b'], 'two.png', { type: 'image/png' }));
    expect(at('/collections/create')).toHaveLength(1);
    expect(bodyOf(at('/collections/create')[0]).collectionName).toBe(ASSET_COLLECTION);
  });

  it('deletes the row before the document, so a partial failure cannot strand a live row', async () => {
    const store = (await fresh()).createArchitectAssetStore();
    await store.load();
    await store.remove('assets/quarter-book.xlsm');
    const order = calls
      .map((c) =>
        c.url.includes('/data/delete_one') ? 'row' : c.init.method === 'DELETE' ? 'doc' : '',
      )
      .filter(Boolean);
    expect(order).toEqual(['row', 'doc']);
    expect(bodyOf(at('/data/delete_one')[0]).filter).toEqual({ _id: 'assets/quarter-book.xlsm' });
    expect(at(`${DOMAIN}/api/v1/documents/1234`)).toHaveLength(1);
    expect(store.lookup('assets/quarter-book.xlsm')).toBe(null);
  });

  it('surfaces a failed fetch as an unavailable asset rather than throwing', async () => {
    const store = (await fresh()).createArchitectAssetStore();
    await store.load();
    (globalThis.fetch as any).mockImplementation((url: string, init: any) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/data/find')) return Promise.resolve(ds({ result: [ROW] }));
      return Promise.resolve({ ok: false, status: 401, statusText: 'Unauthorized' });
    });
    const held = await store.resolve('assets/quarter-book.xlsm');
    expect(held!.url).toBeUndefined();
    expect(held!.error).toMatch(/401/);
  });
});

// F3: `limit: 1000` with no paging at all was a silent truncation, and a truncated index renders
// an asset that exists as a broken reference with no explanation anywhere. S2: paging by `skip` is
// a quieter version of the same loss — the count it steps over is not stable under a delete.
describe('readAllPages', () => {
  // Zero-padded, so lexical order — the order `$gt` compares in — is numeric order.
  const key = (n: number) => `assets/f-${String(n).padStart(4, '0')}.png`;
  const collection = (n: number) => Array.from({ length: n }, (_, i) => ({ _id: key(i) }));
  const reader = (rows: { _id: string }[]) =>
    vi.fn(async (after: string | null, limit: number) => ({
      result: rows.filter((r) => !after || r._id > after).slice(0, limit),
    }));

  it('reads page after page until a short one comes back, resuming after the last key', async () => {
    const api = await fresh();
    const find = reader(collection(2003));
    const { result } = await api.readAllPages(find);
    expect(find.mock.calls.map((c) => c[0])).toEqual([null, key(999), key(1999)]);
    expect(result).toHaveLength(2003);
    expect(result[0]._id).toBe(key(0));
    expect(result[2002]._id).toBe(key(2002));
  });

  // The scenario `sort: { _id: 1 }` alone did not close. At `skip: 1000`, page 2 would begin at
  // what is NOW sorted position 1000 — the row that was at 1001 — so key(1000) is never returned,
  // silently and for the life of the memoised read. A cursor names a row, so it cannot shift.
  it('loses nothing when a row behind the cursor is deleted between pages', async () => {
    const api = await fresh();
    const rows = collection(2003);
    const find = vi.fn(async (after: string | null, limit: number) => {
      // The concurrent delete: sorted position 3, already returned and well behind the cursor.
      if (after) rows.splice(3, 1);
      return { result: rows.filter((r) => !after || r._id > after).slice(0, limit) };
    });
    const { result } = await api.readAllPages(find);
    const ids = result.map((r) => r._id);
    expect(ids).toContain(key(1000)); // the row a `skip` would have stepped straight over
    expect(new Set(ids).size).toBe(ids.length); // and none returned twice
    expect(result).toHaveLength(2003);
  });

  it('refuses to page forever, and says so rather than truncating in silence', async () => {
    const api = await fresh();
    let n = 0;
    const find = vi.fn(async (_after: string | null, limit: number) => ({
      result: Array.from({ length: limit }, () => ({ _id: key(n++) })),
    }));
    await expect(api.readAllPages(find)).rejects.toThrow(/larger than 20000 rows/);
    expect(find).toHaveBeenCalledTimes(20);
  });

  // Without an `_id` there is nothing to resume from, and `$gt: ''` would hand back the same page
  // MAX_PAGES times over, every row on it duplicated.
  it('stops rather than re-reading one page forever when a row has no _id', async () => {
    const api = await fresh();
    const find = vi.fn(async (after: string | null, limit: number) => ({
      result: Array.from({ length: after ? 0 : limit }, () => ({})),
    }));
    await expect(api.readAllPages(find)).rejects.toThrow(/no _id/);
    expect(find).toHaveBeenCalledOnce();
  });
});

describe('downloadAsset', () => {
  it('hands the browser the bytes under the file’s own name', async () => {
    const clicks: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: any) {
      clicks.push(this);
    });
    const api = await fresh();
    const store = api.createArchitectAssetStore();
    await store.load();
    expect(await api.downloadAsset(store, 'assets/quarter-book.xlsm')).toBe(null);
    expect(clicks).toHaveLength(1);
    expect(clicks[0].download).toBe('quarter-book.xlsm');
    expect(clicks[0].getAttribute('href')).toBe('blob:asset-1');
    // The object URL belongs to the store's cache: it is NOT revoked here, or the same asset
    // would blank wherever the document paints it.
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it('reports a reference that resolves to nothing instead of downloading an empty file', async () => {
    const api = await fresh();
    const store = api.createArchitectAssetStore();
    await store.load();
    expect(await api.downloadAsset(store, 'assets/never-uploaded.png')).toMatch(/not published/);
  });

  it('reports the reason when the bytes cannot be fetched', async () => {
    const api = await fresh();
    const store = api.createArchitectAssetStore();
    await store.load();
    (globalThis.fetch as any).mockImplementation(() =>
      Promise.resolve({ ok: false, status: 403, statusText: 'Forbidden' }),
    );
    expect(await api.downloadAsset(store, 'assets/quarter-book.xlsm')).toMatch(
      /quarter-book\.xlsm.*403/,
    );
  });
});
