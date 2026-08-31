# MDH search indexes on API V2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Dataset Management app's Atlas Search index support off the deprecated Data
Storage endpoints onto the Master Data Hub V2 subresource, and use the information V2 newly
reports.

**Architecture:** `api.ts` gains a second transport helper aimed at
`{baseDomain}/svc/master-data-hub` and three V2 functions that replace the three Data Storage
ones. V2 returns no operation id for writes, so the panel's completion tracking becomes a poll of
the index list itself in a new hook. Presentation logic (status badges, coverage summaries, the
sync line, validation-error trimming) lives as pure functions in `searchIndexDef.ts`, keeping the
panel a thin layer over them.

**Tech Stack:** TypeScript (strict, `erasableSyntaxOnly`), Preact + `@preact/signals`, Vitest
(+ jsdom for component tests), esbuild.

**Spec:** `docs/superpowers/specs/2026-08-28-mdh-search-index-v2-migration-design.md`

**Status: COMPLETE — all eight tasks executed 2026-08-28/31, verified in the browser by the
owner.** Two deviations from the plan as written, both at the owner's request mid-execution:
transitional badges and the sync line gained animated indicators, and the panel resumes the
reconcile poll on load (opening onto a build already running otherwise sat at `pending create`
until Refresh). One reversal: cards stay **expanded** by default, so the `defaultExpanded` prop
Task 2 added was removed again rather than left with no caller.

## Global Constraints

- **Do not commit.** The repository owner's standing rule: intermediate artifacts are staged, never
  committed, and a commit happens only when the owner explicitly asks for one. Every task below
  ends with `git add`, not `git commit`. When the owner does ask, it is **one commit for the whole
  run** — do not split it — and **no `Co-Authored-By` trailer**.
- **Work on `master`.** No branches, no worktrees.
- **No customer identifies itself in this repo.** It is public. Every fixture, comment and string
  uses the placeholders already in the suite: `acme`, `example`, `x`, `y`, `org`, and
  `partner-sandbox.rossum.app` for a host. Never a real organization name, hostname, dataset name
  or field name.
- **TypeScript is emit-neutral by preference.** Prefer an erased cast (`x as string`, `a!.b`) over
  a runtime change. Never add a guard, operator or argument purely to satisfy a type.
- **Do not annotate a contextually typed parameter** — a callback handed to `map`, `filter`,
  `vi.fn` or a typed prop already has a type.
- **Assert null-ness once, where the value is produced** (`const btn = root.querySelector('.x')!;`
  then plain `btn.click()`).
- **Component tests are `.test.tsx` and render real JSX.** Non-component tests stay `.test.ts`.
- **`vi.mocked(x)` is required** around a module mock for the mock surface to type-check.
- **No `\uXXXX` in JSX raw text or attribute values** — it renders as six literal characters. Build
  such strings inside a `.ts` module (where escapes work normally), or use `{'—'}` / an HTML
  entity in a text child.
- **No bare single-letter or two-letter class names in JSX.**
- `npm test` includes `tests/dead-code.test.ts`, which fails on **an export nothing imports**. Every
  task below introduces an export only together with its consumer. Where a helper is needed
  internally before it has an external consumer, it is declared module-local and exported later —
  this is called out where it applies.
- Verification commands: `npm run typecheck` (two programs), `npm test`, `npm run format:check`,
  `npm run build`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/mdh/relativeTime.ts` **(new)** | The app's one "how long ago" grammar, plus UTC parsing for V2's offset-less timestamps. |
| `src/mdh/searchIndexDef.ts` **(rewritten)** | All pure presentation logic for search indexes: definition pass-through, coverage summary, status badge mapping, transitional test, sync summary, paste splitting, validation-error trimming. |
| `src/mdh/hooks/useIndexReconcile.ts` **(new)** | Polls the index list while any index is transitional; aborts on unmount and collection switch. |
| `src/mdh/api.ts` | Adds the MDH V2 transport and the three V2 search-index functions; removes the three Data Storage ones. |
| `src/mdh/components/IndexCard.tsx` | Gains three optional props (`notice`, `defaultExpanded`, `onEdit`). Shared with the Indexes panel and Stages view, which pass none of them. |
| `src/mdh/components/SearchIndexPanel.tsx` | The panel: list, badges, meta, notice, sync line, create/edit modal, drop. |
| `src/mdh/components/QueryHistory.tsx` | Its private `formatTime` moves out to `relativeTime.ts`. |
| `src/mdh/prefetch.ts`, `src/mdh/agent/aiContext.ts` | Follow the new list shape. |
| `src/console/console.css` | The panel's new global rules. |

---

## Task 1: Extract the relative-time grammar

Two private relative-time formatters already exist in `src/mdh/components/`. The panel needs a
third use, so the grammar moves to one home rather than being copied again.

**Files:**
- Create: `src/mdh/relativeTime.ts`
- Modify: `src/mdh/components/QueryHistory.tsx` (remove the private `formatTime`, import it)
- Test: `tests/mdh-relative-time.test.ts` (new)

**Interfaces:**
- Consumes: nothing.
- Produces: `formatTime(ts: number): string`.

- [x] **Step 1: Write the failing test**

Create `tests/mdh-relative-time.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatTime } from '../src/mdh/relativeTime.js';

const NOW = Date.UTC(2026, 7, 28, 12, 0, 0);

afterEach(() => {
  vi.useRealTimers();
});

function at(now: number) {
  vi.useFakeTimers();
  vi.setSystemTime(now);
}

