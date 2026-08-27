# Architect Assets — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Architect its own files — uploaded from the pane, stored in the organization as annotation-free documents, resolved at render so an image appears and a file link downloads.

**Architecture:** Bytes live as Rossum documents created with no `queue`; one row per file in a hidden `_SA_EXTENSION__fabry_architect_assets` collection maps the reference an author writes to a document id. A pure key module, a store with an injected transport, a resolution pass inside `renderDocument`, and a fifth tab in the inspector rail.

**Tech Stack:** TypeScript (strict), Preact + `@preact/signals`, markdown-it, CodeMirror 6, vitest + jsdom.

**Spec:** `docs/superpowers/specs/2026-08-24-architect-assets-design.md`

## Global Constraints

- **Every example is synthetic.** No customer names, file names, collection names or document ids in code, tests, comments or commit messages — this repo is published. Use `assets/diagram.png`, `assets/sample.csv`, document id `1234`.
- **New source is TypeScript.** `17d527d` and `4641a6e` typed every module and component; `05b0185` put every bundle in strict mode. A plain-JS module will fail `npx tsc --noEmit`.
- **Imports inside `src/` carry `.js` / `.jsx` extensions even though the files are `.ts` / `.tsx`.** `InspectorRail.tsx` imports `'../store.js'` and `'./CheckPanel.jsx'`. Getting this wrong breaks the bundler.
- **Tests live in `tests/*.test.ts`.** `vitest.config.mjs` includes `tests/**/*.test.ts` only — plain JS importing the TypeScript modules. Do not change that pattern; there are no `.test.ts` files.
- **Auth header is `Authorization: Token <token>`** — the convention in `src/docs/resources.ts`. (`Bearer` is also accepted by the API and is what the feasibility test used, but do not diverge from the codebase.)
- **Credentials come from the Fabry store signals** `fstore.domain.value` and `fstore.token.value` (`src/fabry/store.ts`, imported as `'../../store.js'`). Data Storage goes through `src/mdh/api.ts`, which is already `init`'d by the host panel — never re-init it.
- **The collection name lives only in `collectionNames.ts`.** That module's comment explains why two literals must never disagree.
- **Never trust a document's `mime_type`.** A macro-enabled workbook is normalised to the plain spreadsheet mime; the index row's `mime` wins.
- **The panel mounts unkeyed.** Every other rail panel is `key={d.id}`; an org-wide list must not be, or scrolling remounts and refetches it.
- **CSS goes in `src/console/console.css`** using the existing tokens (`--bg-card`, `--text-secondary`, `--accent`, the `-bg`/`-fg` tint pairs) and the `fabry-arch-asset-` class prefix.
- **The working tree has in-flight MDH export/import work** (`columnDiscovery.ts`, `flatten.ts`, `ExportWizard.tsx`). Branch or stash to taste; do not revert it.
- **Verify with** `npx vitest run`, `npx tsc --noEmit`, `node build.js`.
- **DO NOT COMMIT ANYTHING** (owner instruction, 2026-08-25). No `git commit`, no `git add`, no branches, no stashes. All work stays as uncommitted changes on top of the latest `master`, for the owner to review and commit. Each task therefore ends by *reporting* which files it changed, leaving them in the working tree.
- **`tests/dead-code.test.ts` fails from Task 1 until the panel is wired in Task 6** — it asserts every file under `src/` is reachable from a build entry point, and a leaf module lands before its consumer. For Tasks 1–5 the required end state is therefore: **exactly one failing test, `tests/dead-code.test.ts`, and the orphan list it prints contains only files this feature adds.** Any second failing test, or an orphan this feature did not add, is a real failure. **Task 6 must leave it green** — if it does not, the feature is genuinely shipping unreachable code. Do **not** add entries to `UNCONSUMED_EXPORTS_ALLOWLIST`: that list's own comment says an entry is "a decision, not a snooze button", and a module awaiting its consumer is not such a decision.

---

### Task 1: Keys and classification (pure)

**Files:**
- Create: `src/fabry/architect/assetKeys.ts`
- Create: `tests/asset-keys.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `keyForFile(name: string, taken: Set<string>) -> string`, `isImageMime(mime: string) -> boolean`, `mimeForName(name: string) -> string`, `cleanHref(href: string) -> string`, `assetRefsIn(text: string) -> string[]`.
- **Note (controller ruling):** `assetRefsIn` is added here so Tasks 6 and 8 both import it instead of each writing its own link regex. It returns every `[…](href)` and `![…](href)` target in document order, skipping fenced code blocks.

- [ ] **Step 1: Write the failing test**

```js
import { describe, expect, it } from 'vitest';
import { assetRefsIn, cleanHref, isImageMime, keyForFile, mimeForName } from '../src/fabry/architect/assetKeys.js';

describe('keyForFile', () => {
  it('derives a reference from a filename', () => {
    expect(keyForFile('diagram.png', new Set())).toBe('assets/diagram.png');
  });

  it('suffixes a collision the way deliverable slugs do', () => {
    const taken = new Set(['assets/diagram.png', 'assets/diagram-2.png']);
    expect(keyForFile('diagram.png', taken)).toBe('assets/diagram-3.png');
  });

  it('normalises a name that would be awkward in a reference', () => {
    expect(keyForFile('Screen Shot 2026.png', new Set())).toBe('assets/screen-shot-2026.png');
  });
});

describe('mimeForName', () => {
  it('reads the extension, never the server', () => {
    expect(mimeForName('a.xlsm')).toBe('application/vnd.ms-excel.sheet.macroEnabled.12');
    expect(mimeForName('a.eml')).toBe('message/rfc822');
    expect(mimeForName('a.csv')).toBe('text/csv');
    expect(mimeForName('a.unknown')).toBe('application/octet-stream');
  });
});

describe('cleanHref and isImageMime', () => {
  it('strips a fragment or query before lookup', () => {
    expect(cleanHref('assets/diagram.png#top')).toBe('assets/diagram.png');
    expect(cleanHref('assets/diagram.png?v=2')).toBe('assets/diagram.png');
  });

  it('rejects anything that cannot be an asset reference', () => {
    expect(cleanHref('#section')).toBe('');
    expect(cleanHref('/api/v1/hooks/1')).toBe('');
    expect(cleanHref('https://example.test/a.png')).toBe('');
  });

  it('knows an image from a file', () => {
    expect(isImageMime('image/png')).toBe(true);
    expect(isImageMime('text/csv')).toBe(false);
  });
});