describe('formatTime', () => {
  it('says "just now" under a minute', () => {
    at(NOW);
    expect(formatTime(NOW - 30_000)).toBe('just now');
  });

  it('counts whole minutes under an hour', () => {
    at(NOW);
    expect(formatTime(NOW - 5 * 60_000)).toBe('5m ago');
  });

  it('counts whole hours under a day', () => {
    at(NOW);
    expect(formatTime(NOW - 3 * 3_600_000)).toBe('3h ago');
  });

  it('falls back to a locale date beyond a day', () => {
    at(NOW);
    const ts = NOW - 3 * 86_400_000;
    expect(formatTime(ts)).toBe(new Date(ts).toLocaleDateString());
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mdh-relative-time.test.ts`
Expected: FAIL — cannot resolve `../src/mdh/relativeTime.js`.

- [x] **Step 3: Create the module**

Create `src/mdh/relativeTime.ts`:

```ts
// One home for MDH's "how long ago" grammar. Moved verbatim out of
// QueryHistory's private formatTime when the Search Indexes panel became a third
// caller — UploadsPanel keeps its own, which formats operation durations at a
// finer resolution ("1h 20m ago") and is a different grammar, not a duplicate.
export function formatTime(ts: any): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}
```

- [x] **Step 4: Point QueryHistory at it**

In `src/mdh/components/QueryHistory.tsx`, delete the private function:

```tsx
function formatTime(ts: any) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}
```

and add to the import block at the top of the file:

```tsx
import { formatTime } from '../relativeTime.js';
```

- [x] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/mdh-relative-time.test.ts && npx vitest run tests/mdh-query-history.test.ts`
Expected: both PASS. A green `mdh-query-history` run is what proves the move was
behaviour-preserving.

- [x] **Step 6: Typecheck and stage**

```bash
npm run typecheck
git add src/mdh/relativeTime.ts src/mdh/components/QueryHistory.tsx tests/mdh-relative-time.test.ts
```

---

## Task 2: Three optional props on IndexCard

`IndexCard` is shared by the Search Indexes panel, the Indexes panel and the Stages view. All three
props default so that the other two callers are untouched.

**Files:**
- Modify: `src/mdh/components/IndexCard.tsx`
- Test: `tests/mdh-index-card.test.tsx` (new)

**Interfaces:**
- Consumes: nothing.
- Produces: `IndexCard` accepts `notice?: ComponentChildren`, `defaultExpanded?: boolean`
  (default `true`), `onEdit?: () => void`.

- [x] **Step 1: Write the failing test**

Create `tests/mdh-index-card.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';
import IndexCard from '../src/mdh/components/IndexCard.jsx';

vi.mock('../src/mdh/components/JsonEditor.jsx', () => ({
  default: () => <div class="json-editor-stub" />,
}));

function mount(node: any) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(node, root);
  return root;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('IndexCard new props', () => {
  it('starts expanded by default, so existing callers are unchanged', () => {
    const root = mount(<IndexCard name="x" definition={{ a: 1 }} />);
    expect(root.querySelector('.record-card-body')).not.toBeNull();
  });

  it('starts collapsed when defaultExpanded is false, and expands on click', () => {
    const root = mount(<IndexCard name="x" definition={{ a: 1 }} defaultExpanded={false} />);
    expect(root.querySelector('.record-card-body')).toBeNull();

    root.querySelector<HTMLElement>('.record-card-header')!.click();
    expect(root.querySelector('.record-card-body')).not.toBeNull();
  });

  it('renders a notice, visible while collapsed', () => {
    const root = mount(
      <IndexCard name="x" definition={{ a: 1 }} defaultExpanded={false} notice={<span>heads up</span>} />,
    );
    expect(root.querySelector('.record-card-body')).toBeNull();
    expect(root.querySelector('.record-card-notice')!.textContent).toContain('heads up');
  });

  it('renders no notice element when the prop is absent', () => {
    const root = mount(<IndexCard name="x" definition={{ a: 1 }} />);
    expect(root.querySelector('.record-card-notice')).toBeNull();
  });

  it('renders an Edit button only when onEdit is given, and calls it', () => {
    const onEdit = vi.fn();
    const bare = mount(<IndexCard name="x" definition={{ a: 1 }} />);
    expect(bare.querySelector('.action-edit')).toBeNull();

    const root = mount(<IndexCard name="x" definition={{ a: 1 }} onEdit={onEdit} />);
    root.querySelector<HTMLElement>('.action-edit')!.click();
    expect(onEdit).toHaveBeenCalledTimes(1);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mdh-index-card.test.tsx`
Expected: FAIL — `defaultExpanded`, `notice` and `onEdit` are rejected by `IntrinsicAttributes`
(JSX checks excess props that `h()` would accept), and `.record-card-notice` is not rendered.

- [x] **Step 3: Add the props**

In `src/mdh/components/IndexCard.tsx`, change the import line:

```tsx
import { h } from 'preact';
```

to:

```tsx
import { h } from 'preact';
import type { ComponentChildren } from 'preact';
```

Change the signature from:

```tsx
export default function IndexCard({
  name,
  badges = [],
  definition,
  canDrop,
  onDrop,
  cardClass,
  meta,
}: {
  name: string;
  badges?: any[];
  definition?: any;
  canDrop?: boolean;
  onDrop?: () => void;
  cardClass?: string;
  meta?: any;
}) {
  const [expanded, setExpanded] = useState(true);
```

to:

```tsx
export default function IndexCard({
  name,
  badges = [],
  definition,
  canDrop,
  onDrop,
  onEdit,
  cardClass,
  meta,
  notice,
  defaultExpanded = true,
}: {
  name: string;
  badges?: any[];
  definition?: any;
  canDrop?: boolean;
  onDrop?: () => void;
  onEdit?: () => void;
  cardClass?: string;
  meta?: any;
  // Rendered between header and body, and visible whether or not the card is
  // expanded — it carries state the reader must not have to open the card to see.
  notice?: ComponentChildren;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
```

Add the Edit button inside `.record-actions`, before the Copy button:

```tsx
        <span class="record-actions">
          {onEdit && (
            <button class="action-edit" onClick={onEdit}>
              Edit
            </button>
          )}
          {definition && (
```

Add the notice between the header `</div>` and the `{expanded && definition && ...}` block:

```tsx
      {notice && <div class="record-card-notice">{notice}</div>}
      {expanded && definition && (
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/mdh-index-card.test.tsx`
Expected: PASS — all five.

- [x] **Step 5: Prove the other two callers are unaffected**

Run: `npx vitest run tests/mdh-index-panel.test.tsx tests/mdh-search-index-panel.test.tsx`
Expected: PASS unchanged — that is the check that the three new props defaulted correctly.

- [x] **Step 6: Typecheck and stage**

```bash
npm run typecheck
git add src/mdh/components/IndexCard.tsx tests/mdh-index-card.test.tsx
```

---

## Task 3: The panel's new stylesheet rules

jsdom has no layout, so nothing here is unit-testable — the gate is that the built sheet parses
and the class-collision guard still passes.

**Files:**
- Modify: `src/console/console.css`

**Interfaces:**
- Consumes: nothing.
- Produces: the classes `toolbar-stack`, `toolbar-sync`, `dot`, `dot-work`, `action-edit`,
  `record-card-notice`, `record-card-notice-text`, `input-locked`.

- [x] **Step 1: Add the toolbar rules**

In `src/console/console.css`, immediately after the `.toolbar-group-disabled > *` rule (near
line 1003), insert:

```css
/* The Search Indexes toolbar stacks a collection-level sync line under its title.
   These live in the monolith rather than a CSS Module because every class this
   panel uses is global and lives here, and .toolbar-group is the existing
   precedent for a .toolbar child. */
.toolbar-stack {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.toolbar-sync {
  font-size: 11px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.toolbar-sync .dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--success);
  margin-right: 5px;
  vertical-align: 1px;
}
.toolbar-sync .dot-work {
  background: var(--warning-fg);
}
```

- [x] **Step 2: Add the card rules**

Immediately after the existing `.record-actions .action-delete:hover` rule, insert:

```css
.record-actions .action-edit {
  color: var(--accent);
}
/* A card-level statement the reader must not have to expand the card to see —
   currently "this index failed but the previous build is still serving". Sits on
   the body's surface so it reads as part of the card, not as a banner. */
.record-card-notice {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-top: 1px solid var(--border);
  background: var(--bg-code);
  font-size: 11.5px;
  color: var(--text-primary);
}
.record-card-notice-text {
  flex: 1;
}
/* The name field in the Edit Search Index modal: the name is the resource
   identity, so it is shown and not editable. */
.input-locked {
  background: var(--bg-hover);
  color: var(--text-secondary);
}
```

- [x] **Step 3: Verify formatting and the collision guard**

```bash
npm run format:check
npm run build
npx vitest run tests/css-class-collision-boundary.test.ts
```

Expected: `format:check` clean (if it reports `console.css`, run `npm run format` and re-run — see
CLAUDE.md on Prettier needing two passes on first formatting), build succeeds, guard PASSES.

- [x] **Step 4: Stage**

```bash
git add src/console/console.css
```

---

## Task 4: The core port — api.ts, searchIndexDef.ts, and every consumer

This is one task because the response shape changes atomically: `api.ts`, the transform, the panel,
the prefetcher and the agent context cannot be moved independently without leaving the tree red.

**Files:**
- Modify: `src/mdh/api.ts:331-369` (the three search-index functions and the `SearchIndexDefinition`
  type), plus a new `mdhRequest` helper beside `post`/`get`
- Rewrite: `src/mdh/searchIndexDef.ts`
- Modify: `src/mdh/components/SearchIndexPanel.tsx`
- Modify: `src/mdh/prefetch.ts:63-74`
- Modify: `src/mdh/agent/aiContext.ts:86-100`
- Test: `tests/mdh-api.test.ts`, `tests/mdh-search-index-def.test.ts` (rewrite),
  `tests/mdh-search-index-panel.test.tsx` (rewrite), `tests/mdh-prefetch.test.ts`,
  `tests/mdh-agent-context.test.ts`

**Interfaces:**
- Consumes: `IndexCard`'s existing props (Task 2's additions are not used yet).
- Produces:
  - `api.listSearchIndexes(collection, { signal }?) => Promise<SearchIndex[]>`
  - `api.putSearchIndex(collection, indexName, definition) => Promise<any>`
  - `api.deleteSearchIndex(collection, indexName) => Promise<any>`
  - `api.SearchIndex` type: `{ name, definition, queryable, status, latest_definition_version? }`
  - `searchIndexDef.toSearchIndexDefinition(idx) => Record<string, any>`
  - `searchIndexDef.statusBadge(status) => { text, cls, title } | null`

Note: `isTransitional` is declared **module-local** in this task. Task 6 exports it, when the
reconcile hook becomes its consumer — exporting it earlier would fail `tests/dead-code.test.ts`.

- [x] **Step 1: Write the failing api tests**

In `tests/mdh-api.test.ts`, replace these three rows of the `CRUD operations hit correct endpoints`
table:

```ts
      [() => api.listSearchIndexes('col'), '/search_indexes/list'],
      [
        () => api.createSearchIndex('col', { indexName: 'si', mappings: {} }),
        '/search_indexes/create',
      ],
      [() => api.dropSearchIndex('col', 'si'), '/search_indexes/drop'],
```

with:

```ts
      [
        () => api.listSearchIndexes('col'),
        '/svc/master-data-hub/api/v2/datasets/col/search_indexes',
      ],
```

and add a new `describe` block at the end of the file, before the closing `});`:

```ts
describe('search indexes on MDH V2', () => {
  it('lists with GET against the master-data-hub base and returns the bare array', async () => {
    fetchMock.mockResolvedValue(ok([{ name: 'default' }]));

    const rows = await api.listSearchIndexes('example');

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://example.rossum.app/svc/master-data-hub/api/v2/datasets/example/search_indexes',
    );
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
    expect(rows).toEqual([{ name: 'default' }]);
  });

  it('puts one index with the definition as the whole body and the name in the URL', async () => {
    fetchMock.mockResolvedValue(ok({ message: 'declared', type: 'info' }));

    await api.putSearchIndex('example', 'by_name', { mappings: { dynamic: true } });

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://example.rossum.app/svc/master-data-hub/api/v2/datasets/example/search_indexes/by_name',
    );
    expect(fetchMock.mock.calls[0][1].method).toBe('PUT');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ mappings: { dynamic: true } });
  });

  it('deletes one index with DELETE and no body', async () => {
    fetchMock.mockResolvedValue(ok({ message: 'deleted', type: 'info' }));

    await api.deleteSearchIndex('example', 'by_name');

    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
  });

  it('percent-encodes the collection and index names', async () => {
    fetchMock.mockResolvedValue(ok([]));

    await api.listSearchIndexes('a b');

    expect(fetchMock.mock.calls[0][0]).toContain('/datasets/a%20b/search_indexes');
  });

  it('surfaces the MDH {message,type} error body', async () => {
    fetchMock.mockResolvedValue(err(404, { message: "Dataset 'x' not found", type: 'error' }));

    await expect(api.listSearchIndexes('x')).rejects.toThrow("Dataset 'x' not found");
  });
});
```

- [x] **Step 2: Run the api tests to verify they fail**

Run: `npx vitest run tests/mdh-api.test.ts`
Expected: FAIL — `api.putSearchIndex` and `api.deleteSearchIndex` do not exist, and
`listSearchIndexes` still POSTs to the Data Storage path.

- [x] **Step 3: Add the MDH transport and the three functions**

In `src/mdh/api.ts`, add this helper immediately after the `get` function (after the block ending
around line 158):

```ts
// Master Data Hub V2 is a second service with a different envelope: REST verbs,
// a bare JSON body, and a {message, type} error shape rather than Data Storage's
// {code, message, result}. post()/get() are hard-wired to serviceBase and that
// envelope, so V2 needs its own helper. It deliberately does NOT attach an
// operationId — V2 writes return 202 with no operation to poll, and inventing one
// would be a lie (see hooks/useIndexReconcile.ts).
async function mdhRequest(
  method: string,
  path: string,
  body?: unknown,
  { signal: externalSignal }: RequestOpts = {},
): Promise<any> {
  const { signal, timer } = combinedSignal(externalSignal);
  let res: Response;
  try {
    res = await fetch(`${baseDomain}/svc/master-data-hub${path}`, {
      method,
      headers: {
        Authorization: authHeader,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === 'AbortError') {
      if (externalSignal?.aborted) throw err;
      throw new Error('Request timed out after 30s');
    }
    throw err;
  }
  clearTimeout(timer);
  if (res.status === 401) {
    throw apiError(
      'Session expired. Open a Rossum page and click Data Storage again to reconnect.',
      401,
    );
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw apiError(data?.message || `API error ${res.status}`, res.status);
  return data;
}
```

Then replace lines 331-369 — `listSearchIndexes`, the `SearchIndexDefinition` type,
`createSearchIndex` and `dropSearchIndex` — with:

```ts
function searchIndexPath(collectionName: string, indexName?: string): string {
  const base = `/api/v2/datasets/${encodeURIComponent(collectionName)}/search_indexes`;
  return indexName === undefined ? base : `${base}/${encodeURIComponent(indexName)}`;
}

/**
 * A search index as MDH V2 reports it: the registry declaration overlaid with the
 * live engine fields. `definition` is snake_case when a declaration exists and the
 * engine's own camelCase when the index exists only on the engine — both are valid
 * input to putSearchIndex, so neither needs converting.
 * `latest_definition_version` is absent between a PUT and the changelog write.
 */
export type SearchIndex = {
  name: string;
  definition: Record<string, any>;
  queryable: boolean;
  status: string;
  latest_definition_version?: { version: number; created_at?: string } | null;
};

export function listSearchIndexes(
  collectionName: string,
  { signal }: RequestOpts = {},
): Promise<SearchIndex[]> {
  return mdhRequest('GET', searchIndexPath(collectionName), undefined, { signal });
}

// Upsert: creates when the name is new, replaces the declaration when it is not.
// 202 with no operation id — the caller observes progress by re-reading the list.
export function putSearchIndex(
  collectionName: string,
  indexName: string,
  definition: Record<string, unknown>,
): Promise<any> {
  return mdhRequest('PUT', searchIndexPath(collectionName, indexName), definition);
}

export function deleteSearchIndex(collectionName: string, indexName: string): Promise<any> {
  return mdhRequest('DELETE', searchIndexPath(collectionName, indexName));
}
```

- [x] **Step 4: Run the api tests to verify they pass**

Run: `npx vitest run tests/mdh-api.test.ts`
Expected: PASS.

- [x] **Step 5: Write the failing searchIndexDef tests**

Replace the whole of `tests/mdh-search-index-def.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import { toSearchIndexDefinition, statusBadge } from '../src/mdh/searchIndexDef.js';

describe('toSearchIndexDefinition', () => {
  it('returns the definition object untouched — V2 already hands back create-ready input', () => {
    const definition = { mappings: { dynamic: false, fields: { name: { type: 'string' } } } };
    expect(toSearchIndexDefinition({ name: 'x', definition, status: 'READY', queryable: true })).toBe(
      definition,
    );
  });

  it('passes an engine-only camelCase definition through unchanged', () => {
    // An index that exists on the engine with no registry declaration comes back
    // in the engine's own casing. V2 accepts both, so nothing is renamed.
    const definition = {
      mappings: { dynamic: true },
      searchAnalyzer: 'lucene.standard',
      analyzers: [{ name: 'a', tokenizer: { type: 'whitespace' }, tokenFilters: [] }],
    };
    expect(toSearchIndexDefinition({ name: 'y', definition })).toBe(definition);
  });

  it('returns an empty object rather than throwing on junk', () => {
    expect(toSearchIndexDefinition(null)).toEqual({});
    expect(toSearchIndexDefinition('nope')).toEqual({});
    expect(toSearchIndexDefinition({ name: 'no-definition' })).toEqual({});
  });
});

describe('statusBadge', () => {
  it('maps READY to the ready class and renders it lowercase', () => {
    expect(statusBadge('READY')).toEqual({
      text: 'ready',
      cls: 'index-badge-ready',
      title: 'Built and queryable',
    });
  });

  it('renders the API value with underscores as spaces', () => {
    expect(statusBadge('PENDING_CREATE')!.text).toBe('pending create');
    expect(statusBadge('PENDING_UPDATE')!.text).toBe('pending update');
    expect(statusBadge('PENDING_DELETE')!.text).toBe('pending delete');
  });

  it('gives every transitional status the pending class and an explanatory title', () => {
    for (const s of ['PENDING_CREATE', 'PENDING_UPDATE', 'PENDING_DELETE', 'PENDING', 'BUILDING', 'DELETING']) {
      const badge = statusBadge(s)!;
      expect(badge.cls).toBe('index-badge-pending');
      expect(badge.title.length).toBeGreaterThan(0);
    }
  });

  it('treats FAILED and STALE as failed', () => {
    expect(statusBadge('FAILED')!.cls).toBe('index-badge-failed');
    expect(statusBadge('STALE')!.cls).toBe('index-badge-failed');
  });

  it('renders an unrecognised status neutrally rather than guessing', () => {
    const badge = statusBadge('SOMETHING_NEW')!;
    expect(badge.text).toBe('something new');
    expect(badge.cls).toBe('');
    expect(badge.title).toBe('');
  });

  it('returns null when there is no status', () => {
    expect(statusBadge(undefined)).toBeNull();
    expect(statusBadge('')).toBeNull();
  });
});
```

- [x] **Step 6: Run them to verify they fail**

Run: `npx vitest run tests/mdh-search-index-def.test.ts`
Expected: FAIL — the module still exports only `toCreateSearchIndexDefinition`.

- [x] **Step 7: Rewrite searchIndexDef.ts**

Replace the whole of `src/mdh/searchIndexDef.ts` with:

```ts
// Pure presentation logic for MDH V2 search indexes. The panel is a thin layer
// over these; none of them makes a request.

// V2's `definition` is already valid input to a PUT — a definition read back and
// fed straight to putSearchIndex round-trips (verified live), and an index that
// exists only on the engine comes back in the engine's camelCase, which V2 also
// accepts. So there is nothing left to convert: this is a guard, not a transform.
export function toSearchIndexDefinition(idx: any): Record<string, any> {
  if (!idx || typeof idx !== 'object') return {};
  const def = idx.definition;
  return def && typeof def === 'object' ? def : {};
}

// The registry can be ahead of the engine (PENDING_*), or the engine can be
// working (PENDING, BUILDING, DELETING). Anything else — including a status this
// build has never seen — counts as settled, so an unknown value can only stop the
// reconcile poll early, never spin it forever. DELETING is here even though it is
// absent from the OpenAPI enum, because the deprecated list emits it.
const TRANSITIONAL = new Set([
  'PENDING_CREATE',
  'PENDING_UPDATE',
  'PENDING_DELETE',
  'PENDING',
  'BUILDING',
  'DELETING',
]);

function isTransitionalStatus(status: any): boolean {
  return TRANSITIONAL.has(String(status || '').toUpperCase());
}

// The API's vocabulary is faithful but not self-explanatory, so the badge keeps
// the API's word and the tooltip carries the meaning — a badge and a support
// answer then use the same term.
const STATUS_TITLES: Record<string, string> = {
  PENDING_CREATE: 'Declared — the engine has not started building it yet',
  PENDING_UPDATE: 'A new definition is declared — the engine is still serving the previous one',
  PENDING_DELETE: 'Removed from the declaration — the engine is still dropping it',
  DELETING: 'Removed from the declaration — the engine is still dropping it',
  PENDING: 'Declared — waiting on the engine',
  BUILDING: 'The engine is building this index',
  READY: 'Built and queryable',
  FAILED: 'The engine rejected this definition',
  STALE: "The engine's index no longer matches the declaration",
};

export function statusBadge(status: any): { text: string; cls: string; title: string } | null {
  if (!status) return null;
  const upper = String(status).toUpperCase();
  const cls =
    upper === 'READY'
      ? 'index-badge-ready'
      : isTransitionalStatus(upper)
        ? 'index-badge-pending'
        : upper === 'FAILED' || upper === 'STALE'
          ? 'index-badge-failed'
          : '';
  return { text: upper.toLowerCase().replace(/_/g, ' '), cls, title: STATUS_TITLES[upper] || '' };
}
```

- [x] **Step 8: Run them to verify they pass**

Run: `npx vitest run tests/mdh-search-index-def.test.ts`
Expected: PASS.

- [x] **Step 9: Move prefetch and the agent context to the new shape**

In `src/mdh/prefetch.ts`, change:

```ts
    const res = await api.listSearchIndexes(collection, false, { signal });
    if (signal?.aborted) return;
    cache.set(collection, 'searchIndexes', res.result || []);
```

to:

```ts
    const rows = await api.listSearchIndexes(collection, { signal });
    if (signal?.aborted) return;
    cache.set(collection, 'searchIndexes', rows || []);
```

In `src/mdh/agent/aiContext.ts`, change the `summarizeSearchIndexes` body's definition lookup:

```ts
      const def = i.latest_definition || {};
```

to:

```ts
      const def = i.definition || {};
```

and change the call site around line 225:

```ts
    api
      .listSearchIndexes(collection)
      .then((r: any) => summarizeSearchIndexes(r?.result || r))
      .catch(() => []),
```

to:

```ts
    api
      .listSearchIndexes(collection)
      .then((rows: any) => summarizeSearchIndexes(rows))
      .catch(() => []),
```

- [x] **Step 10: Update their tests**

In `tests/mdh-prefetch.test.ts`, change both search-index mocks from the envelope to the array:

```ts
    vi.mocked(api.listSearchIndexes).mockResolvedValue({ result: [{ name: 'search1' }] });
```
becomes
```ts
    vi.mocked(api.listSearchIndexes).mockResolvedValue([{ name: 'search1' }] as any);
```

and
```ts
    vi.mocked(api.listSearchIndexes).mockResolvedValue({ result: [] });
```
becomes
```ts
    vi.mocked(api.listSearchIndexes).mockResolvedValue([]);
```

In `tests/mdh-agent-context.test.ts`, change the three `listSearchIndexes` stubs from
`vi.fn(async () => ({ result: [] }))` to `vi.fn(async () => [])`, and add a case proving the new
field is read — append inside the `getSchemaHints` describe:

```ts
  it('summarises search indexes from the V2 `definition` field', async () => {
    const api = {
      aggregate: vi.fn(async () => ({ result: [{}] })),
      listSearchIndexes: vi.fn(async () => [
        {
          name: 'by_name',
          status: 'READY',
          queryable: true,
          definition: { mappings: { dynamic: false, fields: { name: {}, city: {} } } },
        },
      ]),
    };
    const h = await getSchemaHints(api, 'c3', [{ name: 'a' }]);
    expect(h.searchIndexes).toEqual([{ name: 'by_name', fields: ['name', 'city'], synonyms: false }]);
  });
```

- [x] **Step 11: Move the panel to the new shape**

In `src/mdh/components/SearchIndexPanel.tsx`:

Change the imports — drop `useOperationStatus` and swap the transform:

```tsx
import { toCreateSearchIndexDefinition } from '../searchIndexDef.js';
import useOperationStatus from '../hooks/useOperationStatus.js';
```
becomes
```tsx
import { toSearchIndexDefinition, statusBadge } from '../searchIndexDef.js';
```

Remove the hook call from the component body:

```tsx
  const { track, clear } = useOperationStatus();
```

Change the load to take the bare array:

```tsx
      const res = await api.listSearchIndexes(collection, false);
      const result = res.result || [];
```
becomes
```tsx
      const result = await api.listSearchIndexes(collection);
```

Change the effect that called `clear()`:

```tsx
  useEffect(() => {
    clear();
    loadSearchIndexes();
  }, [selectedCollection.value, activePanel.value]);
```
becomes
```tsx
  useEffect(() => {
    loadSearchIndexes();
  }, [selectedCollection.value, activePanel.value]);
```

Replace the create-modal default template and submit handler. The template becomes definition-only:

```tsx
function defaultTemplate() {
  return JSON.stringify({ indexName: 'my_search_index', mappings: { dynamic: true } }, null, 2);
}
```
becomes
```tsx
function defaultTemplate() {
  return JSON.stringify({ mappings: { dynamic: true } }, null, 2);
}
```

Replace the whole `openCreateModal` function with a version carrying a separate name field:

```tsx
  function openCreateModal() {
    const editorRef: { current: JsonEditorHandle | null } = { current: null };

    openModal('Create Search Index', () => {
      const hintRef = useRef<HTMLDivElement | null>(null);
      const nameRef = useRef<HTMLInputElement | null>(null);

      async function handleCreate() {
        const indexName = (nameRef.current?.value || '').trim();
        if (!indexName) {
          if (hintRef.current) hintRef.current.textContent = 'A name is required';
          nameRef.current?.focus();
          return;
        }
        if (!editorRef.current?.isValid()) {
          if (hintRef.current) hintRef.current.textContent = 'Invalid JSON';
          return;
        }
        const definition = editorRef.current.getParsed();
        if (!definition || typeof definition !== 'object' || !definition.mappings) {
          if (hintRef.current) hintRef.current.textContent = 'The definition needs a "mappings" object';
          return;
        }

        try {
          loading.value = true;
          error.value = null;
          await api.putSearchIndex(selectedCollection.value as string, indexName, definition);
          cache.invalidate(selectedCollection.value as string, 'searchIndexes');
          loading.value = false;
          closeModal();
          loadSearchIndexes();
        } catch (err: any) {
          loading.value = false;
          if (hintRef.current) hintRef.current.textContent = err.message;
        }
      }

      return (
        <ModalBody>
          <ModalFieldLabel>Name</ModalFieldLabel>
          <input ref={nameRef} class="input" style="width:100%" placeholder="my_search_index" />
          <ModalFieldLabel style="margin-top:8px">Definition</ModalFieldLabel>
          <JsonEditor value={defaultTemplate()} minHeight="250px" editorRef={editorRef} />
          <div ref={hintRef} class="input-hint"></div>
          <ModalActions>
            <button class="btn btn-secondary" onClick={closeModal}>
              Cancel
            </button>
            <button class="btn btn-primary" onClick={handleCreate}>
              Create Search Index
            </button>
          </ModalActions>
        </ModalBody>
      );
    });
  }
```

Replace the drop handler:

```tsx
      const res = await api.dropSearchIndex(selectedCollection.value as string, indexName);
      cache.invalidate(selectedCollection.value as string, 'searchIndexes');
      loading.value = false;
      const opId = res.operationId;
      if (opId)
        track(opId, {
          label: `Dropping search index "${indexName}"`,
          onFinished: loadSearchIndexes,
        });
      else loadSearchIndexes();
```
with
```tsx
      await api.deleteSearchIndex(selectedCollection.value as string, indexName);
      cache.invalidate(selectedCollection.value as string, 'searchIndexes');
      loading.value = false;
      loadSearchIndexes();
```

Replace the whole badge-building block inside `indexes.map(...)`:

```tsx
            const badges = [];
            const status = isObj && idx.status ? String(idx.status).toUpperCase() : null;
            const isFailed = status === 'FAILED' || status === 'STALE';
            if (isObj && idx.status) {
              const cls =
                status === 'READY'
                  ? 'index-badge-ready'
                  : status === 'PENDING' || status === 'BUILDING'
                    ? 'index-badge-pending'
                    : isFailed
                      ? 'index-badge-failed'
                      : '';
              badges.push({ text: idx.status.toLowerCase(), cls });
            }
            if (isObj && idx.type) badges.push({ text: idx.type });
            if (isObj && idx.queryable === false)
              badges.push({ text: 'not queryable', cls: 'index-badge-warning' });
```
with
```tsx
            const badges = [];
            const badge = isObj ? statusBadge(idx.status) : null;
            const isFailed = badge?.cls === 'index-badge-failed';
            if (badge) badges.push(badge);
            if (isObj && idx.queryable === false)
              badges.push({ text: 'not queryable', cls: 'index-badge-warning' });
```

and change the card's definition prop:

```tsx
                definition={isObj ? toCreateSearchIndexDefinition(idx) : null}
```
to
```tsx
                definition={isObj ? toSearchIndexDefinition(idx) : null}
```

Finally, `IndexCard` must render the badge `title`. In `src/mdh/components/IndexCard.tsx`, change:

```tsx
          {badges.map(({ text, cls }) => (
            <span class={'index-badge' + (cls ? ' ' + cls : '')} style="margin-left:6px">
              {text}
            </span>
          ))}
```
to
```tsx
          {badges.map(({ text, cls, title }) => (
            <span
              class={'index-badge' + (cls ? ' ' + cls : '')}
              style="margin-left:6px"
              title={title || undefined}
            >
              {text}
            </span>
          ))}
```

- [x] **Step 12: Rewrite the panel test**

Replace `tests/mdh-search-index-panel.test.tsx`'s `listedIndex` fixture and the two Copy tests, and
update the badge tests:

```tsx
// A real V2 list item: `definition` rather than a `latest_definition` wrapper,
// runtime state alongside it, and a version record.
function listedIndex(overrides = {}) {
  return {
    name: 'default',
    status: 'READY',
    queryable: true,
    definition: { mappings: { dynamic: false, fields: { name: { type: 'string' } } } },
    latest_definition_version: { version: 0, created_at: '2026-08-28T11:16:21.756000' },
    ...overrides,
  };
}
```

Change every `vi.mocked(api.listSearchIndexes).mockResolvedValue({ result: [...] })` to
`vi.mocked(api.listSearchIndexes).mockResolvedValue([...] as any)`.

Replace the two tests in the `copy is create-ready` describe with:

```tsx
describe('SearchIndexPanel — copy is put-ready', () => {
  it('Copy puts the bare definition on the clipboard', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([listedIndex()] as any);
    const root = mount();

    await vi.waitFor(() => expect(root.querySelector('.action-copy')).not.toBeNull());
    root.querySelector<HTMLElement>('.action-copy')!.click();

    const expected = JSON.stringify(
      { mappings: { dynamic: false, fields: { name: { type: 'string' } } } },
      null,
      2,
    );
    expect(writeText).toHaveBeenCalledWith(expected);
  });

  it('copied JSON carries no runtime fields and no name', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([listedIndex()] as any);
    const root = mount();

    await vi.waitFor(() => expect(root.querySelector('.action-copy')).not.toBeNull());
    root.querySelector<HTMLElement>('.action-copy')!.click();

    const parsed = JSON.parse(writeText.mock.calls[0][0]);
    expect(parsed).not.toHaveProperty('status');
    expect(parsed).not.toHaveProperty('queryable');
    expect(parsed).not.toHaveProperty('name');
    expect(parsed).not.toHaveProperty('indexName');
    expect(parsed).not.toHaveProperty('latest_definition_version');
    expect(parsed).toHaveProperty('mappings');
  });
});
```

Add a describe covering the new badge behaviour:

```tsx
describe('SearchIndexPanel — V2 statuses', () => {
  function badgeTexts(root: any) {
    return [...root.querySelectorAll('.index-badge')].map((b) => b.textContent.toLowerCase());
  }

  it('renders PENDING_CREATE as "pending create" with an explanatory title', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([
      listedIndex({ status: 'PENDING_CREATE', queryable: false }),
    ] as any);
    const root = mount();

    await vi.waitFor(() => expect(root.querySelector('.index-badge')).not.toBeNull());
    expect(badgeTexts(root)).toContain('pending create');
    const badge = root.querySelector('.index-badge-pending')!;
    expect(badge.getAttribute('title')).toContain('engine');
  });

  it('shows no type badge — V2 has no type field', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([listedIndex()] as any);
    const root = mount();

    await vi.waitFor(() => expect(root.querySelector('.index-badge')).not.toBeNull());
    expect(badgeTexts(root)).not.toContain('search');
  });

  it('drops through deleteSearchIndex', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([listedIndex()] as any);
    vi.mocked(api.deleteSearchIndex).mockResolvedValue({ message: 'deleted', type: 'info' });
    const root = mount();

    await vi.waitFor(() => expect(root.querySelector('.action-delete')).not.toBeNull());
    root.querySelector<HTMLElement>('.action-delete')!.click();
    // confirmModal renders its confirm action as .btn-danger (src/ui/Modal.tsx).
    await vi.waitFor(() => expect(document.querySelector('.btn-danger')).not.toBeNull());
    document.querySelector<HTMLElement>('.btn-danger')!.click();

    await vi.waitFor(() => expect(api.deleteSearchIndex).toHaveBeenCalledWith('vendors', 'default'));
  });
});
```

- [x] **Step 13: Run the whole suite**

Run: `npm test`
Expected: PASS, including `tests/dead-code.test.ts` (proving no orphaned export remains from the
deleted Data Storage functions).

- [x] **Step 14: Typecheck and stage**

```bash
npm run typecheck
git add src/mdh/api.ts src/mdh/searchIndexDef.ts src/mdh/prefetch.ts src/mdh/agent/aiContext.ts \
        src/mdh/components/SearchIndexPanel.tsx src/mdh/components/IndexCard.tsx \
        tests/mdh-api.test.ts tests/mdh-search-index-def.test.ts \
        tests/mdh-search-index-panel.test.tsx tests/mdh-prefetch.test.ts \
        tests/mdh-agent-context.test.ts
```

---

## Task 5: Collapsed cards, coverage summary, version meta, failed notice

The card-level improvements from spec §6, §6a.1 and the still-serving notice.

**Files:**
- Modify: `src/mdh/searchIndexDef.ts` (add `summarizeDefinition`)
- Modify: `src/mdh/relativeTime.ts` (add `parseUtcTimestamp`)
- Modify: `src/mdh/components/SearchIndexPanel.tsx`
- Test: `tests/mdh-search-index-def.test.ts`, `tests/mdh-relative-time.test.ts`,
  `tests/mdh-search-index-panel.test.tsx`

**Interfaces:**
- Consumes: `IndexCard`'s `notice` and `defaultExpanded` props (Task 2); `formatTime` (Task 1);
  `statusBadge` (Task 4).
- Produces: `searchIndexDef.summarizeDefinition(definition) => string`;
  `relativeTime.parseUtcTimestamp(value) => number | null`.

- [x] **Step 1: Write the failing pure-function tests**

Append to `tests/mdh-relative-time.test.ts`:

```ts
import { parseUtcTimestamp } from '../src/mdh/relativeTime.js';

describe('parseUtcTimestamp', () => {
  it('treats an offset-less MDH timestamp as UTC, not local', () => {
    // V2 returns created_at with no timezone marker; verified live that the value
    // is UTC. Date.parse would read it as local time and be hours out.
    expect(parseUtcTimestamp('2026-08-28T11:16:21.756000')).toBe(
      Date.parse('2026-08-28T11:16:21.756Z'),
    );
  });

  it('respects an explicit Z or offset', () => {
    expect(parseUtcTimestamp('2026-08-28T11:16:21.756Z')).toBe(
      Date.parse('2026-08-28T11:16:21.756Z'),
    );
    expect(parseUtcTimestamp('2026-08-28T13:16:21.756+02:00')).toBe(
      Date.parse('2026-08-28T11:16:21.756Z'),
    );
  });

  it('returns null for anything unparseable', () => {
    expect(parseUtcTimestamp(null)).toBeNull();
    expect(parseUtcTimestamp('')).toBeNull();
    expect(parseUtcTimestamp('not a date')).toBeNull();
  });
});
```

Append to `tests/mdh-search-index-def.test.ts`:

```ts
import { summarizeDefinition } from '../src/mdh/searchIndexDef.js';

describe('summarizeDefinition', () => {
  it('says all fields for a purely dynamic mapping', () => {
    expect(summarizeDefinition({ mappings: { dynamic: true } })).toBe('dynamic — all fields');
  });

  it('counts explicit fields alongside a dynamic mapping', () => {
    expect(
      summarizeDefinition({ mappings: { dynamic: true, fields: { a: {}, b: {} } } }),
    ).toBe('dynamic + 2 fields');
  });

  it('names a single field in the singular', () => {
    expect(summarizeDefinition({ mappings: { dynamic: false, fields: { name: {} } } })).toBe(
      '1 field: name',
    );
  });

  it('names up to three fields and elides the rest', () => {
    expect(
      summarizeDefinition({
        mappings: { dynamic: false, fields: { a: {}, b: {}, c: {}, d: {} } },
      }),
    ).toBe('4 fields: a, b, c…');
  });

  it('returns an empty string when there is nothing to say', () => {
    expect(summarizeDefinition({})).toBe('');
    expect(summarizeDefinition(null)).toBe('');
    expect(summarizeDefinition({ mappings: { dynamic: false } })).toBe('');
  });
});
```

- [x] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/mdh-relative-time.test.ts tests/mdh-search-index-def.test.ts`
Expected: FAIL — neither `parseUtcTimestamp` nor `summarizeDefinition` exists.

- [x] **Step 3: Add parseUtcTimestamp**

Append to `src/mdh/relativeTime.ts`:

```ts
// MDH V2 returns `created_at` as UTC with NO offset marker
// ("2026-08-28T11:16:21.756000"), where the deprecated list returned the same
// instant as {"$date": "…Z"}. Date.parse reads an offset-less date-time as LOCAL
// time, so the bare string lands hours early and a card reads "just now" for the
// length of the UTC offset. Verified live 2026-08-28: the bare string matched the
// UTC wall clock to within the reconcile latency, not the local one.
export function parseUtcTimestamp(value: any): number | null {
  if (typeof value !== 'string' || !value) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  const ms = Date.parse(hasZone ? value : `${value}Z`);
  return Number.isNaN(ms) ? null : ms;
}
```

- [x] **Step 4: Add summarizeDefinition**

Append to `src/mdh/searchIndexDef.ts`:

```ts
// A one-line answer to "what does this index cover?", so a collapsed card still
// says which index is which. Built here rather than in JSX because \uXXXX does
// not work in JSX raw text.
const NAMED_FIELDS = 3;

export function summarizeDefinition(definition: any): string {
  const mappings = definition && typeof definition === 'object' ? definition.mappings : null;
  if (!mappings || typeof mappings !== 'object') return '';
  const fields =
    mappings.fields && typeof mappings.fields === 'object' ? Object.keys(mappings.fields) : [];
  const label = fields.length === 1 ? 'field' : 'fields';
  if (mappings.dynamic === true) {
    return fields.length ? `dynamic + ${fields.length} ${label}` : 'dynamic — all fields';
  }
  if (!fields.length) return '';
  const shown = fields.slice(0, NAMED_FIELDS).join(', ');
  return fields.length > NAMED_FIELDS
    ? `${fields.length} ${label}: ${shown}…`
    : `${fields.length} ${label}: ${shown}`;
}
```

- [x] **Step 5: Run them to verify they pass**

Run: `npx vitest run tests/mdh-relative-time.test.ts tests/mdh-search-index-def.test.ts`
Expected: PASS.

- [x] **Step 6: Write the failing panel tests**

Append to `tests/mdh-search-index-panel.test.tsx`:

```tsx
describe('SearchIndexPanel — card detail', () => {
  it('renders cards collapsed with a coverage summary in the header', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([listedIndex()] as any);
    const root = mount();

    await vi.waitFor(() => expect(root.querySelector('.record-summary')).not.toBeNull());
    expect(root.querySelector('.record-card-body')).toBeNull();
    expect(root.querySelector('.record-summary')!.textContent).toContain('1 field: name');
  });

  it('shows the version and when it was declared', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([
      listedIndex({ latest_definition_version: { version: 2, created_at: '2026-08-28T11:16:21.756000' } }),
    ] as any);
    const root = mount();

    await vi.waitFor(() => expect(root.querySelector('.index-card-meta')).not.toBeNull());
    expect(root.querySelector('.index-card-meta')!.textContent).toContain('v2');
    expect(root.querySelector('.index-card-meta')!.textContent).toContain('declared');
  });

  it('shows no meta while the version record has not been written yet', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([
      listedIndex({ status: 'PENDING_CREATE', latest_definition_version: undefined }),
    ] as any);
    const root = mount();

    await vi.waitFor(() => expect(root.querySelector('.record-summary')).not.toBeNull());
    expect(root.querySelector('.index-card-meta')).toBeNull();
  });

  it('says the previous version is still serving when a failed index is queryable', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([
      listedIndex({ status: 'FAILED', queryable: true, latest_definition_version: { version: 2 } }),
    ] as any);
    const root = mount();

    await vi.waitFor(() => expect(root.querySelector('.record-card-notice')).not.toBeNull());
    expect(root.querySelector('.record-card-notice')!.textContent).toContain('still serving');
  });

  it('adds no notice when a failed index is not queryable', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([
      listedIndex({ status: 'FAILED', queryable: false }),
    ] as any);
    const root = mount();

    await vi.waitFor(() => expect(root.querySelector('.record-summary')).not.toBeNull());
    expect(root.querySelector('.record-card-notice')).toBeNull();
  });
});
```

- [x] **Step 7: Run them to verify they fail**

Run: `npx vitest run tests/mdh-search-index-panel.test.tsx`
Expected: FAIL — cards render expanded, no summary, no meta, no notice.

- [x] **Step 8: Wire it into the panel**

In `src/mdh/components/SearchIndexPanel.tsx`, extend the imports:

```tsx
import { toSearchIndexDefinition, statusBadge, summarizeDefinition } from '../searchIndexDef.js';
import { formatTime, parseUtcTimestamp } from '../relativeTime.js';
```

Inside `indexes.map((idx) => { ... })`, after the badge block, add:

```tsx
            const definition = isObj ? toSearchIndexDefinition(idx) : null;
            const summary = definition ? summarizeDefinition(definition) : '';
            const ver = isObj ? idx.latest_definition_version : null;
            const declaredAt = ver ? parseUtcTimestamp(ver.created_at) : null;
            const meta = ver
              ? `v${ver.version}${declaredAt ? ` · declared ${formatTime(declaredAt)}` : ''}`
              : null;
            // FAILED does not mean down: a failed re-declaration leaves the
            // previous build serving, and `queryable` stays true. Say so, or the
            // red card reads as an outage.
            const stillServing = isObj && String(idx.status).toUpperCase() === 'FAILED' && idx.queryable;
            const notice = stillServing ? (
              <span class="record-card-notice-text">
                The engine rejected v{ver ? ver.version : '?'}. The previous version is still serving.
              </span>
            ) : null;
```

Change the `IndexCard` element to:

```tsx
              <IndexCard
                name={name}
                badges={badges}
                definition={definition}
                meta={meta}
                notice={notice}
                defaultExpanded={false}
                canDrop
                onDrop={() => doDropSearchIndex(name)}
                cardClass={(isFailed ? 'record-card-failed' : null) as string | undefined}
              />
```

Add the summary to the header. In `src/mdh/components/IndexCard.tsx` the summary slot is
`.record-summary`; pass the text through a new optional prop rather than reformatting the card.
Add to `IndexCard`'s props:

```tsx
  summary?: string;
```

and render it after the name, before the badges:

```tsx
          <strong>{name}</strong>
          {summary ? <span style="margin-left:8px">{summary}</span> : null}
```

Then pass `summary={summary}` on the `IndexCard` element in the panel.

- [x] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run tests/mdh-search-index-panel.test.tsx tests/mdh-index-card.test.tsx`
Expected: PASS.

- [x] **Step 10: Typecheck, full suite, stage**

```bash
npm run typecheck
npm test
git add src/mdh/relativeTime.ts src/mdh/searchIndexDef.ts \
        src/mdh/components/SearchIndexPanel.tsx src/mdh/components/IndexCard.tsx \
        tests/mdh-relative-time.test.ts tests/mdh-search-index-def.test.ts \
        tests/mdh-search-index-panel.test.tsx
```