describe('assetRefsIn', () => {
  it('returns every reference in document order, skipping fenced examples', () => {
    const text = [
      '![shot](assets/diagram.png) and [f](assets/sample.csv)',
      '```',
      '[not a link](assets/fenced.txt)',
      '```',
      '[ext](https://example.test/x) [anchor](#s)',
    ].join('\n');
    expect(assetRefsIn(text)).toEqual([
      'assets/diagram.png',
      'assets/sample.csv',
      'https://example.test/x',
      '#s',
    ]);
  });

  it('returns an empty list for empty or fence-only text', () => {
    expect(assetRefsIn('')).toEqual([]);
    expect(assetRefsIn('```\n[a](b)\n```')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/asset-keys.test.ts`
Expected: FAIL — cannot resolve `../src/fabry/architect/assetKeys.js`

- [ ] **Step 3: Write minimal implementation**

```ts
// Reference strings for uploaded files, and the mime they are served as.
//
// The reference an author writes IS the index key, so nothing derives a path and nothing can drift.
// Mime comes from the extension because the API normalises a macro-enabled workbook to the plain
// spreadsheet mime even though the bytes are untouched — trusting the stored value would hand a
// browser a type that contradicts the filename.
const PREFIX = 'assets/';

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  md: 'text/markdown',
  html: 'text/html',
  eml: 'message/rfc822',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function mimeForName(name: string): string {
  return MIME[extOf(name)] || 'application/octet-stream';
}

export function isImageMime(mime: string): boolean {
  return /^image\//i.test(String(mime || ''));
}

export function cleanHref(href: string): string {
  const h = String(href ?? '').split('#')[0].split('?')[0].trim();
  if (!h || h.startsWith('#') || h.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith('//')) return '';
  return h;
}

// Every reference a deliverable makes, in document order. Callers filter with `lookup`, so this
// deliberately returns external and anchor hrefs too. A fence is skipped because a fenced example OF
// the syntax must not be mistaken for a reference — the lesson docWarnings' own test depends on.
const LINK = /!?\[[^\]]*\]\(([^)\s]+)\)/g;
const FENCE = /^\s*```/;

export function assetRefsIn(text: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of String(text ?? '').split('\n')) {
    if (FENCE.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    for (const m of line.matchAll(LINK)) out.push(m[1]);
  }
  return out;
}

export function keyForFile(name: string, taken: Set<string>): string {
  const ext = extOf(name);
  const stem = (ext ? name.slice(0, -(ext.length + 1)) : name)
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '') || 'file';
  const tail = ext ? `.${ext}` : '';
  let key = `${PREFIX}${stem}${tail}`;
  let n = 2;
  while (taken.has(key)) key = `${PREFIX}${stem}-${n++}${tail}`;
  return key;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/asset-keys.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/fabry/architect/assetKeys.ts tests/asset-keys.test.ts
git commit -m "feat: derive an asset reference and its mime from a filename"
```

---

### Task 2: The store, read path

**Files:**
- Create: `src/fabry/architect/assets.ts`
- Create: `tests/asset-store.test.ts`
- Modify: `src/fabry/architect/collectionNames.ts`

**Interfaces:**
- Consumes: `cleanHref` (Task 1).
- Produces: `ASSET_COLLECTION` from `collectionNames.ts`; and from `assets.ts`: `createAssetStore({ find, fetchBytes, maxBytes? })` returning `{ load(), lookup(href), peek(href), resolve(href), entries(), stats() }`. `AssetRow = { key, documentId, mime, name, size, sha256, aliases, uploadedAt }`.

- [ ] **Step 1: Write the failing test**

```js
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAssetStore } from '../src/fabry/architect/assets.js';

const ROW = (key, size, id) => ({
  _id: key, kind: 'asset', documentId: id, mime: 'image/png',
  name: key.split('/').pop(), size, sha256: `sha-${id}`, aliases: [],
});

beforeEach(() => {
  globalThis.URL.createObjectURL = vi.fn(() => `blob:${Math.random()}`);
  globalThis.URL.revokeObjectURL = vi.fn();
});

const store = (rows, fetchBytes, maxBytes) => createAssetStore({
  find: async () => ({ result: rows }),
  fetchBytes,
  maxBytes,
});

describe('read path', () => {
  it('fetches once per key and caches the object URL', async () => {
    const fetchBytes = vi.fn(async () => new Blob(['x']));
    const s = store([ROW('assets/diagram.png', 10, 1234)], fetchBytes);
    await s.load();
    const a = await s.resolve('assets/diagram.png');
    const b = await s.resolve('assets/diagram.png');
    expect(a.url).toBe(b.url);
    expect(fetchBytes).toHaveBeenCalledOnce();
    expect(fetchBytes).toHaveBeenCalledWith(1234);
  });

  it('resolves an alias to the same row', async () => {
    const row = { ...ROW('assets/diagram.png', 10, 1234), aliases: ['https://example.test/old/diagram.png'] };
    const s = store([row], async () => new Blob(['x']));
    await s.load();
    expect(s.lookup('https://example.test/old/diagram.png').documentId).toBe(1234);
  });

  it('peek is synchronous — null before the fetch, the held value after', async () => {
    const s = store([ROW('assets/diagram.png', 10, 1234)], async () => new Blob(['x']));
    await s.load();
    expect(s.peek('assets/diagram.png')).toBe(null);
    const held = await s.resolve('assets/diagram.png');
    expect(s.peek('assets/diagram.png#anchor')).toBe(held);
  });

  it('reports a failed fetch rather than throwing', async () => {
    const s = store([ROW('assets/diagram.png', 10, 1234)], async () => { throw new Error('401'); });
    await s.load();
    expect((await s.resolve('assets/diagram.png')).error).toBe('401');
  });

  it('evicts the OLDEST entry when a new one pushes past the budget', async () => {
    const s = store([ROW('assets/a.png', 6, 1), ROW('assets/b.png', 5, 2)], async () => new Blob(['x']), 10);
    await s.load();
    const a = await s.resolve('assets/a.png');
    const b = await s.resolve('assets/b.png');
    expect(globalThis.URL.revokeObjectURL).toHaveBeenCalledWith(a.url);
    expect(globalThis.URL.revokeObjectURL).not.toHaveBeenCalledWith(b.url);
    expect(s.peek('assets/b.png')).toBe(b);
    expect(s.stats().bytes).toBe(5);
  });

  it('does not evict the entry it just inserted, even when it alone exceeds the budget', async () => {
    const s = store([ROW('assets/big.png', 99, 7)], async () => new Blob(['x']), 10);
    await s.load();
    const held = await s.resolve('assets/big.png');
    expect(globalThis.URL.revokeObjectURL).not.toHaveBeenCalled();
    expect(s.peek('assets/big.png')).toBe(held);
    expect(s.stats().entries).toBe(1);
  });

  it('fetches once when the same key is resolved concurrently', async () => {
    const fetchBytes = vi.fn(async () => new Blob(['x']));
    const s = store([ROW('assets/diagram.png', 10, 1234)], fetchBytes);
    await s.load();
    const [x, y] = await Promise.all([s.resolve('assets/diagram.png'), s.resolve('assets/diagram.png')]);
    expect(fetchBytes).toHaveBeenCalledOnce();
    expect(x.url).toBe(y.url);
    expect(s.stats().bytes).toBe(10);
    expect(globalThis.URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it('a second concurrent load waits for the index rather than seeing it empty', async () => {
    const s = store([ROW('assets/diagram.png', 10, 1234)], async () => new Blob(['x']));
    await Promise.all([s.load(), s.load()]);
    expect(s.lookup('assets/diagram.png')).toBeTruthy();
  });

  it('methods still work when destructured off the store', async () => {
    const s = store([ROW('assets/diagram.png', 10, 1234)], async () => new Blob(['x']));
    await s.load();
    const { resolve, peek } = s;
    const held = await resolve('assets/diagram.png');
    expect(held.url).toBeTruthy();
    expect(peek('assets/diagram.png')).toBe(held);
  });

  it('survives an unreadable index without taking the pane down', async () => {
    const s = createAssetStore({ find: async () => { throw new Error('nope'); }, fetchBytes: async () => null });
    await s.load();
    expect(s.lookup('assets/diagram.png')).toBe(null);
    expect(s.stats().indexError).toBe('nope');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/asset-store.test.ts`
Expected: FAIL — cannot resolve `../src/fabry/architect/assets.js`

- [ ] **Step 3: Add the collection name**

In `src/fabry/architect/collectionNames.ts`:

```ts
// Files referenced by deliverables: one row per file, mapping the reference an author writes to the
// Rossum document that holds the bytes. Same `_SA_EXTENSION__` prefix, so `isHiddenCollection`
// already keeps it out of Dataset Management with no change there.
export const ASSET_COLLECTION = '_SA_EXTENSION__fabry_architect_assets';
```

- [ ] **Step 4: Write minimal implementation**

```ts
// Asset bytes, fetched once and held as an object URL.
//
// Bounded by TOTAL BYTES rather than entry count: a workbook and an icon are not the same cost, and
// a count-based cap would happily hold twenty workbooks. Transport is injected so this tests without
// a browser or a live org.
import { cleanHref } from './assetKeys.js';

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

export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

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

export function createAssetStore({
  find,
  fetchBytes,
  maxBytes = DEFAULT_MAX_BYTES,
}: {
  find: () => Promise<any>;
  fetchBytes: (documentId: number) => Promise<Blob>;
  maxBytes?: number;
}) {
  let byRef = new Map<string, AssetRow>();
  let rows: AssetRow[] = [];
  let indexError: string | null = null;
  let loading: Promise<void> | null = null;
  const cache = new Map<string, Held>();
  const inflight = new Map<string, Promise<Held>>();
  let bytes = 0;

  // `keep` is the entry just inserted: without it, an asset larger than the budget evicts ITSELF
  // and the caller receives an already-revoked object URL. An oversized lone asset stays cached.
  function evict(keep: string) {
    for (const [ref, held] of cache) {
      if (bytes <= maxBytes) break;
      if (ref === keep) continue;
      cache.delete(ref);
      bytes -= held.row.size || 0;
      if (held.url) { try { URL.revokeObjectURL(held.url); } catch { /* no URL in tests without a stub */ } }
    }
  }

  function lookup(href: string): AssetRow | null {
    // The fallback is NOT redundant: `cleanHref` rejects absolute URLs, but an alias may BE an
    // absolute URL (a reference written before this feature existed), so the raw form must still be
    // looked up. Remove it and every aliased reference silently misses.
    const h = cleanHref(href) || String(href ?? '').split('#')[0].split('?')[0];
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
    } catch (err: any) {
      indexError = err && err.message ? err.message : String(err);
    }
  }

  return {
    load(): Promise<void> {
      if (!loading) loading = readIndex();
      return loading;
    },
    entries(): AssetRow[] {
      return [...rows];
    },
    lookup,
    peek(href: string): Held | null {
      const row = lookup(href);
      return (row && cache.get(row.key)) || null;
    },
    resolve(href: string): Promise<Held | null> {
      const row = lookup(href);
      if (!row) return Promise.resolve(null);
      const hit = cache.get(row.key);
      if (hit) return Promise.resolve(hit);
      const pending = inflight.get(row.key);
      if (pending) return pending;
      const p = (async (): Promise<Held> => {
        try {
          const blob = await fetchBytes(row.documentId);
          const held: Held = { row, url: URL.createObjectURL(blob) };
          cache.set(row.key, held);
          bytes += row.size || 0;
          evict(row.key);
          return held;
        } catch (err: any) {
          return { row, error: err && err.message ? err.message : String(err) };
        } finally {
          inflight.delete(row.key);
        }
      })();
      inflight.set(row.key, p);
      return p;
    },
    stats() {
      return { bytes, entries: cache.size, indexed: byRef.size, indexError };
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/asset-store.test.ts`
Expected: PASS, 10 tests

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/fabry/architect/assets.ts src/fabry/architect/collectionNames.ts tests/asset-store.test.ts
git commit -m "feat: hold asset bytes behind a byte-bounded cache"
```

---

### Task 3: The store, write path

> The `upsertRow` interface sketched below is superseded by fix rounds 3-4 (`insertRow` + `updateRow`, and the landed-insert adoption): build against design §5.2, not this section.

**Files:**
- Modify: `src/fabry/architect/assets.ts`
- Create: `tests/asset-upload.test.ts`

**Interfaces:**
- Consumes: `keyForFile`, `mimeForName` (Task 1); the store from Task 2.
- Produces: on the store — `upload(file: File) -> Promise<{ row: AssetRow; reused: boolean }>` and `remove(key: string) -> Promise<void>`. Constructor gains `postDocument`, `deleteDocument`, `upsertRow`, `deleteRow` and `sha256`.

- [ ] **Step 1: Write the failing test**

```js
import { describe, expect, it, vi } from 'vitest';
import { createAssetStore } from '../src/fabry/architect/assets.js';

const file = (name, text) => new File([text], name, { type: 'application/octet-stream' });

function harness(rows = []) {
  const calls = { post: [], upsert: [], delDoc: [], delRow: [] };
  const store = createAssetStore({
    find: async () => ({ result: rows }),
    fetchBytes: async () => new Blob(['x']),
    sha256: async (buf) => `sha-of-${new TextDecoder().decode(buf)}`,
    postDocument: async (f) => { calls.post.push(f.name); return 4242; },
    upsertRow: async (row) => { calls.upsert.push(row); },
    deleteDocument: async (id) => { calls.delDoc.push(id); },
    deleteRow: async (key) => { calls.delRow.push(key); },
  });
  return { store, calls };
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
    expect(calls.upsert).toHaveLength(1);
    expect(store.lookup('assets/diagram.png')).toBeTruthy();
  });

  it('reuses the document when the bytes already exist, adding an alias', async () => {
    const existing = {
      _id: 'assets/diagram.png', kind: 'asset', documentId: 1234, mime: 'image/png',
      name: 'diagram.png', size: 1, sha256: 'sha-of-a', aliases: [],
    };
    const { store, calls } = harness([existing]);
    await store.load();
    const { row, reused } = await store.upload(file('copy.png', 'a'));
    expect(reused).toBe(true);
    expect(calls.post).toEqual([]);
    expect(row.documentId).toBe(1234);
    expect(calls.upsert[0].aliases).toContain('assets/copy.png');
    expect(store.lookup('assets/copy.png').documentId).toBe(1234);
  });

  it('names a colliding reference rather than overwriting one', async () => {
    const existing = {
      _id: 'assets/diagram.png', kind: 'asset', documentId: 1234, mime: 'image/png',
      name: 'diagram.png', size: 1, sha256: 'sha-of-other', aliases: [],
    };
    const { store } = harness([existing]);
    await store.load();
    const { row } = await store.upload(file('diagram.png', 'a'));
    expect(row.key).toBe('assets/diagram-2.png');
  });

  it('re-points every alias when the same bytes are uploaded a third time', async () => {
    const existing = {
      _id: 'assets/diagram.png', kind: 'asset', documentId: 1234, mime: 'image/png',
      name: 'diagram.png', size: 1, sha256: 'sha-of-a', aliases: [],
    };
    const { store } = harness([existing]);
    await store.load();
    await store.upload(file('copy.png', 'a'));
    await store.upload(file('copy2.png', 'a'));
    for (const href of ['assets/diagram.png', 'assets/copy.png', 'assets/copy2.png']) {
      expect(store.lookup(href).aliases).toEqual(['assets/copy.png', 'assets/copy2.png']);
    }
  });

  it('removing via an alias leaves no reference to the deleted document', async () => {
    const existing = {
      _id: 'assets/diagram.png', kind: 'asset', documentId: 1234, mime: 'image/png',
      name: 'diagram.png', size: 1, sha256: 'sha-of-a', aliases: [],
    };
    const { store } = harness([existing]);
    await store.load();
    await store.upload(file('copy.png', 'a'));
    await store.upload(file('copy2.png', 'a'));
    await store.remove('assets/copy.png');
    for (const href of ['assets/diagram.png', 'assets/copy.png', 'assets/copy2.png']) {
      expect(store.lookup(href)).toBe(null);
    }
  });

  it('deletes the row before the document, so a partial failure cannot strand a live row', async () => {
    const order = [];
    const existing = {
      _id: 'assets/diagram.png', kind: 'asset', documentId: 1234, mime: 'image/png',
      name: 'diagram.png', size: 1, sha256: 's', aliases: [],
    };
    const store = createAssetStore({
      find: async () => ({ result: [existing] }),
      fetchBytes: async () => new Blob(['x']),
      sha256: async () => 's',
      postDocument: async () => 1,
      upsertRow: async () => {},
      deleteRow: async () => { order.push('row'); },
      deleteDocument: async () => { order.push('document'); },
    });
    await store.load();
    await store.remove('assets/diagram.png');
    expect(order).toEqual(['row', 'document']);
  });

  it('removes the row and the document', async () => {
    const existing = {
      _id: 'assets/diagram.png', kind: 'asset', documentId: 1234, mime: 'image/png',
      name: 'diagram.png', size: 1, sha256: 's', aliases: [],
    };
    const { store, calls } = harness([existing]);
    await store.load();
    await store.remove('assets/diagram.png');
    expect(calls.delDoc).toEqual([1234]);
    expect(calls.delRow).toEqual(['assets/diagram.png']);
    expect(store.lookup('assets/diagram.png')).toBe(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/asset-upload.test.ts`
Expected: FAIL — `store.upload is not a function`

- [ ] **Step 3: Write minimal implementation**

Extend the constructor options with `sha256`, `postDocument`, `upsertRow`, `deleteDocument`, `deleteRow`, and add to the returned object:

```ts
    async upload(f: File): Promise<{ row: AssetRow; reused: boolean }> {
      const digest = await sha256(await f.arrayBuffer());
      const taken = new Set(byRef.keys());
      const key = keyForFile(f.name, taken);
      const twin = rows.find((r) => r.sha256 && r.sha256 === digest);

      // Same bytes already stored: keep one document and let the new reference alias it.
      if (twin) {
        const next: AssetRow = { ...twin, aliases: [...twin.aliases, key] };
        await upsertRow(next);
        rows = rows.map((r) => (r.key === next.key ? next : r));
        // EVERY key that reaches this row must be re-pointed, not just the new one: an alias added
        // by an earlier upload would otherwise keep pointing at a superseded row object whose
        // `aliases` array is missing everything added since — and `remove()` trusts that array to
        // clean up, so a stale one leaves live references to a deleted document.
        byRef.set(next.key, next);
        for (const a of next.aliases) byRef.set(a, next);
        return { row: next, reused: true };
      }

      // Document first, row second: the reverse would leave a row pointing at nothing, which a
      // reader sees as a broken asset. A crash between the two leaves a document no row references
      // — wasted storage, invisible, and not auto-deleted (see the spec, §5.2).
      const documentId = await postDocument(f);
      const row: AssetRow = {
        key,
        documentId,
        mime: mimeForName(f.name),
        name: f.name,
        size: f.size,
        sha256: digest,
        aliases: [],
        uploadedAt: Date.now(),
      };
      await upsertRow(row);
      rows = [...rows, row];
      byRef.set(key, row);
      return { row, reused: false };
    },

    async remove(key: string): Promise<void> {
      const row = byRef.get(key);
      if (!row) return;
      // The mirror of the create ordering. Row first: if the second call fails, the leftover is an
      // orphaned document nothing references — invisible, and the failure mode this design already
      // accepts. Document first would leave a row pointing at a deleted document, which is a
      // visibly broken asset for every reader.
      await deleteRow(row.key);
      await deleteDocument(row.documentId);
      rows = rows.filter((r) => r.key !== row.key);
      byRef.delete(row.key);
      for (const a of row.aliases) byRef.delete(a);
      const held = cache.get(row.key);
      if (held) {
        cache.delete(row.key);
        bytes -= row.size || 0;
        if (held.url) { try { URL.revokeObjectURL(held.url); } catch { /* no URL in tests */ } }
      }
    },
```

Import `keyForFile` and `mimeForName` from `./assetKeys.js`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/asset-upload.test.ts && npx tsc --noEmit`
Expected: PASS, 7 tests; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/fabry/architect/assets.ts tests/asset-upload.test.ts
git commit -m "feat: upload an asset once, however many references point at it"
```

---

### Task 4: Images resolve in the document

**Files:**
- Modify: `src/docs/renderCache.ts`
- Create: `tests/docs-asset-images.test.ts`

**Interfaces:**
- Consumes: `peek(href)` from Task 2, passed in as `assets` — a plain synchronous function, so `renderDocument` stays synchronous.
- Produces: `renderDocument({ id, text, mermaid, dark, syncLines, assets })`; `assets` joins the cache key as `withAssets`.

- [ ] **Step 1: Write the failing test**

```js
import { describe, expect, it } from 'vitest';
import { renderDocument } from '../src/docs/renderCache.js';

const ROW = { key: 'assets/diagram.png', documentId: 1234, mime: 'image/png', name: 'diagram.png', size: 10, sha256: 's', aliases: [], uploadedAt: null };

describe('renderDocument with assets', () => {
  it('leaves a relative src alone when no resolver is given', () => {
    const { body } = renderDocument({ id: 'a', text: '![shot](assets/diagram.png)' });
    expect(body.querySelector('img').getAttribute('src')).toBe('assets/diagram.png');
  });

  it('swaps a resolved image for its object URL and shows its name', () => {
    const { body } = renderDocument({
      id: 'b', text: '![shot](assets/diagram.png)', assets: () => ({ row: ROW, url: 'blob:xyz' }),
    });
    const img = body.querySelector('img');
    expect(img.getAttribute('src')).toBe('blob:xyz');
    expect(img.getAttribute('title')).toContain('diagram.png');
  });

  it('marks an unpublished reference instead of leaving a broken glyph', () => {
    const { body } = renderDocument({ id: 'c', text: '![shot](assets/missing.png)', assets: () => null });
    expect(body.querySelector('img')).toBe(null);
    const pill = body.querySelector('.state-label.state-error');
    expect(pill.textContent).toContain('assets/missing.png');
    expect(pill.textContent).toContain('not published');
  });

  it('distinguishes a failed fetch from a missing reference', () => {
    const { body } = renderDocument({
      id: 'd', text: '![shot](assets/diagram.png)', assets: () => ({ row: ROW, error: '401' }),
    });
    expect(body.querySelector('.state-label.state-error').textContent).toContain('unavailable');
  });

  it('never consults the resolver for an external or data image', () => {
    const { body } = renderDocument({
      id: 'e', text: '![a](https://example.test/a.png)', assets: () => { throw new Error('must not run'); },
    });
    expect(body.querySelector('img').getAttribute('src')).toBe('https://example.test/a.png');
  });

  it('keys the cache on whether assets were available', () => {
    const text = '![shot](assets/diagram.png)';
    const plain = renderDocument({ id: 'f', text });
    const withAssets = renderDocument({ id: 'f', text, assets: () => ({ row: ROW, url: 'blob:zzz' }) });
    expect(plain.body.querySelector('img').getAttribute('src')).toBe('assets/diagram.png');
    expect(withAssets.body.querySelector('img').getAttribute('src')).toBe('blob:zzz');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/docs-asset-images.test.ts`
Expected: FAIL — the object-URL assertions fail; `assets` is ignored.

- [ ] **Step 3: Write minimal implementation**

Add to `src/docs/renderCache.ts`:

```ts
type AssetPeek = (href: string) => { row: { name: string }; url?: string; error?: string } | null;

function applyAssets(body: HTMLElement, assets: AssetPeek): void {
  for (const img of [...body.querySelectorAll('img[src]')] as HTMLImageElement[]) {
    const src = img.getAttribute('src') || '';
    if (/^https?:|^data:|^\/\//i.test(src)) continue;
    let held = null;
    try { held = assets(src); } catch { held = null; }
    if (held && held.url) {
      img.setAttribute('src', held.url);
      img.setAttribute('title', held.row.name);
      continue;
    }
    const why = held && held.error ? 'unavailable' : 'not published';
    const doc = body.ownerDocument;
    const pill = doc.createElement('span');
    pill.className = 'state-label state-error';
    pill.setAttribute('data-state', 'error');
    const text = doc.createElement('span');
    text.className = 'state-label-text';
    text.textContent = `${src} — ${why}`;
    pill.append(text);
    img.replaceWith(pill);
  }
}
```

Then in `renderDocument`: accept `assets = null` in the options, add `withAssets: !!assets` to the `cacheKey({ … })` call, and call `applyAssets(body, assets)` after `markLinksForPane(sanitizeBody(html))` and **before** the entry is stored — a cached tree is never touched again.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/docs-asset-images.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Check nothing regressed**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS — existing render, cache and equivalence tests are unaffected because `assets` defaults to null.

- [ ] **Step 6: Commit**

```bash
git add src/docs/renderCache.ts tests/docs-asset-images.test.ts
git commit -m "feat: render an uploaded image inside a deliverable"
```

---

### Task 5: Files open on click

**Files:**
- Modify: `src/docs/components/DocView.tsx`
- Modify: `src/docs/resources.ts`
- Create: `tests/docs-asset-click.test.ts`

**Interfaces:**
- Consumes: `lookup` (Task 2).
- Produces: a `version` counter on the store (`assets.ts`), bumped on every successful `resolve`, `load`, `upload` and `remove`; `assetsVersion?: number` threaded into `renderDocument`'s options and into its cache key (`renderCache.ts`); `DocView` props `assets?: { lookup(href): unknown | null; peek(href): unknown | null; version(): number }` and `onAssetOpen?: (href: string) => void`; `formatResource(raw, view, mime?)` gains a mime-aware branch returning `{ kind: 'image' | 'text' | 'download' | 'json' | 'code', … }`.
- **Note (controller ruling):** ONE `assets` prop carrying the store, not a separate `assetLookup`. The plan's step text below mentioned an `assetPeekRef` that no declared prop supplied; both refs now read from this single prop.

- [ ] **Step 1: Write the failing test**

```js
import { describe, expect, it } from 'vitest';
import { formatResource } from '../src/docs/resources.js';

describe('formatResource with a mime', () => {
  it('keeps the existing JSON and code behaviour when no mime is passed', () => {
    const out = formatResource(JSON.stringify({ config: { code: 'x = 1', runtime: 'python3.12' } }));
    expect(out.view).toBe('code');
    expect(out.text).toBe('x = 1');
  });

  it('treats text as text instead of parsing it', () => {
    const out = formatResource('col_a,col_b\n1,2\n', null, 'text/csv');
    expect(out.kind).toBe('text');
    expect(out.text).toBe('col_a,col_b\n1,2\n');
  });

  it('reports an image as an image', () => {
    expect(formatResource('<binary>', null, 'image/png').kind).toBe('image');
  });

  it('offers a download for anything else', () => {
    expect(formatResource('<binary>', null, 'application/vnd.ms-excel.sheet.macroEnabled.12').kind).toBe('download');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/docs-asset-click.test.ts`
Expected: FAIL — `out.kind` is undefined

- [ ] **Step 3: Write minimal implementation**

At the top of `formatResource`, before the `JSON.parse`:

```ts
  if (mime && !/^application\/json\b/i.test(mime)) {
    if (/^image\//i.test(mime)) return { kind: 'image', mime, text: '', language: '', view: null, views: [] };
    if (/^text\/|^message\/rfc822$/i.test(mime)) {
      const language = /x-python$/i.test(mime) ? 'python' : 'plaintext';
      return { kind: 'text', mime, text: String(raw ?? ''), language, view: null, views: [] };
    }
    return { kind: 'download', mime, text: '', language: '', view: null, views: [] };
  }
```

and add `kind: 'code'` / `kind: 'json'` to the existing return shapes so callers branch on one field.

In `DocView.tsx`'s `onClick`, immediately before the sibling-document branch (the one whose comment notes that unresolvable links do nothing):

```tsx
    if (assetsRef.current && assetsRef.current.lookup(href)) {
      e.preventDefault();
      onAssetOpenRef.current?.(href);
      return;
    }
```

Mirror `assets` and `onAssetOpen` into refs exactly as the file already does for `onNavigate`, and pass BOTH `assets: (href) => assetsRef.current?.peek(href) ?? null` and `assetsVersion: assetsRef.current?.version() ?? 0` into `renderDocument`.

**Controller ruling 15 — the repaint is a targeted DOM patch, NOT a re-render.** This supersedes the
earlier "version in the cache key" ruling, which review proved self-defeating on three counts:

- `assetsVersion` was a dependency of the `rendered` memo, which feeds the adopt effect, which calls
  `body.replaceChildren()` and tears down `initSourceViewer` — whose `destroy()` calls `closeModal()`.
  So resolving an asset **closes the source modal this task exists to open**, and cancels the hover
  timer. `DocView.tsx` documents that exact hazard in its own comment; the version routed a repaint
  straight through it.
- `isRendered`/`preload` omit both key components, so once `assets` is supplied no warmed entry can
  ever match — defeating the documented "preload so page switching is instant" requirement — and each
  bump invalidates every entry against `CACHE_CAP = 24`.
- **Nothing in `src/` calls `store.resolve()` at all**, so no image would ever load even fully wired.
  The plan never assigned that work to a task. This ruling assigns it.

Required shape:

1. **`renderDocument` loses `assets` and `assetsVersion` entirely** — options and cache key both. It
   goes back to knowing nothing about assets, so the preload cache works exactly as before. Instead,
   an asset image renders as `<img data-asset-ref="assets/diagram.png">` with **no `src`**, so the
   browser issues no request for a path that cannot resolve.
2. **A new exported `syncAssets(root, store)`** — idempotent and bidirectional, operating on a **live**
   DOM root, never on a cached tree. For every `[data-asset-ref]` it asks `peek`:
   - cached → set `src` to the object URL;
   - failure → the `.state-label.state-error` pill reading "unavailable";
   - no row → the same pill reading "not published";
   - row exists but nothing cached and nothing in flight → paint nothing yet and call `resolve()`
     fire-and-forget, so the bytes are actually fetched. This is the only thing that starts a fetch.
   A pill must keep the `data-asset-ref` so a later pass can turn it back into an image: transitions
   run in both directions (not-published → unavailable → resolved), which is what makes an evicted or
   retried asset self-heal.
3. **`DocView` runs it in an effect keyed on `[rendered, assetsVersion]`** against the live `main`
   element. `assetsVersion` must **not** be a dependency of the `rendered` memo or of the adopt effect,
   so the modal, the hover timer and the scroll position all survive a resolve.

**Controller ruling 16 — what is on screen is pinned, and is never evicted.** Ruling 15's sync pass
plus the byte evictor form an unbounded loop: a successful `resolve` adds bytes, evicts *other* entries
and revokes their object URLs, then bumps the version; the bump re-runs the pass, which finds those
refs still in the live DOM with `peek` answering `null` and a row still present, and resolves them
again — evicting whatever displaced them. Any single document referencing more than `maxBytes` cycles
forever, and `SpecView` puts every deliverable in one scroller, so that is the ordinary case rather
than an edge one.

The fix is to stop pretending the store can evict something the reader is looking at:

1. `syncAssets` collects the refs it painted and hands them to the store as the **pinned set**,
   replacing the previous one, at the end of every pass.
2. `evict` never evicts a pinned key. If the pinned set alone exceeds `maxBytes`, the budget is
   deliberately exceeded — a document holds what it displays, and that is bounded by the document's
   own asset set. Say so in a comment; it is a real trade, not an oversight.
3. `syncAssets` must treat an element whose `src` is a `blob:` while `peek` answers `null` as
   unresolved: clear the `src` first, so a revoked URL is never left painted as a broken picture —
   which the module's own header comment already promises and the current code does not deliver.

Fix three cheap defects in the same pass, each closing a real hole:

- **Preserve attributes on resolve.** Set `src` on the existing `<img>` in place rather than building a
  fresh one: the sanitizer keeps `alt`, `class`, `id`, `width`, `height` and `align`, and a markdown
  image currently loses its `alt` — and an HTML-authored image its sizing — the moment it resolves.
- **Narrow the selector** to `img[data-asset-ref], span.state-label[data-asset-ref]`. The sanitizer
  preserves every `data-*` attribute on every allowed element, so a deliverable that authors
  `data-asset-ref` in raw HTML currently has that element destructively replaced.
- **Attach a `.catch()`** to the fire-and-forget `resolve()`. The shipped store always fulfils, but the
  declared type permits a rejection, which would surface as a console error.

Tests, and they stay in the tree — an earlier round wrote DOM-level proofs and then deleted them,
leaving the strongest evidence this task produced unprotected:

- **Termination:** a document whose assets exceed `maxBytes` resolves each image exactly once; a second
  sync pass issues no further fetches. This is the test that would have caught the loop.
- An element holding a revoked `blob:` src with no cache entry is never left painted as one.
- Resolving an image preserves its `alt`.

- DOM-level: a pill becomes an image after a resolve completes, **without** the adopt effect re-running
  (assert it ran once).
- DOM-level: "not published" → "unavailable" after a failed fetch.
- `DocView` click ordering: `#fragment` still scrolls, a resource href still opens the modal, an asset
  href is intercepted with `preventDefault` and calls `onAssetOpen`, and an unknown relative link still
  does nothing.
- A warmed `isRendered` entry is still a hit when assets are in play.

**Controller ruling — a failed fetch must be visible as a failure, not as "never published".** `resolve()`
returns `{ row, error }` on failure but neither caches it nor bumps the version, and `peek` reads only the
success cache — so after a 401 or a network error `peek` answers `null` and the reader is told
"not published", which is a wrong diagnosis. Task 4's "unavailable" branch is unreachable through the real
wiring. Fix, in `assets.ts`:

1. Keep a `failures: Map<string, Held>` beside `cache`. On the catch path, store `{ row, error }` there and
   bump the version, so the pill repaints from "not published" to "unavailable".
2. `peek` consults `cache` first, then `failures`.
3. `resolve` must **not** short-circuit on a cached failure — it clears that entry and retries, so a
   transient failure recovers once the cause is fixed. Only `peek` sees the failure.
4. A failure holds no object URL and no bytes, so it must never be counted into `bytes` or evicted.

Tests for this, in `tests/asset-store.test.ts`:

```ts
  it('surfaces a failed fetch to peek as unavailable, and bumps the version', async () => {
    const s = store([ROW('assets/diagram.png', 10, 1234)], async () => { throw new Error('401'); });
    await s.load();
    const before = s.version();
    expect(await s.resolve('assets/diagram.png')).toMatchObject({ error: '401' });
    expect(s.peek('assets/diagram.png')).toMatchObject({ error: '401' });
    expect(s.version()).not.toBe(before);
    expect(s.stats().bytes).toBe(0);
  });

  it('retries a previously failed fetch rather than serving the failure forever', async () => {
    let attempt = 0;
    const fetchBytes = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('401');
      return new Blob(['x']);
    });
    const s = store([ROW('assets/diagram.png', 10, 1234)], fetchBytes);
    await s.load();
    await s.resolve('assets/diagram.png');
    const second = await s.resolve('assets/diagram.png');
    expect(fetchBytes).toHaveBeenCalledTimes(2);
    expect(second.url).toBeTruthy();
    expect(second.error).toBeUndefined();
    expect(s.peek('assets/diagram.png')).toBe(second);
  });
```

And one in `tests/docs-resources.test.ts` pinning the judgement call the implementer flagged: with no mime,
input that is not valid JSON returns `kind: 'text'` with the raw input as its text.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/docs-asset-click.test.ts && npx tsc --noEmit`
Expected: PASS, 4 tests; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/docs/components/DocView.tsx src/docs/resources.ts tests/docs-asset-click.test.ts
git commit -m "feat: preview or download an asset from a deliverable link"
```

---

### Task 6: The Assets tab

**Files:**
- Create: `src/fabry/architect/components/AssetsPanel.tsx`
- Modify: `src/fabry/architect/components/InspectorRail.tsx`
- Modify: `src/fabry/architect/store.ts`
- Modify: `src/console/console.css`
- Create: `tests/architect-assets-panel.test.ts`

**Interfaces:**
- Consumes: the store (Tasks 2–3), `hrefs` per deliverable.
- Produces: `groupAssets(rows, refsByKey, currentId)` → `{ here: AssetRow[]; elsewhere: AssetRow[]; unused: AssetRow[] }`, exported from `AssetsPanel.tsx` for test; and the panel component.

The grouping is the reason the rail is the right home (spec §5.5), so it is the part with a unit test; the rest is markup driven by it.

- [ ] **Step 1: Write the failing test**

```js
import { describe, expect, it } from 'vitest';
import { groupAssets } from '../src/fabry/architect/components/AssetsPanel.jsx';

const row = (key) => ({ key, documentId: 1, mime: 'image/png', name: key.split('/').pop(), size: 1, sha256: 's', aliases: [], uploadedAt: null });

describe('groupAssets', () => {
  const rows = [row('assets/a.png'), row('assets/b.png'), row('assets/c.png')];
  const refs = { 'assets/a.png': ['d1'], 'assets/b.png': ['d2', 'd3'] };

  it('leads with what the deliverable in view references', () => {
    const g = groupAssets(rows, refs, 'd1');
    expect(g.here.map((r) => r.key)).toEqual(['assets/a.png']);
    expect(g.elsewhere.map((r) => r.key)).toEqual(['assets/b.png']);
    expect(g.unused.map((r) => r.key)).toEqual(['assets/c.png']);
  });

  it('puts everything referenced under elsewhere when nothing points here', () => {
    const g = groupAssets(rows, refs, 'd9');
    expect(g.here).toEqual([]);
    expect(g.elsewhere).toHaveLength(2);
    expect(g.unused).toHaveLength(1);
  });

  it('treats an asset with an empty reference list as unused', () => {
    const g = groupAssets(rows, { 'assets/a.png': [] }, 'd1');
    expect(g.unused).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/architect-assets-panel.test.ts`
Expected: FAIL — cannot resolve the module

- [ ] **Step 3: Write minimal implementation**

```tsx
export function groupAssets(rows: AssetRow[], refsByKey: Record<string, string[]>, currentId: string | null) {
  const here: AssetRow[] = [];
  const elsewhere: AssetRow[] = [];
  const unused: AssetRow[] = [];
  for (const r of rows) {
    const refs = refsByKey[r.key] || [];
    if (!refs.length) unused.push(r);
    else if (currentId && refs.includes(currentId)) here.push(r);
    else elsewhere.push(r);
  }
  return { here, elsewhere, unused };
}
```

Then the panel: the header (`N files · total`), an **Add files** button opening a multi-select `<input type="file">` (the `Composer.tsx` precedent) plus a `showDirectoryPicker` path, a filter input, the three groups from `groupAssets`, and per-row hover actions — copy reference, download, delete. Delete first resolves which deliverables reference the key and lists them, then allows it. The panel body is the drop target. Class names use the `fabry-arch-asset-` prefix and the tokens in `console.css`.

**Also required here: a header "Download all" action** (spec D6). With no repository copy and no cross-organization copy, this is the only path by which an asset can leave the organization it was uploaded to — so it is a component, not a nice-to-have. Sequential per-file downloads named from each row's `name`; follow the browser-download pattern in `src/mdh/downloadCollection.ts` rather than adding a zip dependency.

Build `refsByKey` with `assetRefsIn` from `assetKeys.ts` (Task 1) — do not write a second link regex — memoised on the deliverables signal.

In `InspectorRail.tsx`, extend `TABS` with `['assets', '⧉ Assets']` and mount **without** a key:

```tsx
        {active === 'assets' ? <AssetsPanel /> : null}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/architect-assets-panel.test.ts && npx tsc --noEmit && node build.js`
Expected: PASS, 3 tests; clean typecheck and build.

- [ ] **Step 5: Look at it**

Load the extension, open the Architect, select the Assets tab. Confirm: the three groups appear, scrolling between deliverables re-sorts the list without a visible refetch, an upload lands in the right group, and a second upload of the same bytes shows `reused`.

- [ ] **Step 6: Commit**

```bash
git add src/fabry/architect/components/AssetsPanel.tsx src/fabry/architect/components/InspectorRail.tsx \
        src/fabry/architect/store.ts src/console/console.css tests/architect-assets-panel.test.ts
git commit -m "feat: manage a deliverable's files from the inspector rail"
```

---

### Task 7: Paste into the editor

**Files:**
- Modify: `src/fabry/architect/components/SourceEditor.tsx`
- Create: `tests/architect-asset-paste.test.ts`

**Interfaces:**
- Consumes: `upload` (Task 3), `isImageMime` (Task 1).
- Produces: `referenceFor(name: string, mime: string) -> string` exported for test — `![name](key)` for an image, `[name](key)` otherwise.

- [ ] **Step 1: Write the failing test**

```js
import { describe, expect, it } from 'vitest';
import { referenceFor } from '../src/fabry/architect/components/SourceEditor.jsx';

describe('referenceFor', () => {
  it('writes an image as an image', () => {
    expect(referenceFor('assets/diagram.png', 'diagram.png', 'image/png')).toBe('![diagram.png](assets/diagram.png)');
  });

  it('writes anything else as a link', () => {
    expect(referenceFor('assets/sample.csv', 'sample.csv', 'text/csv')).toBe('[sample.csv](assets/sample.csv)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/architect-asset-paste.test.ts`
Expected: FAIL — `referenceFor` is not exported

- [ ] **Step 3: Write minimal implementation**

```ts
export function referenceFor(key: string, name: string, mime: string): string {
  return `${isImageMime(mime) ? '!' : ''}[${name}](${key})`;
}
```

Wire a `paste` and `drop` handler on the CodeMirror `EditorView` (via `EditorView.domEventHandlers`): take `event.clipboardData?.files` or `event.dataTransfer?.files`, upload each, and dispatch a transaction inserting `referenceFor(...)` at the current selection. Show the brief confirmation the mockup specifies.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/architect-asset-paste.test.ts && npx tsc --noEmit`
Expected: PASS, 2 tests

- [ ] **Step 5: Look at it**

Paste a screenshot into a deliverable. Confirm the reference lands at the cursor, the image resolves on the next paint, and the asset appears under **In this section**.

- [ ] **Step 6: Commit**

```bash
git add src/fabry/architect/components/SourceEditor.tsx tests/architect-asset-paste.test.ts
git commit -m "feat: paste a screenshot straight into a deliverable"
```

---

### Task 8: Assets survive printing

**Files:**
- Modify: `src/docs/printDoc.ts`
- Modify: `src/docs/print.css`
- Create: `tests/docs-asset-print.test.ts`

**Interfaces:**
- Consumes: `resolve` (Task 2), `renderDocument`'s `assets` (Task 4).
- Produces: `prefetchAssets(store, deliverables) -> Promise<void>`, awaited before the specification is assembled.

- [ ] **Step 1: Write the failing test**

```js
import { describe, expect, it, vi } from 'vitest';
import { prefetchAssets } from '../src/docs/printDoc.js';

describe('prefetchAssets', () => {
  it('resolves every referenced asset once, across all deliverables', async () => {
    const resolve = vi.fn(async () => ({ row: { name: 'diagram.png' }, url: 'blob:x' }));
    const store = { resolve, lookup: (h) => (h.startsWith('assets/') ? {} : null) };
    await prefetchAssets(store, [
      { text: '![a](assets/diagram.png)\n[f](assets/sample.csv)\n![x](https://example.test/y.png)' },
      { text: '![a](assets/diagram.png)' },
    ]);
    expect(resolve.mock.calls.map((c) => c[0]).sort()).toEqual(['assets/diagram.png', 'assets/sample.csv']);
  });

  it('does not reject when one asset fails', async () => {
    const store = { resolve: async () => { throw new Error('401'); }, lookup: () => ({}) };
    await expect(prefetchAssets(store, [{ text: '![a](assets/diagram.png)' }])).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/docs-asset-print.test.ts`
Expected: FAIL — `prefetchAssets` is not exported

- [ ] **Step 3: Write minimal implementation**

```ts
import { assetRefsIn } from '../fabry/architect/assetKeys.js';

export async function prefetchAssets(
  store: { resolve: (h: string) => Promise<unknown>; lookup: (h: string) => unknown | null } | null,
  deliverables: { text?: string }[],
): Promise<void> {
  if (!store) return;
  const hrefs = new Set<string>();
  for (const d of deliverables || []) {
    for (const href of assetRefsIn(String(d.text || ''))) {
      if (store.lookup(href)) hrefs.add(href);
    }
  }
  await Promise.all([...hrefs].map((h) => store.resolve(h).catch(() => null)));
}
```

Await it at the print entry point before `buildSpecSections`, then run `syncAssets` (Ruling 15) over the assembled DOM with a resolver that yields `data:` URIs rather than object URLs, which do not survive a print context reliably. Add to `print.css`, so a file reference is not lost on paper:

```css
@media print {
  .markdown-body a[data-asset]::after { content: " (" attr(data-asset) ")"; font-size: 90%; color: #57606a; }
}
```

and set `data-asset` to the asset's name on file links during the print render.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/docs-asset-print.test.ts`
Expected: PASS, 2 tests

- [ ] **Step 5: Full verification**

Run: `npx vitest run && npx tsc --noEmit && node build.js`
Expected: everything passes and the bundle builds.

- [ ] **Step 6: Look at it on paper**

Open the print preview of a specification that references an image and a file. Confirm the image is present and the file link shows its name in parentheses.

- [ ] **Step 7: Commit**

```bash
git add src/docs/printDoc.ts src/docs/print.css tests/docs-asset-print.test.ts
git commit -m "feat: include uploaded assets in a printed specification"
```