---

## Task 6: The reconcile poll and the sync line

V2 writes return no operation id, so progress is observed by re-reading the list.

**Files:**
- Create: `src/mdh/hooks/useIndexReconcile.ts`
- Modify: `src/mdh/searchIndexDef.ts` (export `isTransitional`, add `syncSummary`)
- Modify: `src/mdh/components/SearchIndexPanel.tsx`
- Test: `tests/mdh-index-reconcile.test.tsx` (new), `tests/mdh-search-index-def.test.ts`,
  `tests/mdh-search-index-panel.test.tsx`

**Interfaces:**
- Consumes: `api.listSearchIndexes`, `cache.set`, `searchIndexDef.isTransitional`.
- Produces: `useIndexReconcile(onRows) => { watch(collection), stop() }`;
  `searchIndexDef.isTransitional(status) => boolean`;
  `searchIndexDef.syncSummary(rows, lastCheckedAt) => { text, working }`.

- [x] **Step 1: Write the failing pure-function test**

Append to `tests/mdh-search-index-def.test.ts`:

```ts
import { isTransitional, syncSummary } from '../src/mdh/searchIndexDef.js';

describe('isTransitional', () => {
  it('is true for every registry-ahead and engine-working status', () => {
    for (const s of ['PENDING_CREATE', 'PENDING_UPDATE', 'PENDING_DELETE', 'PENDING', 'BUILDING', 'DELETING']) {
      expect(isTransitional(s)).toBe(true);
    }
  });

  it('is false for terminal statuses and for anything unrecognised', () => {
    for (const s of ['READY', 'FAILED', 'STALE', 'SOMETHING_NEW', '', null, undefined]) {
      expect(isTransitional(s)).toBe(false);
    }
  });
});

describe('syncSummary', () => {
  const now = Date.now();

  it('says there are no indexes', () => {
    expect(syncSummary([], now).text).toBe('no indexes');
  });

  it('reports everything settled', () => {
    const out = syncSummary([{ status: 'READY' }, { status: 'FAILED' }], now);
    expect(out.text).toContain('2 indexes');
    expect(out.text).toContain('in sync');
    expect(out.working).toBe(false);
  });

  it('counts what is still moving', () => {
    const out = syncSummary([{ status: 'READY' }, { status: 'BUILDING' }, { status: 'PENDING_DELETE' }], now);
    expect(out.text).toContain('3 indexes');
    expect(out.text).toContain('2 in progress');
    expect(out.working).toBe(true);
  });

  it('uses the singular for one index', () => {
    expect(syncSummary([{ status: 'READY' }], now).text).toContain('1 index ·');
  });

  it('carries when it last looked', () => {
    expect(syncSummary([{ status: 'READY' }], now).text).toContain('checked just now');
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/mdh-search-index-def.test.ts`
Expected: FAIL — `isTransitional` is module-local and `syncSummary` does not exist.

- [x] **Step 3: Export isTransitional and add syncSummary**

In `src/mdh/searchIndexDef.ts`, change:

```ts
function isTransitionalStatus(status: any): boolean {
```
to
```ts
export function isTransitional(status: any): boolean {
```

and update its two internal uses (`isTransitionalStatus(upper)` becomes `isTransitional(upper)`).

Append:

```ts
import { formatTime } from './relativeTime.js';

// The collection-level answer the badges cannot give. V2 is the first version to
// separate "the registry is ahead" (PENDING_*) from "the engine is working"
// (BUILDING), so this line had no source before. "in progress" covers creating,
// updating, deleting and building alike — the dot beside it carries the urgency,
// and four different words for one idea would not help. The timestamp is the
// poll's own last-look time, never a claim about the engine.
export function syncSummary(
  rows: any[],
  lastCheckedAt: number | null,
): { text: string; working: boolean } {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return { text: 'no indexes', working: false };
  const moving = list.filter((r) => isTransitional(r?.status)).length;
  const count = `${list.length} ${list.length === 1 ? 'index' : 'indexes'}`;
  const state = moving ? `${moving} in progress` : 'in sync';
  const checked = lastCheckedAt ? ` · checked ${formatTime(lastCheckedAt)}` : '';
  return { text: `${count} · ${state}${checked}`, working: moving > 0 };
}
```

- [x] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/mdh-search-index-def.test.ts`
Expected: PASS.

- [x] **Step 5: Write the failing hook test**

Create `tests/mdh-index-reconcile.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';

vi.mock('../src/mdh/api.js');
import * as api from '../src/mdh/api.js';
import * as cache from '../src/mdh/cache.js';
import useIndexReconcile from '../src/mdh/hooks/useIndexReconcile.js';

function setup(onRows: (rows: any[]) => void) {
  let latest: any;
  const container = document.createElement('div');
  const Probe = () => {
    latest = useIndexReconcile(onRows);
    return null;
  };
  render(<Probe />, container);
  return { get: () => latest, unmount: () => render(null, container) };
}

beforeEach(() => {
  vi.clearAllMocks();
  cache.invalidateAll();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useIndexReconcile', () => {
  it('fetches once immediately and stops when nothing is transitional', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([{ name: 'a', status: 'READY' }] as any);
    const onRows = vi.fn();
    const probe = setup(onRows);

    probe.get().watch('example');
    await vi.advanceTimersByTimeAsync(0);
    expect(onRows).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.listSearchIndexes).toHaveBeenCalledTimes(1);
    probe.unmount();
  });

  it('keeps polling while an index is transitional, then stops on terminal', async () => {
    vi.mocked(api.listSearchIndexes)
      .mockResolvedValueOnce([{ name: 'a', status: 'PENDING_CREATE' }] as any)
      .mockResolvedValueOnce([{ name: 'a', status: 'BUILDING' }] as any)
      .mockResolvedValue([{ name: 'a', status: 'READY' }] as any);
    const onRows = vi.fn();
    const probe = setup(onRows);

    probe.get().watch('example');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.listSearchIndexes).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.listSearchIndexes).toHaveBeenCalledTimes(3);
    probe.unmount();
  });

  it('stops on an unrecognised status rather than polling forever', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([{ name: 'a', status: 'WAT' }] as any);
    const probe = setup(() => {});

    probe.get().watch('example');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.listSearchIndexes).toHaveBeenCalledTimes(1);
    probe.unmount();
  });

  it('writes each result into the cache so panel and cache never disagree', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([{ name: 'a', status: 'READY' }] as any);
    const probe = setup(() => {});

    probe.get().watch('example');
    await vi.advanceTimersByTimeAsync(0);
    expect(cache.get('example', 'searchIndexes')).toEqual([{ name: 'a', status: 'READY' }]);
    probe.unmount();
  });

  it('stop() prevents any further fetch', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([{ name: 'a', status: 'BUILDING' }] as any);
    const probe = setup(() => {});

    probe.get().watch('example');
    await vi.advanceTimersByTimeAsync(0);
    probe.get().stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.listSearchIndexes).toHaveBeenCalledTimes(1);
    probe.unmount();
  });

  it('a new watch abandons the previous collection', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([{ name: 'a', status: 'BUILDING' }] as any);
    const onRows = vi.fn();
    const probe = setup(onRows);

    probe.get().watch('first');
    await vi.advanceTimersByTimeAsync(0);
    probe.get().watch('second');
    await vi.advanceTimersByTimeAsync(0);

    const collections = vi.mocked(api.listSearchIndexes).mock.calls.map((c) => c[0]);
    expect(collections.slice(-1)[0]).toBe('second');
    probe.unmount();
  });
});
```

- [x] **Step 6: Run it to verify it fails**

Run: `npx vitest run tests/mdh-index-reconcile.test.tsx`
Expected: FAIL — cannot resolve `../src/mdh/hooks/useIndexReconcile.js`.

- [x] **Step 7: Write the hook**

Create `src/mdh/hooks/useIndexReconcile.ts`:

```ts
import { useEffect, useRef } from 'preact/hooks';
import * as api from '../api.js';
import * as cache from '../cache.js';
import { isTransitional } from '../searchIndexDef.js';

// MDH V2 writes return 202 with no operation id, so there is nothing to poll on
// the operation_status endpoint the way useOperationStatus does — progress is
// only visible in the resource itself. This re-reads the index list while any
// index is transitional and hands each result to the panel.
//
// Observed timings that set the constants: PENDING_CREATE at 0.7s, PENDING at
// 33s, READY at 55s; a delete disappeared after about 8s. The cap is a backstop,
// not an expectation.
const INTERVAL_MS = 2000;
const MAX_MS = 180_000;
const MAX_ERRORS = 3;

export default function useIndexReconcile(onRows: (rows: any[], checkedAt: number) => void) {
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function stop() {
    abortRef.current?.abort();
    abortRef.current = null;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }

  useEffect(() => stop, []);

  function watch(collection: string) {
    stop();
    if (!collection) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const started = Date.now();
    let errors = 0;

    const tick = async () => {
      if (controller.signal.aborted) return;
      try {
        const rows = await api.listSearchIndexes(collection, { signal: controller.signal });
        if (controller.signal.aborted) return;
        errors = 0;
        const list = Array.isArray(rows) ? rows : [];
        cache.set(collection, 'searchIndexes', list);
        onRows(list, Date.now());
        // Anything unrecognised counts as settled, so a future status can only
        // stop the poll early — never spin it forever.
        if (!list.some((r) => isTransitional(r?.status))) return;
      } catch {
        if (controller.signal.aborted) return;
        // A failed poll is not a failed reconcile. Retry a few times, then leave
        // whatever the panel last rendered — the badges are already honest and
        // the panel has a Refresh button.
        if (++errors >= MAX_ERRORS) return;
      }
      if (Date.now() - started > MAX_MS) return;
      timerRef.current = setTimeout(tick, INTERVAL_MS);
    };

    tick();
  }

  return { watch, stop };
}
```

- [x] **Step 8: Run it to verify it passes**

Run: `npx vitest run tests/mdh-index-reconcile.test.tsx`
Expected: PASS — all six.

- [x] **Step 9: Write the failing panel test for the sync line**

Append to `tests/mdh-search-index-panel.test.tsx`:

```tsx
describe('SearchIndexPanel — sync line', () => {
  it('reports the collection-level state under the title', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([
      listedIndex(),
      listedIndex({ name: 'other', status: 'BUILDING', queryable: false }),
    ] as any);
    const root = mount();

    await vi.waitFor(() => expect(root.querySelector('.toolbar-sync')).not.toBeNull());
    const text = root.querySelector('.toolbar-sync')!.textContent;
    expect(text).toContain('2 indexes');
    expect(text).toContain('1 in progress');
    expect(root.querySelector('.toolbar-sync .dot-work')).not.toBeNull();
  });

  it('shows a settled line with no work dot when everything is ready', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([listedIndex()] as any);
    const root = mount();

    await vi.waitFor(() => expect(root.querySelector('.toolbar-sync')).not.toBeNull());
    expect(root.querySelector('.toolbar-sync')!.textContent).toContain('in sync');
    expect(root.querySelector('.toolbar-sync .dot-work')).toBeNull();
  });
});
```

- [x] **Step 10: Run it to verify it fails**

Run: `npx vitest run tests/mdh-search-index-panel.test.tsx`
Expected: FAIL — there is no `.toolbar-sync` element.

- [x] **Step 11: Wire the hook and the line into the panel**

In `src/mdh/components/SearchIndexPanel.tsx`:

```tsx
import { toSearchIndexDefinition, statusBadge, summarizeDefinition, syncSummary } from '../searchIndexDef.js';
import useIndexReconcile from '../hooks/useIndexReconcile.js';
```

In the component body, replace the state declarations with:

```tsx
  const [indexes, setIndexes] = useState<any[]>([]);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const { watch, stop } = useIndexReconcile((rows, at) => {
    setIndexes(rows);
    setCheckedAt(at);
  });
```

In `loadSearchIndexes`, after `setIndexes(result)`, add `setCheckedAt(Date.now());`.

Change the effect to stop the previous poll on a collection or panel switch:

```tsx
  useEffect(() => {
    stop();
    loadSearchIndexes();
  }, [selectedCollection.value, activePanel.value]);
```

After a successful create or drop, replace `loadSearchIndexes();` with:

```tsx
          watch(selectedCollection.value as string);
```

Replace the toolbar title span:

```tsx
        <span style="flex:1;font-weight:500">Search Indexes (Atlas Search)</span>
```
with
```tsx
        <span class="toolbar-stack">
          <span style="font-weight:500">Search Indexes (Atlas Search)</span>
          {(() => {
            const sync = syncSummary(indexes, checkedAt);
            return (
              <span class="toolbar-sync">
                <span class={'dot' + (sync.working ? ' dot-work' : '')}></span>
                {sync.text}
              </span>
            );
          })()}
        </span>
```

- [x] **Step 12: Run the tests to verify they pass**

Run: `npx vitest run tests/mdh-search-index-panel.test.tsx`
Expected: PASS.

- [x] **Step 13: Typecheck, full suite, stage**

```bash
npm run typecheck
npm test
git add src/mdh/hooks/useIndexReconcile.ts src/mdh/searchIndexDef.ts \
        src/mdh/components/SearchIndexPanel.tsx \
        tests/mdh-index-reconcile.test.tsx tests/mdh-search-index-def.test.ts \
        tests/mdh-search-index-panel.test.tsx
```

---

## Task 7: Edit mode, paste tolerance, error trimming, slash guard

**Files:**
- Modify: `src/mdh/searchIndexDef.ts` (add `splitPastedDefinition`, `firstValidationLine`)
- Modify: `src/mdh/components/SearchIndexPanel.tsx`
- Test: `tests/mdh-search-index-def.test.ts`, `tests/mdh-search-index-panel.test.tsx`

**Interfaces:**
- Consumes: `api.putSearchIndex`, `IndexCard`'s `onEdit` prop (Task 2).
- Produces: `searchIndexDef.splitPastedDefinition(parsed) => { name: string | null; definition: any }`;
  `searchIndexDef.firstValidationLine(message) => string`.

- [x] **Step 1: Write the failing pure-function tests**

Append to `tests/mdh-search-index-def.test.ts`:

```ts
import { splitPastedDefinition, firstValidationLine } from '../src/mdh/searchIndexDef.js';

describe('splitPastedDefinition', () => {
  it('lifts a legacy indexName out of the body — V2 rejects it as an extra key', () => {
    expect(splitPastedDefinition({ indexName: 'by_name', mappings: { dynamic: true } })).toEqual({
      name: 'by_name',
      definition: { mappings: { dynamic: true } },
    });
  });

  it('lifts a name key the same way', () => {
    expect(splitPastedDefinition({ name: 'by_name', mappings: { dynamic: true } })).toEqual({
      name: 'by_name',
      definition: { mappings: { dynamic: true } },
    });
  });

  it('leaves a plain definition alone', () => {
    const parsed = { mappings: { dynamic: true }, storedSource: { include: ['a'] } };
    expect(splitPastedDefinition(parsed)).toEqual({ name: null, definition: parsed });
  });

  it('returns the input untouched when it is not an object', () => {
    expect(splitPastedDefinition(null)).toEqual({ name: null, definition: null });
  });
});

describe('firstValidationLine', () => {
  it('keeps only the first of many union-branch errors', () => {
    const message =
      "3 validation errors:\n  {'type': 'literal_error', 'loc': ('body', 'mappings'), 'msg': \"Input should be 'string'\"}\n  {'type': 'literal_error', 'loc': ('body', 'x'), 'msg': 'two'}\n  {'type': 'literal_error', 'loc': ('body', 'y'), 'msg': 'three'}";
    const out = firstValidationLine(message);
    expect(out).toContain('3 validation errors');
    expect(out).toContain("Input should be 'string'");
    expect(out).not.toContain('two');
    expect(out).not.toContain('three');
  });

  it('returns a message that is not shaped like a validation list unchanged', () => {
    expect(firstValidationLine("Dataset 'x' not found")).toBe("Dataset 'x' not found");
  });

  it('tolerates a non-string', () => {
    expect(firstValidationLine(undefined as any)).toBe('');
  });
});
```

- [x] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/mdh-search-index-def.test.ts`
Expected: FAIL — neither function exists.

- [x] **Step 3: Add both functions**

Append to `src/mdh/searchIndexDef.ts`:

```ts
// A body carrying `indexName` is a 422 (`extra_forbidden`) — the name lives in
// the URL now. Users have snippets copied from the build that emitted the flat
// shape, so lift the name out instead of rejecting the paste. Additive: it
// cannot refuse anything the strict form would accept.
export function splitPastedDefinition(parsed: any): { name: string | null; definition: any } {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { name: null, definition: parsed };
  }
  const { indexName, name, ...definition } = parsed;
  const lifted = typeof indexName === 'string' ? indexName : typeof name === 'string' ? name : null;
  return lifted ? { name: lifted, definition } : { name: null, definition: parsed };
}

// A rejected definition returns a string, not structured detail, holding one
// Python repr per Pydantic error — and one unsupported mapping type produces
// eight, because the type is reported against each union branch plus the top
// level. The first is representative and the count is already in the heading.
export function firstValidationLine(message: any): string {
  if (typeof message !== 'string') return '';
  const marker = message.indexOf('\n  {');
  if (marker === -1) return message;
  const second = message.indexOf('\n  {', marker + 1);
  return second === -1 ? message : message.slice(0, second);
}
```

- [x] **Step 4: Run them to verify they pass**

Run: `npx vitest run tests/mdh-search-index-def.test.ts`
Expected: PASS.

- [x] **Step 5: Write the failing panel tests**

Append to `tests/mdh-search-index-panel.test.tsx`:

```tsx
describe('SearchIndexPanel — edit', () => {
  it('Edit opens the modal with the name locked and the definition prefilled, and PUTs it', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([listedIndex()] as any);
    vi.mocked(api.putSearchIndex).mockResolvedValue({ message: 'declared', type: 'info' });
    const root = mount();

    await vi.waitFor(() => expect(root.querySelector('.action-edit')).not.toBeNull());
    root.querySelector<HTMLElement>('.action-edit')!.click();

    await vi.waitFor(() => expect(document.querySelector('.input')).not.toBeNull());
    const nameInput = document.querySelector<HTMLInputElement>('.input')!;
    expect(nameInput.value).toBe('default');
    expect(nameInput.readOnly).toBe(true);
    expect(nameInput.className).toContain('input-locked');

    document.querySelector<HTMLElement>('.btn-primary')!.click();
    await vi.waitFor(() =>
      expect(api.putSearchIndex).toHaveBeenCalledWith(
        'vendors',
        'default',
        expect.objectContaining({ mappings: expect.anything() }),
      ),
    );
  });

  it('offers Edit definition from the still-serving notice', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([
      listedIndex({ status: 'FAILED', queryable: true, latest_definition_version: { version: 2 } }),
    ] as any);
    const root = mount();

    await vi.waitFor(() => expect(root.querySelector('.record-card-notice')).not.toBeNull());
    const btn = root.querySelector<HTMLElement>('.record-card-notice .btn')!;
    expect(btn.textContent).toContain('Edit definition');
  });
});

describe('SearchIndexPanel — collections V2 cannot address', () => {
  it('explains a slash-named collection instead of making a request that 404s', async () => {
    selectedCollection.value = 'a/b';
    const root = mount();

    await vi.waitFor(() => expect(root.textContent).toContain('slash'));
    expect(api.listSearchIndexes).not.toHaveBeenCalled();
  });
});
```

- [x] **Step 6: Run them to verify they fail**

Run: `npx vitest run tests/mdh-search-index-panel.test.tsx`
Expected: FAIL — no Edit button, no slash guard.

- [x] **Step 7: Generalise the modal and add the guard**

In `src/mdh/components/SearchIndexPanel.tsx`:

Extend the imports:

```tsx
import {
  toSearchIndexDefinition,
  statusBadge,
  summarizeDefinition,
  syncSummary,
  splitPastedDefinition,
  firstValidationLine,
} from '../searchIndexDef.js';
```

Replace `openCreateModal` with a two-mode function:

```tsx
  function openIndexModal({
    mode,
    name: initialName = '',
    definition: initialDefinition,
  }: {
    mode: 'create' | 'edit';
    name?: string;
    definition?: any;
  }) {
    const editorRef: { current: JsonEditorHandle | null } = { current: null };
    const isEdit = mode === 'edit';
    const initialJson = JSON.stringify(initialDefinition ?? { mappings: { dynamic: true } }, null, 2);

    openModal(isEdit ? 'Edit Search Index' : 'Create Search Index', () => {
      const hintRef = useRef<HTMLDivElement | null>(null);
      const nameRef = useRef<HTMLInputElement | null>(null);

      async function handleSubmit() {
        if (!editorRef.current?.isValid()) {
          if (hintRef.current) hintRef.current.textContent = 'Invalid JSON';
          return;
        }
        const parsed = editorRef.current.getParsed();
        // A snippet copied from the build that emitted {indexName, mappings}
        // still pastes: the name is lifted out rather than sent in the body,
        // where V2 rejects it.
        const split = splitPastedDefinition(parsed);
        if (!isEdit && split.name && nameRef.current && !nameRef.current.value.trim()) {
          nameRef.current.value = split.name;
        }
        const indexName = (nameRef.current?.value || '').trim();
        if (!indexName) {
          if (hintRef.current) hintRef.current.textContent = 'A name is required';
          nameRef.current?.focus();
          return;
        }
        const definition = split.definition;
        if (!definition || typeof definition !== 'object' || !definition.mappings) {
          if (hintRef.current)
            hintRef.current.textContent = 'The definition needs a "mappings" object';
          return;
        }

        try {
          loading.value = true;
          error.value = null;
          await api.putSearchIndex(selectedCollection.value as string, indexName, definition);
          cache.invalidate(selectedCollection.value as string, 'searchIndexes');
          loading.value = false;
          closeModal();
          watch(selectedCollection.value as string);
        } catch (err: any) {
          loading.value = false;
          if (hintRef.current) hintRef.current.textContent = firstValidationLine(err.message);
        }
      }

      return (
        <ModalBody>
          <ModalFieldLabel>{isEdit ? 'Name (cannot be changed)' : 'Name'}</ModalFieldLabel>
          <input
            ref={nameRef}
            class={'input' + (isEdit ? ' input-locked' : '')}
            style="width:100%"
            placeholder="my_search_index"
            value={initialName}
            readOnly={isEdit}
          />
          <ModalFieldLabel style="margin-top:8px">Definition</ModalFieldLabel>
          <JsonEditor value={initialJson} minHeight="250px" editorRef={editorRef} />
          <div ref={hintRef} class="input-hint"></div>
          <ModalActions>
            <button class="btn btn-secondary" onClick={closeModal}>
              Cancel
            </button>
            <button class="btn btn-primary" onClick={handleSubmit}>
              {isEdit ? 'Save & rebuild' : 'Create Search Index'}
            </button>
          </ModalActions>
        </ModalBody>
      );
    });
  }
```

Update the toolbar's Create button:

```tsx
        <button class="btn btn-success btn-sm" onClick={() => openIndexModal({ mode: 'create' })}>
```

Inside the map, add the edit handler and give the notice its action:

```tsx
            const openEdit = () =>
              openIndexModal({ mode: 'edit', name, definition: definition || undefined });
            const notice = stillServing ? (
              <>
                <span class="record-card-notice-text">
                  The engine rejected v{ver ? ver.version : '?'}. The previous version is still
                  serving.
                </span>
                <button class="btn btn-sm" onClick={openEdit}>
                  Edit definition
                </button>
              </>
            ) : null;
```

and pass `onEdit={openEdit}` on the `IndexCard` element. Add `Fragment` to the preact import:

```tsx
import { h, Fragment } from 'preact';
```

Add the slash guard at the top of the returned JSX, before the toolbar:

```tsx
  const collectionName = (selectedCollection.value as string) || '';
  if (collectionName.includes('/')) {
    return (
      <div class="panel">
        <div style="padding:16px;color:var(--text-secondary);font-size:12px">
          Search indexes cannot be managed for a collection whose name contains a slash — the
          Master Data Hub API addresses the collection in the URL path.
        </div>
      </div>
    );
  }
```

**Careful:** that `—` is inside JSX raw text and will render as six literal characters. Write
the em dash as an expression instead:

```tsx
          Search indexes cannot be managed for a collection whose name contains a slash {'—'}{' '}
          the Master Data Hub API addresses the collection in the URL path.
```

Guard the loader too, so no request is made:

```tsx
  async function loadSearchIndexes() {
    const collection = selectedCollection.value as string;
    if (!collection || collection.includes('/')) return;
```

- [x] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run tests/mdh-search-index-panel.test.tsx`
Expected: PASS.

- [x] **Step 9: Typecheck, full suite, stage**

```bash
npm run typecheck
npm test
git add src/mdh/searchIndexDef.ts src/mdh/components/SearchIndexPanel.tsx \
        tests/mdh-search-index-def.test.ts tests/mdh-search-index-panel.test.tsx
```

---

## Task 8: Verification sweep

**Files:** none modified — this task only runs checks and reports.

- [x] **Step 1: Both type programs**

Run: `npm run typecheck`
Expected: no errors from either `tsconfig.json` (src) or `tsconfig.tests.json` (tests).

- [x] **Step 2: Full suite**

Run: `npm test`
Expected: all green, including `tests/dead-code.test.ts` and
`tests/css-class-collision-boundary.test.ts`.

- [x] **Step 3: Formatting**

Run: `npm run format:check`
Expected: clean. If it reports files, run `npm run format`, then run `format:check` **again** —
Prettier 3.9.6 is not idempotent on some member chains and a first format can need two passes.

- [x] **Step 4: Build, then prove the deprecated path no longer ships**

```bash
npm run build
grep -rn "data-storage/api/v1/search_indexes" dist/ || echo "OK: no Data Storage search-index path in dist/"
grep -rn "master-data-hub/api/v2/datasets" dist/console/console.js | head -3
```

Expected: the first grep prints the OK line (no match); the second shows the V2 path present in the
built bundle. `dist/` is gitignored — this is a check, not an artifact.

- [x] **Step 5: Confirm the shared card's other callers are untouched**

Run: `npx vitest run tests/mdh-hooks.test.tsx tests/mdh-operation-status.test.tsx`
Expected: PASS unchanged. `useOperationStatus` is still used by `IndexPanel` and must keep working
— only the Search Indexes panel stopped using it.

- [x] **Step 6: Stage nothing, report**

Report to the owner:
- the full `npm test` summary line (counts, not a claim),
- `npm run typecheck` and `npm run format:check` outcomes,
- the two grep results from Step 4,
- and that `dist/` was rebuilt, so the extension must be **reloaded in the browser** to pick the
  change up (tests run `src/`, the browser runs `dist/`).

Then **stop and wait**. Do not commit: the owner's standing rule is that a commit happens only when
they name it, and then as a single commit for the whole run with no `Co-Authored-By` trailer.

---

## Self-review notes

- **Spec coverage.** §3 transport → Task 4. §4 reconcile hook → Task 6. §5 `searchIndexDef` →
  Tasks 4/5/6/7. §6 panel (load, modal, card, badges, meta, notice, drop, slash guard) → Tasks 4,
  5, 7. §6a.1 collapsed cards + summary → Task 5. §6a.2 sync line → Task 6. §6a.3 edit → Task 7.
  §6a.4 stylesheet → Task 3. §7 other call sites → Task 4 (prefetch, aiContext), Tasks 2/5
  (IndexCard), Task 1 (QueryHistory). §8 tests → distributed, each beside its subject. §9
  backward compatibility is assertion-level and is covered by the `splitPastedDefinition`,
  camelCase-passthrough and slash-guard tests.
- **Deliberately not in any task:** hardening `operationIdFromResponse` to follow
  `content-location` for the other async flows (spec §3 records the reasoning and the residual
  risk), and anything from the wider MDH V2 surface (spec §10).
- **Naming consistency check.** `listSearchIndexes` / `putSearchIndex` / `deleteSearchIndex`,
  `toSearchIndexDefinition` / `summarizeDefinition` / `statusBadge` / `isTransitional` /
  `syncSummary` / `splitPastedDefinition` / `firstValidationLine`, `formatTime` /
  `parseUtcTimestamp`, `useIndexReconcile` with `{ watch, stop }` — each name is introduced in one
  task and used with the same spelling in every later task.
- **Export-before-consumer check.** `parseUtcTimestamp` (Task 5), `summarizeDefinition` (Task 5),
  `isTransitional` and `syncSummary` (Task 6), `splitPastedDefinition` and `firstValidationLine`
  (Task 7) are each introduced in the same task as their first consumer, so
  `tests/dead-code.test.ts` passes at every task boundary.
