# MDH Export → Import Round Trip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Dataset Management export importable again — restore the structure and BSON types that CSV, Excel and XML flatten into text, and stop the shape guard rejecting a collection's own export.

**Architecture:** Export flattens nested objects into dotted columns using one escaped path grammar. Import runs a layered restore whose first rule is the target collection's own sampled shape, falling back to structural JSON and then to opt-in heuristics. Both directions share `flatten.ts`, so the header set and the shape's path set can never disagree.

**Tech Stack:** TypeScript (types only — esbuild builds, `tsc --noEmit` checks), Preact + `@preact/signals`, Vitest + jsdom, MongoDB aggregation against Rossum Data Storage.

**Spec:** `docs/superpowers/specs/2026-08-24-mdh-export-import-round-trip-design.md` — read it first; every task argues from a numbered section of it.

## Global Constraints

- **Do NOT run `git commit` at any point.** This repo's owner commits; an agent stages and stops. Stage with `git add -A` at the end of each task so work is recoverable, and leave the commit to the owner. One commit covers the whole run, never a per-task stack.
- **No branches, no worktrees.** Work directly on `master`.
- **Never put customer data in a file, test, fixture or spec.** Every fixture in this plan is synthetic and stays that way.
- **Tests are `.test.js`, never `.tsx`.** Raw JSX in a `.test.js` breaks oxc — mount components with `h(Component, null)`. Follow `tests/mdh-import-confirm.test.js` for the pattern.
- **Any test touching `DOMParser`, `CompressionStream` or the DOM needs `// @vitest-environment jsdom` as the file's first line.**
- **TypeScript:** `strict: true`, `erasableSyntaxOnly` (no `enum`, no `namespace`, no parameter properties), class fields must be `declare`d. A `.ts` file here is JavaScript plus annotations.
- **JSX escapes:** `\uXXXX` does NOT work in JSX text or attribute values. Use `{'—'}`, a literal character, or an HTML entity in a text child.
- **No bare single-letter or two-letter class names in JSX** — minified CSS Modules names collide with them. `tests/css-class-collision-boundary.test.js` enforces it against the built stylesheet.
- **Component imports spell `.jsx` / `.js`** even though the files are `.tsx` / `.ts` — the bundler resolves it. Do not "fix" these.
- Run `npm test` at the end of every task. Run `npm run typecheck` at the end of every task that touches a `.ts`/`.tsx` file.
- `dist/` is what the browser loads. After Task 9, `npm run build` before anyone reloads the extension.

**Path grammar, used verbatim by every task (spec §4.2):**

```
encodeSegment: '\' -> '\\'  then  '.' -> '\.'
isOpaqueKey(key) = key.includes('.') || key.startsWith('$')     // never descended into
leaf value       = null | non-object | array | single-'$'-key object | {} | depth cap
MAX_DEPTH        = 5
```

---

### Task 1: `flatten.ts` — the path grammar

Spec §4.2. Pure, DOM-free, no network. Every later task imports from here; nothing else may define a path-joining or leaf rule.

**Files:**
- Create: `src/mdh/flatten.ts`
- Create: `tests/mdh-flatten.test.js`
- Modify: `src/mdh/importPlan.ts:1-6` (drop its private `isEjsonWrapper`, import the shared one)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `encodeSegment(key: string): string`
  - `decodeSegment(seg: string): string`
  - `joinPath(segments: string[]): string`
  - `splitPath(path: string): string[]`
  - `isOpaqueKey(key: string): boolean`
  - `isEjsonWrapper(v: any): boolean`
  - `flattenDoc(doc: any, opts?: { maxDepth?: number }): Record<string, any>`
  - `unflattenDoc(row: any): { doc: any; conflicts: string[] }`
  - `getByPath(doc: any, path: string): any`
  - `hasByPath(doc: any, path: string): boolean`

- [ ] **Step 1: Write the failing test**

Create `tests/mdh-flatten.test.js`:

```js
import { describe, it, expect } from 'vitest';
import {
  encodeSegment, joinPath, splitPath, isOpaqueKey, isEjsonWrapper,
  flattenDoc, unflattenDoc, getByPath, hasByPath,
} from '../src/mdh/flatten.js';
import { tokenizeCsv } from '../src/mdh/csv.js';

describe('path grammar', () => {
  it('is a no-op for ordinary keys', () => {
    expect(encodeSegment('address')).toBe('address');
    expect(joinPath(['address', 'city'])).toBe('address.city');
    expect(splitPath('address.city')).toEqual(['address', 'city']);
  });

  it('escapes a dot so a literal dotted key is distinguishable from nesting', () => {
    expect(joinPath(['a.b'])).toBe('a\\.b');
    expect(splitPath('a\\.b')).toEqual(['a.b']);
    expect(joinPath(['a', 'b'])).toBe('a.b');
    expect(splitPath('a.b')).toEqual(['a', 'b']);
    expect(joinPath(['a.b'])).not.toBe(joinPath(['a', 'b']));
  });

  it('escapes a backslash and round-trips it', () => {
    expect(joinPath(['a\\b'])).toBe('a\\\\b');
    expect(splitPath('a\\\\b')).toEqual(['a\\b']);
  });

  it('round-trips every segment through join then split', () => {
    for (const segs of [['a'], ['a', 'b'], ['a.b'], ['a\\b'], ['a.b', 'c'], ['x', 'y.z'], ['$k']]) {
      expect(splitPath(joinPath(segs))).toEqual(segs);
    }
  });
});

describe('isOpaqueKey', () => {
  it('is true for a dotted key and a $-prefixed key, false otherwise', () => {
    expect(isOpaqueKey('a.b')).toBe(true);
    expect(isOpaqueKey('$foo')).toBe(true);   // a field path would become '$$foo' — a VARIABLE
    expect(isOpaqueKey('address')).toBe(false);
    expect(isOpaqueKey('a\\b')).toBe(false);  // backslash is fine in a Mongo field path
  });
});

describe('isEjsonWrapper', () => {
  it('accepts a single-$-key object only', () => {
    expect(isEjsonWrapper({ $oid: 'x' })).toBe(true);
    expect(isEjsonWrapper({ $date: 'x' })).toBe(true);
    expect(isEjsonWrapper({ $date: 'x', y: 1 })).toBe(false);
    expect(isEjsonWrapper({ a: 1 })).toBe(false);
    expect(isEjsonWrapper([1])).toBe(false);
    expect(isEjsonWrapper(null)).toBe(false);
  });
});

describe('flattenDoc', () => {
  it('expands nested objects into dotted paths', () => {
    expect(flattenDoc({ a: { b: 1, c: 2 }, d: 3 })).toEqual({ 'a.b': 1, 'a.c': 2, d: 3 });
  });

  it('treats arrays, EJSON wrappers and empty objects as leaves', () => {
    expect(flattenDoc({ tags: ['x'], id: { $oid: 'h' }, at: { $date: 'i' }, empty: {} }))
      .toEqual({ tags: ['x'], id: { $oid: 'h' }, at: { $date: 'i' }, empty: {} });
  });

  it('escapes a literal dotted key instead of expanding it', () => {
    expect(flattenDoc({ 'a.b': 1 })).toEqual({ 'a\\.b': 1 });
  });

  it('never descends into an opaque key — its whole subtree is one leaf', () => {
    expect(flattenDoc({ a: { 'b.c': { d: 1 } } })).toEqual({ 'a.b\\.c': { d: 1 } });
    expect(flattenDoc({ a: { $foo: { d: 1 } } })).toEqual({ 'a.$foo': { d: 1 } });
  });

  it('stops at the depth cap and leaves the rest as one value', () => {
    const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } };
    expect(flattenDoc(deep, { maxDepth: 3 })).toEqual({ 'a.b.c': { d: { e: { f: 1 } } } });
  });
});

describe('unflattenDoc', () => {
  it('rebuilds nesting and is the inverse of flattenDoc', () => {
    for (const doc of [
      { a: { b: 1, c: 2 }, d: 3 },
      { 'a.b': 1 },
      { a: { 'b.c': { d: 1 } } },
      { tags: ['x'], id: { $oid: 'h' } },
      { 'a\\b': 1 },
    ]) {
      expect(unflattenDoc(flattenDoc(doc)).doc).toEqual(doc);
    }
  });

  it('reports a conflict and keeps the key literal rather than clobbering', () => {
    const both = unflattenDoc({ a: 1, 'a.b': 2 });
    expect(both.conflicts).toEqual(['a.b']);
    expect(both.doc).toEqual({ a: 1, 'a.b': 2 });

    const reversed = unflattenDoc({ 'a.b': 2, a: 1 });
    expect(reversed.conflicts).toEqual(['a']);
    expect(reversed.doc.a).toEqual({ b: 2 });   // the nested build wins; the scalar cannot overwrite it
  });
});

describe('getByPath / hasByPath', () => {
  it('reads through an encoded path', () => {
    const doc = { a: { b: 1 }, 'a.b': 2 };
    expect(getByPath(doc, 'a.b')).toBe(1);
    expect(getByPath(doc, 'a\\.b')).toBe(2);
    expect(getByPath(doc, 'a.zz')).toBe(undefined);
    expect(hasByPath(doc, 'a.b')).toBe(true);
    expect(hasByPath(doc, 'a.zz')).toBe(false);
  });

  it('distinguishes a stored undefined-like value from an absent path', () => {
    expect(hasByPath({ a: { b: null } }, 'a.b')).toBe(true);
    expect(getByPath({ a: { b: null } }, 'a.b')).toBe(null);
  });
});

describe('escaped headers survive the CSV tokenizer', () => {
  it('keeps a backslash intact even with escapeChar set', () => {
    const { rows } = tokenizeCsv('a\\.b,c\r\n1,2', { escapeChar: '\\' });
    expect(rows[0]).toEqual(['a\\.b', 'c']);   // escapeChar applies INSIDE quotes only
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/mdh-flatten.test.js`
Expected: FAIL — `Failed to resolve import "../src/mdh/flatten.js"`.

- [ ] **Step 3: Write the module**

Create `src/mdh/flatten.ts`:

```ts
// The ONE home for MDH's dotted-path grammar (CLAUDE.md: "One home per
// grammar"). Export flattens a document to dotted columns, import rebuilds it,
// and shape.ts derives its reference paths — all three must agree byte for
// byte or a column silently loses its data, so they all come from here.
//
// Escaping: a MongoDB field may literally be named "a.b", which would be
// indistinguishable from a nested {a:{b:…}} in a bare dotted header. So a
// segment is encoded '\' -> '\\' then '.' -> '\.', and split on UNESCAPED dots
// only. For a key with neither character — every ordinary key — encoding is a
// no-op and headers are unchanged.

export function encodeSegment(key: string): string {
  return String(key).split('\\').join('\\\\').split('.').join('\\.');
}

export function decodeSegment(seg: string): string {
  let out = '';
  for (let i = 0; i < seg.length; i++) {
    if (seg[i] === '\\' && i + 1 < seg.length) { out += seg[i + 1]; i += 1; continue; }
    out += seg[i];
  }
  return out;
}

export function joinPath(segments: string[]): string {
  return segments.map(encodeSegment).join('.');
}

export function splitPath(path: string): string[] {
  const out: string[] = [];
  let cur = '';
  const s = String(path);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { cur += c + s[i + 1]; i += 1; continue; }
    if (c === '.') { out.push(decodeSegment(cur)); cur = ''; continue; }
    cur += c;
  }
  out.push(decodeSegment(cur));
  return out;
}

// A key the discovery aggregation can never descend into, so the flattener must
// not either — the two must produce the same header set.
//   '.'  — Mongo's "$a.b" addresses a NESTED b, not a key named "a.b".
//   '$'  — a field path for "$foo" is "$$foo", which Mongo reads as a VARIABLE.
export function isOpaqueKey(key: string): boolean {
  return key.includes('.') || key.startsWith('$');
}

// A single-'$'-key object is an EJSON wrapper ({$oid}, {$date}, …) — a leaf,
// never a sub-document to walk into.
export function isEjsonWrapper(v: any): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const ks = Object.keys(v);
  return ks.length === 1 && ks[0].startsWith('$');
}

const MAX_DEPTH = 5;

function isLeafValue(v: any, depth: number, maxDepth: number): boolean {
  return v === null
    || typeof v !== 'object'
    || Array.isArray(v)
    || isEjsonWrapper(v)
    || Object.keys(v).length === 0
    || depth >= maxDepth;
}

// Document -> { encodedPath: leafValue }. Anything past the depth cap, plus any
// value under an opaque key, stays whole and is JSON-encoded by the caller's
// cell writer; the import's structural layer restores it, so the cap costs
// columns, never fidelity.
export function flattenDoc(doc: any, { maxDepth = MAX_DEPTH }: { maxDepth?: number } = {}): Record<string, any> {
  const out: Record<string, any> = {};
  const walk = (obj: any, prefix: string[], depth: number) => {
    for (const key of Object.keys(obj)) {
      const v = obj[key];
      const path = [...prefix, key];
      if (!isOpaqueKey(key) && !isLeafValue(v, depth, maxDepth)) walk(v, path, depth + 1);
      else out[joinPath(path)] = v;
    }
  };
  if (doc && typeof doc === 'object' && !Array.isArray(doc)) walk(doc, [], 1);
  return out;
}

const own = (o: any, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const isPlainObject = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);

// { encodedPath: value } -> nested document. A path that would have to overwrite
// an existing non-object (a file carrying both `a` and `a.b`) is kept literal
// instead, and named in `conflicts` so the caller can warn.
export function unflattenDoc(row: any): { doc: any; conflicts: string[] } {
  const doc: any = {};
  const conflicts: string[] = [];
  for (const rawKey of Object.keys(row || {})) {
    const segs = splitPath(rawKey);
    let cur = doc;
    let blocked = false;
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i] as string;
      if (!own(cur, s)) cur[s] = {};
      else if (!isPlainObject(cur[s])) { blocked = true; break; }
      cur = cur[s];
    }
    const last = segs[segs.length - 1] as string;
    if (!blocked && own(cur, last) && isPlainObject(cur[last])) blocked = true;
    if (blocked) { conflicts.push(rawKey); doc[rawKey] = row[rawKey]; continue; }
    cur[last] = row[rawKey];
  }
  return { doc, conflicts };
}

export function getByPath(doc: any, path: string): any {
  let cur = doc;
  for (const seg of splitPath(path)) {
    if (!isPlainObject(cur) || !own(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

export function hasByPath(doc: any, path: string): boolean {
  let cur = doc;
  for (const seg of splitPath(path)) {
    if (!isPlainObject(cur) || !own(cur, seg)) return false;
    cur = cur[seg];
  }
  return true;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/mdh-flatten.test.js`
Expected: PASS, all cases.

- [ ] **Step 5: Adopt the shared `isEjsonWrapper` in `importPlan.ts`**

`src/mdh/importPlan.ts` opens with its own copy of the same four-line rule. Delete lines 1-6 and import instead, so the leaf rule has one home:

```ts
import { isEjsonWrapper } from './flatten.js';
```

Leave everything else in that file alone — `collectFieldPaths` keeps its current semantics (spec §4.7 explains why the match-key picker is deliberately untouched).

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS. `tests/mdh-import-plan.test.js` must still be green — the rule is identical, only its location moved.

- [ ] **Step 7: Stage**

```bash
git add -A
```

Do NOT commit (see Global Constraints).

---

### Task 2: `shape.ts` — share the grammar, stop requiring optional paths

Spec §4.7 and §2.4. Two changes with one test file.

**Files:**
- Modify: `src/mdh/shape.ts:24-61` (`collectPaths`, `deriveShape`), `:79-125` (`validateAgainstShape`)
- Modify: `tests/mdh-shape.test.js`

**Interfaces:**
- Consumes: `joinPath` from Task 1.
- Produces: `deriveShape(docs) -> { paths: Map<string, Set<string>>, optionalPaths: string[] }` — note `uniform` is **removed**; `validateAgainstShape(docs, shape)` unchanged in signature.

- [ ] **Step 1: Write the failing tests**

Append to `tests/mdh-shape.test.js`:

```js
describe('optional paths are not required (spec §2.4)', () => {
  it('a row missing a field that only some existing records carry is NOT missing', () => {
    const shape = deriveShape([{ sku: 'A1', note: 'x' }, { sku: 'B2' }]); // note is optional
    const r = validateAgainstShape([{ sku: 'C3' }], shape);
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it('a field present in EVERY existing record is still required', () => {
    const shape = deriveShape([{ sku: 'A1', note: 'x' }, { sku: 'B2', note: 'y' }]);
    const r = validateAgainstShape([{ sku: 'C3' }], shape);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['note']);
  });

  it('an optional path still type-checks when the row DOES carry it', () => {
    const shape = deriveShape([{ sku: 'A1', n: 1 }, { sku: 'B2' }]);
    expect(validateAgainstShape([{ sku: 'C3', n: 'not-a-number' }], shape).ok).toBe(false);
  });
});

describe('path grammar (spec §4.2)', () => {
  it('tells a literal dotted key apart from real nesting', () => {
    const nested = deriveShape([{ a: { b: 1 } }]);
    const literal = deriveShape([{ 'a.b': 1 }]);
    expect([...nested.paths.keys()]).toEqual(['a.b']);
    expect([...literal.paths.keys()]).toEqual(['a\\.b']);
    expect(validateAgainstShape([{ 'a.b': 1 }], nested).ok).toBe(false);
    expect(validateAgainstShape([{ a: { b: 1 } }], literal).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/mdh-shape.test.js`
Expected: FAIL — the first test reports `missing: ['note']`, and the grammar test reports both paths as `a.b`.

- [ ] **Step 3: Share the grammar in `collectPaths`**

In `src/mdh/shape.ts`, add the import and replace the path join:

```ts
import { joinPath } from './flatten.js';
```

```ts
function collectPaths(obj: any, prefix: string, out: Map<string, string>): Map<string, string> {
  for (const key of Object.keys(obj)) {
    if (!prefix && IGNORED.has(key)) continue;
    const path = prefix ? `${prefix}.${joinPath([key])}` : joinPath([key]);
    const t = typeOf(obj[key]);
    if (t === 'object') collectPaths(obj[key], path, out);
    else out.set(path, t);
  }
  return out;
}
```

- [ ] **Step 4: Drop `uniform` from `deriveShape`**

It has exactly one consumer — the "may over-reject" note in `ImportConfirm.tsx`, which Task 9 removes because the over-rejection it warned about is what this task fixes. Leaving it computed-but-unread is the dead code this repo just spent a commit removing. Replace the tail of `deriveShape`:

```ts
  const total = list.length;
  const optionalPaths = [...presence.entries()].filter(([, c]) => c < total).map(([p]) => p);
  return { paths, optionalPaths };
```

Delete the now-orphaned `uniform` comment block above it (the one explaining nullable-vs-optional) and the `const uniform = …` expression.

- [ ] **Step 5: Exempt optional paths in `validateAgainstShape`**

```ts
  const refPaths = shape?.paths || new Map();
  const optional = new Set<string>(shape?.optionalPaths || []);
  const list = Array.isArray(docs) ? docs : [];

  for (const doc of list) {
    let bad = false;
    const dp = (doc && typeof doc === 'object') ? collectPaths(doc, '', new Map()) : new Map();
    for (const [path] of refPaths) {
      // A field only SOME existing records carry cannot be "missing" from a row —
      // requiring it made a non-uniform collection reject its own export (§2.4).
      if (!dp.has(path) && !optional.has(path)) { missing.add(path); bad = true; }
    }
```

The rest of the loop is unchanged.

- [ ] **Step 6: Update the existing `uniform` assertions**

In `tests/mdh-shape.test.js`, three assertions reference the removed property. Rewrite each to assert `optionalPaths`, which is the fact that actually matters now:

```js
    expect(s.optionalPaths).toEqual([]);                 // was: expect(s.uniform).toBe(true)
```

```js
    expect(s.optionalPaths.length).toBeGreaterThan(0);   // was: expect(s.uniform).toBe(false)
```

For the nullable case (`type ∪ null`), the point is that a nullable column is NOT optional:

```js
    expect(s.optionalPaths).toEqual([]);   // string|null is present everywhere → not optional
```

Also update the two test names containing "uniform" to say what they now check.

- [ ] **Step 7: Run tests and typecheck**

Run: `npx vitest run tests/mdh-shape.test.js && npm run typecheck`
Expected: PASS. `npm test` will still fail in `tests/mdh-import-confirm.test.js` — two tests there assert the over-rejection note that Task 9 removes. That is expected; note it and continue.

- [ ] **Step 8: Stage**

```bash
git add -A
```

---

### Task 3: `restoreValues.ts` — the layered restore

Spec §4.1, §4.3. Pure, DOM-free, no network. This is the heart of the fix.

**Files:**
- Create: `src/mdh/restoreValues.ts`
- Create: `tests/mdh-restore-values.test.js`

**Interfaces:**
- Consumes: `unflattenDoc`, `splitPath`, `encodeSegment`, `isEjsonWrapper` (Task 1); `inferValue` from `src/mdh/csv.ts`; the `deriveShape` result from Task 2.
- Produces:
  - `restoreDocs(docs: any[], shape: any | null, opts?: { inferTypes?: boolean }): { docs: any[]; summary: RestoreSummary }`
  - `formatRestoreSummary(summary: RestoreSummary, ctx: { hasShape: boolean; shapeError?: boolean }): string | null`
  - `type RestoreSummary = { nestedColumns: number; json: number; dates: number; oids: number; numbers: number; bools: number; arrays: number; dropped: number; nulled: number; warnings: string[] }`

- [ ] **Step 1: Write the failing test**

Create `tests/mdh-restore-values.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { restoreDocs, formatRestoreSummary } from '../src/mdh/restoreValues.js';
import { deriveShape } from '../src/mdh/shape.js';

const one = (docs, shape, opts) => restoreDocs(docs, shape, opts).docs[0];

describe('layer 0 — un-dotting', () => {
  it('rebuilds nesting from dotted headers', () => {
    expect(one([{ 'a.b': '1', 'a.c': '2' }], null)).toEqual({ a: { b: '1', c: '2' } });
  });

  it('keeps a literal dotted key literal', () => {
    expect(one([{ 'a\\.b': '1' }], null)).toEqual({ 'a.b': '1' });
  });

  it('counts un-dotted columns once for the file, not once per row', () => {
    const { summary } = restoreDocs([{ 'a.b': '1' }, { 'a.b': '2' }], null);
    expect(summary.nestedColumns).toBe(1);
  });
});

describe('layer 1 — the collection decides', () => {
  const shape = deriveShape([{
    name: 'x', at: { $date: '2026-01-31T09:00:00.000Z' }, ref: { $oid: '000000000000000000000001' },
    n: 1, ok: true, tags: ['a'], code: '123456',
  }]);

  it('restores a date, an ObjectId, a number and a boolean', () => {
    const d = one([{ name: 'y', at: '2026-02-01T00:00:00.000Z', ref: '0000000000000000000000ff', n: '42', ok: 'true', tags: '["p","q"]', code: '999' }], shape);
    expect(d.at).toEqual({ $date: '2026-02-01T00:00:00.000Z' });
    expect(d.ref).toEqual({ $oid: '0000000000000000000000ff' });
    expect(d.n).toBe(42);
    expect(d.ok).toBe(true);
    expect(d.tags).toEqual(['p', 'q']);
  });

  it('NEVER converts a path the collection calls a string', () => {
    const d = one([{ name: '{"looks":"like json"}', at: '2026-02-01T00:00:00.000Z', ref: 'x', n: '1', ok: 'true', tags: '[]', code: '123456' }], shape);
    expect(d.name).toBe('{"looks":"like json"}');
    expect(d.code).toBe('123456');
  });

  it('wraps a scalar into an array when the collection says array (the XML case)', () => {
    expect(one([{ tags: 'solo' }], deriveShape([{ tags: ['a'] }]))).toEqual({ tags: ['solo'] });
  });

  it('leaves a value that does not match the expected form alone, for the guard to report', () => {
    expect(one([{ at: 'not-a-date' }], deriveShape([{ at: { $date: 'i' } }]))).toEqual({ at: 'not-a-date' });
  });

  it('has no opinion when the collection shows more than one non-null type', () => {
    const mixed = deriveShape([{ v: 1 }, { v: 'text' }]);
    expect(one([{ v: '2026-02-01T00:00:00.000Z' }], mixed)).toEqual({ v: '2026-02-01T00:00:00.000Z' });
  });
});

describe('empty cells', () => {
  it('drops the key when the collection says the path is optional', () => {
    const shape = deriveShape([{ sku: 'A', note: 'x' }, { sku: 'B' }]);
    expect(one([{ sku: 'C', note: '' }], shape)).toEqual({ sku: 'C' });
    expect(restoreDocs([{ sku: 'C', note: '' }], shape).summary.dropped).toBe(1);
  });

  it('becomes null on a required non-string path, where "" cannot be the value', () => {
    const shape = deriveShape([{ n: 1 }]);
    expect(one([{ n: '' }], shape)).toEqual({ n: null });
  });

  it('stays "" on a required string path', () => {
    expect(one([{ s: '' }], deriveShape([{ s: 'x' }]))).toEqual({ s: '' });
  });
});

describe('layers 2 and 3 — only where the collection has no opinion', () => {
  it('parses a JSON cell with no shape at all', () => {
    expect(one([{ a: '{"b":1}' }], null)).toEqual({ a: { b: 1 } });
    expect(one([{ a: '["x"]' }], null)).toEqual({ a: ['x'] });
  });

  it('leaves non-JSON text alone unless inference is opted into', () => {
    expect(one([{ n: '42' }], null)).toEqual({ n: '42' });
    expect(one([{ n: '42' }], null, { inferTypes: true })).toEqual({ n: 42 });
  });

  it('restores EJSON that survived JSON-encoding inside a legacy cell', () => {
    const shape = deriveShape([{ a: { at: { $date: 'i' } } }]);
    expect(one([{ a: '{"at":{"$date":"2026-02-01T00:00:00.000Z"}}' }], shape))
      .toEqual({ a: { at: { $date: '2026-02-01T00:00:00.000Z' } } });
  });

  it('ORDERING: the collection outranks inference — a known-string path survives it', () => {
    const shape = deriveShape([{ code: '000123' }]);
    expect(one([{ code: '123456' }], shape, { inferTypes: true })).toEqual({ code: '123456' });
  });
});

describe('conflicts', () => {
  it('warns instead of clobbering when a file carries both a and a.b', () => {
    const { summary } = restoreDocs([{ a: '1', 'a.b': '2' }], null);
    expect(summary.warnings.join(' ')).toMatch(/could not be nested/i);
  });
});

describe('formatRestoreSummary', () => {
  const empty = { nestedColumns: 0, json: 0, dates: 0, oids: 0, numbers: 0, bools: 0, arrays: 0, dropped: 0, nulled: 0, warnings: [] };

  it('is null when nothing was restored, so a clean import stays silent', () => {
    expect(formatRestoreSummary(empty, { hasShape: true })).toBe(null);
  });

  it('names each category and says it matched the collection', () => {
    const s = formatRestoreSummary({ ...empty, nestedColumns: 9, arrays: 1, dates: 1 }, { hasShape: true });
    expect(s).toMatch(/9 nested columns/);
    expect(s).toMatch(/1 array/);
    expect(s).toMatch(/1 date/);
    expect(s).toMatch(/to match the collection/);
  });

  it('explains why types were left as text when there is no shape', () => {
    expect(formatRestoreSummary({ ...empty, nestedColumns: 9 }, { hasShape: false }))
      .toMatch(/collection is empty, so value types were left as text/);
    expect(formatRestoreSummary({ ...empty, nestedColumns: 9 }, { hasShape: false, shapeError: true }))
      .toMatch(/couldn.t read the collection.s types/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/mdh-restore-values.test.js`
Expected: FAIL — `Failed to resolve import "../src/mdh/restoreValues.js"`.

- [ ] **Step 3: Write the module**

Create `src/mdh/restoreValues.ts`:

```ts
import { unflattenDoc, splitPath, encodeSegment, isEjsonWrapper } from './flatten.js';
import { inferValue } from './csv.js';

// Rebuild what a flat-format export flattened into text (spec §4.1).
//
// The ordering rule, and the reason it is not the obvious one: if a
// JSON-looking cell were parsed BEFORE consulting the target collection, a
// column the collection calls a string but which happens to hold JSON text
// would silently become an object — precisely the corruption the shape check
// exists to catch. So the collection's own sampled shape decides first,
// INCLUDING when it says "this is a string", and the heuristics only run where
// it has no opinion at all.

export type RestoreSummary = {
  nestedColumns: number; json: number; dates: number; oids: number;
  numbers: number; bools: number; arrays: number; dropped: number; nulled: number;
  warnings: string[];
};

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
const OID_RE = /^[0-9a-fA-F]{24}$/;
const DROP = Symbol('drop');

const isPlainObject = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);
const childPath = (prefix: string, key: string) => (prefix ? `${prefix}.${encodeSegment(key)}` : encodeSegment(key));

// The collection's opinion about a path: a single non-null type, or none.
// A set with >1 real type is a genuinely mixed column — no opinion.
function soleType(types: Set<string> | undefined): string | null {
  if (!types) return null;
  const real = [...types].filter((t) => t !== 'null');
  return real.length === 1 ? (real[0] as string) : null;
}

function tryJson(s: string, kind: 'object' | 'array' | 'any'): any {
  const t = s.trim();
  if (t[0] !== '{' && t[0] !== '[') return undefined;
  let v;
  try { v = JSON.parse(t); } catch { return undefined; }
  if (v === null || typeof v !== 'object') return undefined;
  if (kind === 'object' && Array.isArray(v)) return undefined;
  if (kind === 'array' && !Array.isArray(v)) return undefined;
  return v;
}

type Ctx = {
  paths: Map<string, Set<string>>;
  optional: Set<string>;
  inferTypes: boolean;
  hit: Record<string, Set<string>>;
};

function restoreNode(value: any, path: string, ctx: Ctx): any {
  // A plain sub-document is never a leaf — walk it so its own leaves get restored.
  if (isPlainObject(value) && !isEjsonWrapper(value)) {
    const out: any = {};
    for (const key of Object.keys(value)) {
      const r = restoreNode(value[key], childPath(path, key), ctx);
      if (r !== DROP) out[key] = r;
    }
    return out;
  }
  return restoreLeaf(value, path, ctx);
}

function restoreLeaf(value: any, path: string, ctx: Ctx): any {
  const types = ctx.paths.get(path);
  const want = soleType(types);

  // Empty cell. The export writes one both for an absent field and for a stored
  // null, so on an optional path dropping the key is the reading that does not
  // invent data (spec §4.3).
  if (value === '' || value === null) {
    if (types && ctx.optional.has(path)) { ctx.hit.dropped.add(path); return DROP; }
    if (types && value === '' && want && want !== 'string') { ctx.hit.nulled.add(path); return null; }
    return value;
  }

  if (want && typeof value === 'string') {
    if (want === 'string') return value;                       // the whole point
    if (want === 'object') {
      const p = tryJson(value, 'object');
      if (p !== undefined) { ctx.hit.json.add(path); return restoreNode(p, path, ctx); }
      return value;
    }
    if (want === 'array') {
      const p = tryJson(value, 'array');
      if (p !== undefined) { ctx.hit.json.add(path); return p; }
      ctx.hit.arrays.add(path); return [value];                // XML's 1-element collapse
    }
    if (want === 'date' && ISO_RE.test(value)) { ctx.hit.dates.add(path); return { $date: value }; }
    if (want === 'objectId' && OID_RE.test(value)) { ctx.hit.oids.add(path); return { $oid: value }; }
    if (want === 'number') {
      const n = inferValue(value);
      if (typeof n === 'number') { ctx.hit.numbers.add(path); return n; }
    }
    if (want === 'bool' && (value === 'true' || value === 'false')) {
      ctx.hit.bools.add(path); return value === 'true';
    }
    return value;   // disagrees with the collection — leave it; the guard reports it
  }

  if (want === 'array' && !Array.isArray(value)) { ctx.hit.arrays.add(path); return [value]; }
  if (want) return value;

  // No opinion: structural JSON, then opted-in inference.
  if (typeof value === 'string') {
    const p = tryJson(value, 'any');
    if (p !== undefined) {
      ctx.hit.json.add(path);
      return Array.isArray(p) ? p : restoreNode(p, path, ctx);
    }
    if (ctx.inferTypes) {
      const v = inferValue(value);
      if (v !== value) {
        if (typeof v === 'number') ctx.hit.numbers.add(path); else ctx.hit.bools.add(path);
        return v;
      }
    }
  }
  return value;
}

export function restoreDocs(
  docs: any[], shape: any | null, { inferTypes = false }: { inferTypes?: boolean } = {},
): { docs: any[]; summary: RestoreSummary } {
  const ctx: Ctx = {
    paths: shape?.paths || new Map(),
    optional: new Set<string>(shape?.optionalPaths || []),
    inferTypes,
    hit: {
      nested: new Set(), json: new Set(), dates: new Set(), oids: new Set(),
      numbers: new Set(), bools: new Set(), arrays: new Set(),
      dropped: new Set(), nulled: new Set(),
    },
  };
  const conflicts = new Set<string>();
  const list = Array.isArray(docs) ? docs : [];

  const out = list.map((d) => {
    if (!d || typeof d !== 'object' || Array.isArray(d)) return d;
    for (const rawKey of Object.keys(d)) {
      if (splitPath(rawKey).length > 1) ctx.hit.nested.add(rawKey);
    }
    const { doc, conflicts: c } = unflattenDoc(d);
    for (const k of c) conflicts.add(k);
    return restoreNode(doc, '', ctx);
  });

  const warnings: string[] = [];
  if (conflicts.size > 0) {
    warnings.push(`${conflicts.size} column(s) could not be nested because a conflicting field exists: ${[...conflicts].slice(0, 5).join(', ')}.`);
  }

  return {
    docs: out,
    summary: {
      nestedColumns: ctx.hit.nested.size, json: ctx.hit.json.size,
      dates: ctx.hit.dates.size, oids: ctx.hit.oids.size,
      numbers: ctx.hit.numbers.size, bools: ctx.hit.bools.size,
      arrays: ctx.hit.arrays.size, dropped: ctx.hit.dropped.size,
      nulled: ctx.hit.nulled.size, warnings,
    },
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// One sentence naming what changed, or null when nothing did — a clean import
// stays silent, the same silent-pass/loud-fail rule the shape check follows.
export function formatRestoreSummary(
  summary: RestoreSummary, { hasShape, shapeError = false }: { hasShape: boolean; shapeError?: boolean },
): string | null {
  const parts: string[] = [];
  if (summary.nestedColumns) parts.push(plural(summary.nestedColumns, 'nested column'));
  if (summary.json) parts.push(plural(summary.json, 'JSON value'));
  if (summary.arrays) parts.push(plural(summary.arrays, 'array'));
  if (summary.dates) parts.push(plural(summary.dates, 'date'));
  if (summary.oids) parts.push(plural(summary.oids, 'ObjectId'));
  if (summary.numbers) parts.push(plural(summary.numbers, 'number'));
  if (summary.bools) parts.push(plural(summary.bools, 'boolean'));
  if (summary.dropped) parts.push(`${plural(summary.dropped, 'empty field')} dropped`);
  if (parts.length === 0) return null;

  const list = parts.length === 1
    ? parts[0]
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;

  if (hasShape) return `Restored ${list} to match the collection.`;
  if (shapeError) return `Restored ${list} · couldn’t read the collection’s types, so values were left as text.`;
  return `Restored ${list} · collection is empty, so value types were left as text.`;
}
```

> Note: `·` and `’` are inside ordinary string literals here, not JSX text — that is the one place the escape form works (CLAUDE.md, "JSX escape sequences").

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/mdh-restore-values.test.js`
Expected: PASS, all cases including the ORDERING test.

- [ ] **Step 5: Typecheck and stage**

Run: `npm run typecheck`

```bash
git add -A
```

---

### Task 4: `columnDiscovery.ts` — exhaustive deep leaf paths

Spec §4.4. The export's header must be the EXACT union of leaf paths; a missing leaf is silently dropped data, so this cannot be sampled.

**Files:**
- Create: `src/mdh/columnDiscovery.ts`
- Create: `tests/mdh-column-discovery.test.js`
- Modify: `src/mdh/csv.ts` (remove `buildColumnDiscoveryPipeline` and its export)
- Modify: `src/mdh/downloadCollection.ts:44-67` (CSV serializer `init`)
- Modify: `src/mdh/xlsxWrite.ts:277-300` (XLSX serializer `start`)
- Modify: `src/mdh/components/ExportWizard.tsx:8` and `:104-118`
- Modify: `tests/mdh-csv-export.test.js` (delete the old pipeline test)

**Interfaces:**
- Consumes: `joinPath`, `splitPath`, `isOpaqueKey` (Task 1).
- Produces:
  - `MAX_DISCOVERY_DEPTH: number` (5)
  - `buildLevelPipeline(filterStages: any[], parents: string[]): any[]`
  - `discoverLeafPaths(collectionName: string, filterStages: any[], opts: { aggregate: (c: string, p: any[], o?: any) => Promise<any>; maxDepth?: number; signal?: AbortSignal }): Promise<string[]>`

- [ ] **Step 1: Write the failing test**

Create `tests/mdh-column-discovery.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { buildLevelPipeline, discoverLeafPaths, MAX_DISCOVERY_DEPTH } from '../src/mdh/columnDiscovery.js';

describe('buildLevelPipeline', () => {
  it('facets the root with a $cond guard and positional keys', () => {
    expect(buildLevelPipeline([{ $match: { active: true } }], [''])).toEqual([
      { $match: { active: true } },
      {
        $facet: {
          f0: [
            { $project: { kv: { $cond: [{ $eq: [{ $type: '$$ROOT' }, 'object'] }, { $objectToArray: '$$ROOT' }, []] } } },
            { $unwind: '$kv' },
            { $group: { _id: '$kv.k', types: { $addToSet: { $type: '$kv.v' } } } },
          ],
        },
      },
    ]);
  });

  it('uses positional facet keys because a $facet key cannot contain a dot', () => {
    const p = buildLevelPipeline([{ $match: {} }], ['address', 'id']);
    expect(Object.keys(p[1].$facet)).toEqual(['f0', 'f1']);
    expect(JSON.stringify(p)).toContain('"$address"');
    expect(JSON.stringify(p)).toContain('"$id"');
  });

  it('turns an encoded parent path back into a Mongo field path', () => {
    const p = buildLevelPipeline([{ $match: {} }], ['a.b']);
    expect(JSON.stringify(p)).toContain('"$a.b"');
  });
});

describe('discoverLeafPaths', () => {
  const level = (byParent) => ({ result: [byParent] });

  it('walks one level per depth and returns the exact leaf union', async () => {
    const aggregate = vi.fn()
      .mockResolvedValueOnce(level({ f0: [
        { _id: '_id', types: ['objectId'] },
        { _id: 'name', types: ['string'] },
        { _id: 'address', types: ['object'] },
      ] }))
      .mockResolvedValueOnce(level({ f0: [
        { _id: 'city', types: ['string'] },
        { _id: 'line', types: ['array'] },
      ] }));

    const paths = await discoverLeafPaths('c', [{ $match: {} }], { aggregate });
    expect(paths.sort()).toEqual(['_id', 'address.city', 'address.line', 'name']);
    expect(aggregate).toHaveBeenCalledTimes(2);
  });

  it('emits a path that is an object in some records and a scalar in others as BOTH', async () => {
    const aggregate = vi.fn()
      .mockResolvedValueOnce(level({ f0: [{ _id: 'v', types: ['object', 'string'] }] }))
      .mockResolvedValueOnce(level({ f0: [{ _id: 'inner', types: ['int'] }] }));

    const paths = await discoverLeafPaths('c', [{ $match: {} }], { aggregate });
    expect(paths.sort()).toEqual(['v', 'v.inner']);
  });

  it('never descends into an opaque key — it becomes a leaf instead', async () => {
    const aggregate = vi.fn().mockResolvedValueOnce(level({ f0: [
      { _id: 'a.b', types: ['object'] },
      { _id: '$weird', types: ['object'] },
    ] }));

    const paths = await discoverLeafPaths('c', [{ $match: {} }], { aggregate });
    expect(paths.sort()).toEqual(['$weird', 'a\\.b']);
    expect(aggregate).toHaveBeenCalledTimes(1);   // no second level attempted
  });

  it('stops at the depth cap and emits what is still pending as a leaf', async () => {
    const aggregate = vi.fn().mockResolvedValue(level({ f0: [{ _id: 'k', types: ['object'] }] }));
    const paths = await discoverLeafPaths('c', [{ $match: {} }], { aggregate, maxDepth: 2 });
    expect(paths).toEqual(['k.k']);
    expect(aggregate).toHaveBeenCalledTimes(2);
  });

  it('caps at MAX_DISCOVERY_DEPTH by default', () => {
    expect(MAX_DISCOVERY_DEPTH).toBe(5);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/mdh-column-discovery.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

Create `src/mdh/columnDiscovery.ts`:

```ts
import { joinPath, splitPath, isOpaqueKey } from './flatten.js';

// Exhaustive discovery of the leaf paths an export's header must carry.
//
// Why not one clever recursive pipeline: MongoDB has no recursive
// $objectToArray. Why not a sample: a leaf missing from the header is data
// silently dropped from the file. So we walk one level per round trip, batching
// every parent at that level into a single $facet — typically 1-3 calls for
// real master data, and it terminates on its own when no object-valued key is
// left.

export const MAX_DISCOVERY_DEPTH = 5;

// A pending parent never holds an opaque segment (see isOpaqueKey), so every
// one of its segments is dot-free and splitPath(p).join('.') is exactly its
// Mongo field path. That invariant is what makes this substitution safe.
function fieldExpr(parent: string): string {
  return parent === '' ? '$$ROOT' : '$' + splitPath(parent).join('.');
}

export function buildLevelPipeline(filterStages: any[], parents: string[]): any[] {
  const facet: Record<string, any[]> = {};
  parents.forEach((p, i) => {
    const expr = fieldExpr(p);
    facet[`f${i}`] = [
      // $objectToArray errors on a non-document, and a path can hold an array or
      // a scalar in some records — the guard is required, not defensive.
      { $project: { kv: { $cond: [{ $eq: [{ $type: expr }, 'object'] }, { $objectToArray: expr }, []] } } },
      { $unwind: '$kv' },
      { $group: { _id: '$kv.k', types: { $addToSet: { $type: '$kv.v' } } } },
    ];
  });
  return [...filterStages, { $facet: facet }];
}

export async function discoverLeafPaths(
  collectionName: string,
  filterStages: any[],
  { aggregate, maxDepth = MAX_DISCOVERY_DEPTH, signal }: {
    aggregate: (c: string, p: any[], o?: any) => Promise<any>;
    maxDepth?: number;
    signal?: AbortSignal;
  },
): Promise<string[]> {
  const leaves = new Set<string>();
  let parents = [''];

  for (let depth = 1; depth <= maxDepth && parents.length > 0; depth++) {
    const res = await aggregate(collectionName, buildLevelPipeline(filterStages, parents), { signal });
    const facet = res?.result?.[0] || {};
    const next: string[] = [];

    parents.forEach((p, i) => {
      for (const row of (facet[`f${i}`] || [])) {
        const key = row?._id;
        if (typeof key !== 'string') continue;
        const path = p === '' ? joinPath([key]) : `${p}.${joinPath([key])}`;
        const types: string[] = Array.isArray(row.types) ? row.types : [];
        const opaque = isOpaqueKey(key);
        const objectOnly = types.length === 1 && types[0] === 'object';

        if (types.includes('object') && !opaque && depth < maxDepth) next.push(path);
        if (!objectOnly || opaque || depth >= maxDepth) leaves.add(path);
      }
    });

    parents = next;
  }

  return [...leaves];
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/mdh-column-discovery.test.js`
Expected: PASS.

- [ ] **Step 5: Delete the old single-shot pipeline and rewire its three callers**

In `src/mdh/csv.ts`, delete `buildColumnDiscoveryPipeline` entirely (the function and its comment block).

In `src/mdh/downloadCollection.ts`, change the import and `init`:

```ts
import { csvHeader, csvRow, orderColumns } from './csv.js';
import { discoverLeafPaths } from './columnDiscovery.js';
```

```ts
    async init({ collectionName, pipelineStages }: { collectionName: string; pipelineStages: any[] }) {
      if (cols != null) return;
      cols = orderColumns(await discoverLeafPaths(collectionName, pipelineStages, { aggregate: api.aggregate }));
    },
```

In `src/mdh/xlsxWrite.ts`, the same two edits:

```ts
import { orderColumns } from './csv.js';
import { discoverLeafPaths } from './columnDiscovery.js';
```

```ts
      if (cols == null) {
        cols = orderColumns(await discoverLeafPaths(collectionName, pipelineStages, { aggregate: api.aggregate }));
      }
```

In `src/mdh/components/ExportWizard.tsx`, replace the import on line 8 and the discovery effect body:

```ts
import { discoverLeafPaths } from '../columnDiscovery.js';
```

```ts
    discoverLeafPaths(collection, stages, { aggregate: api.aggregate, signal: controller.signal })
      .then(async (paths) => {
        const sampleDocs = await (samplePromiseRef.current || Promise.resolve({ result: [] })).then((s: any) => s.result || []).catch(() => []);
        if (alive) setCols({ loading: false, value: orderExportColumns([...(recordsSample || []), ...sampleDocs], paths) });
      })
```

- [ ] **Step 6: Delete the superseded pipeline test**

In `tests/mdh-csv-export.test.js`, delete the whole `describe('buildColumnDiscoveryPipeline', …)` block and drop `buildColumnDiscoveryPipeline` from the import on line 2. Its replacement lives in `tests/mdh-column-discovery.test.js`.

- [ ] **Step 7: Repair the export tests' aggregate stubs**

`tests/mdh-download-collection.test.js`, `tests/mdh-download-xlsx.test.js` and `tests/mdh-export-wizard.test.js` mock `api.aggregate`. Discovery now issues one call per level and reads `result[0].fN`, so any stub that previously answered the discovery call with `{ result: [{ keys: [...] }] }` must answer with:

```js
{ result: [{ f0: [{ _id: 'name', types: ['string'] }, { _id: '_id', types: ['objectId'] }] }] }
```

Tests that pass an explicit `columns` array never reach discovery (`cols != null` short-circuits) and need no change. Run the three files, read each failure, and fix only the stubs — do not change what the tests assert about batching, ordering or cancellation.

- [ ] **Step 8: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: everything green except the two `tests/mdh-import-confirm.test.js` over-rejection tests from Task 2, which Task 9 fixes.

- [ ] **Step 9: Stage**

```bash
git add -A
```

---

### Task 5: Export writes dotted columns

Spec §4.5 and §4.4's ordering paragraph. Discovery now yields leaf paths; the writers must look values up by path or every dotted column comes out empty.

**Files:**
- Modify: `src/mdh/csv.ts` (`csvRow`)
- Modify: `src/mdh/xlsxWrite.ts` (`writeDocs`)
- Modify: `src/mdh/recordColumns.ts:27-33` (`orderExportColumns`)
- Modify: `src/mdh/components/ExportWizard.tsx:171-174` (preview grid)
- Modify: `tests/mdh-csv-export.test.js`, `tests/mdh-record-columns.test.js`

**Interfaces:**
- Consumes: `flattenDoc`, `splitPath` (Task 1); leaf paths from Task 4.
- Produces: no signature changes — `csvRow(doc, columns, dialect)` and `orderExportColumns(loaded, discovered)` keep their shapes.

- [ ] **Step 1: Write the failing tests**

Append to `tests/mdh-csv-export.test.js`:

```js
describe('csvRow with dotted columns', () => {
  it('reads a nested value by its dotted path', () => {
    const doc = { _id: 'x', address: { city: 'TOWN', line: ['PO BOX 1'] } };
    expect(csvRow(doc, ['_id', 'address.city', 'address.line'], { delimiter: ',' }))
      .toBe('x,TOWN,"[""PO BOX 1""]"');
  });

  it('leaves a column the document lacks empty', () => {
    expect(csvRow({ a: { b: 1 } }, ['a.b', 'a.c'], { delimiter: ',' })).toBe('1,');
  });

  it('reads a literal dotted key through its escaped header', () => {
    expect(csvRow({ 'a.b': 7 }, ['a\\.b'], { delimiter: ',' })).toBe('7');
  });
});
```

Append to `tests/mdh-record-columns.test.js`:

```js
describe('orderExportColumns with leaf paths', () => {
  it('groups leaves under their parent, in the table column order', () => {
    const loaded = [{ _id: '1', name: 'a', address: { city: 'X' } }];
    const discovered = ['address.line', '_id', 'address.city', 'name'];
    expect(orderExportColumns(loaded, discovered))
      .toEqual(['_id', 'name', 'address.city', 'address.line']);
  });

  it('appends leaves whose parent is not in the table, alphabetically', () => {
    const loaded = [{ _id: '1', name: 'a' }];
    const discovered = ['zeta.b', '_id', 'name', 'alpha.a'];
    expect(orderExportColumns(loaded, discovered))
      .toEqual(['_id', 'name', 'alpha.a', 'zeta.b']);
  });

  it('groups by the DECODED first segment, so a literal dotted key is its own root', () => {
    const loaded = [{ 'a.b': 1, a: { c: 2 } }];
    expect(orderExportColumns(loaded, ['a.c', 'a\\.b'])).toEqual(['a\\.b', 'a.c']);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/mdh-csv-export.test.js tests/mdh-record-columns.test.js`
Expected: FAIL — `csvRow` returns empty cells for dotted columns; `orderExportColumns` sorts every dotted path into the alphabetical tail.

- [ ] **Step 3: Make `csvRow` path-aware**

In `src/mdh/csv.ts`, add the import and rewrite the function:

```ts
import { flattenDoc } from './flatten.js';
```

```ts
// Join one document's column values into a CSV row. Columns are leaf PATHS
// (see columnDiscovery.ts), so the document is flattened by the same rule that
// produced the header — a missing path is an empty cell.
export function csvRow(doc: any, columns: string[], dialect: CsvDialect = {}): string {
  const delimiter = dialect.delimiter || ',';
  const flat = doc == null ? {} : flattenDoc(doc);
  return columns.map((c) => csvCell(flat[c], dialect)).join(delimiter);
}
```

- [ ] **Step 4: Make the XLSX writer path-aware**

In `src/mdh/xlsxWrite.ts`, add `flattenDoc` to the `./flatten.js` import and change `writeDocs`:

```ts
    async writeDocs(docs: any[]) {
      let buf = '';
      for (const doc of docs) {
        const flat = doc == null ? {} : flattenDoc(doc);
        const values = cols!.map((c) => flat[c]);
        buf += rowXml(rowIndex, values);
        rowIndex++;
      }
      if (buf) await feed(buf);
    },
```

- [ ] **Step 5: Order leaf paths under their parent**

Replace `orderExportColumns` in `src/mdh/recordColumns.ts`:

```ts
import { splitPath } from './flatten.js';
```

```ts
// Column order for a CSV/Excel export so it matches the Table view the user sees.
// `discoveredPaths` are leaf PATHS (address.city), while the Table view shows
// top-level keys (address) — so each table column pulls in all the leaves that
// live under it, in path order, and anything left over is appended
// alphabetically. Grouping is by the DECODED first segment, so a literal
// dotted key is its own root rather than a child of a same-named object.
export function orderExportColumns(loadedRecords: any[], discoveredPaths: string[]): string[] {
  const discovered = discoveredPaths || [];
  const byRoot = new Map<string, string[]>();
  for (const p of discovered) {
    const root = splitPath(p)[0] as string;
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root)!.push(p);
  }
  const out: string[] = [];
  const used = new Set<string>();
  for (const key of deriveColumns(loadedRecords)) {
    for (const p of (byRoot.get(key) || []).slice().sort((a, b) => a.localeCompare(b))) {
      out.push(p); used.add(p);
    }
  }
  const extra = discovered.filter((p) => !used.has(p)).sort((a, b) => a.localeCompare(b));
  return [...out, ...extra];
}
```

The four pre-existing `orderExportColumns` tests must still pass unchanged: when every discovered path is top-level, each root group is a singleton and the result is identical to the old behaviour. If any of them fails, the grouping is wrong — fix the code, not the test.

- [ ] **Step 6: Make the export preview grid path-aware**

In `src/mdh/components/ExportWizard.tsx`, import `flattenDoc` and replace the grid body so the preview shows exactly what the writer will emit:

```tsx
                  {preview.sample.map((d, i) => {
                    const flat = d == null ? {} : flattenDoc(d);
                    return <tr key={i}>{(columns || []).map((c) => <td key={c}>{cellPreview(flat[c])}</td>)}</tr>;
                  })}
```

- [ ] **Step 7: Run the tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: the CSV-export, record-columns, download and export-wizard files green; still only the two Task-2 `import-confirm` failures outstanding.

- [ ] **Step 8: Stage**

```bash
git add -A
```

---

### Task 6: XML export writes EJSON as scalar text

Spec §4.6 and §2.3. `toXmlName` strips the `$`, so today's `<_id><_oid>…</_oid></_id>` is unrecoverable on import.

**Files:**
- Modify: `src/mdh/xml.ts` (`valueToXml`)
- Modify: `tests/mdh-xml.test.js`

**Interfaces:**
- Consumes: `getEjsonType`, `formatEjsonValue` from `src/mdh/displayValue.ts` — the same pair `csvCell` and `cellXml` already use.
- Produces: no signature change.

- [ ] **Step 1: Write the failing test**

Append to `tests/mdh-xml.test.js`:

```js
describe('valueToXml and EJSON', () => {
  it('writes an ObjectId as its hex text, not a nested <_oid>', () => {
    expect(valueToXml('_id', { $oid: '000000000000000000000001' }))
      .toBe('<_id>000000000000000000000001</_id>');
  });

  it('writes a date as ISO text', () => {
    expect(valueToXml('updated', { $date: '2026-01-31T09:00:00.000Z' }))
      .toBe('<updated>2026-01-31T09:00:00.000Z</updated>');
  });

  it('still nests an ordinary sub-document', () => {
    expect(valueToXml('address', { city: 'TOWN' })).toBe('<address><city>TOWN</city></address>');
  });

  it('escapes EJSON text like any other text', () => {
    expect(valueToXml('r', { $regex: 'a<b' })).toContain('a&lt;b');
  });
});
```

Make sure `valueToXml` is in that file's import list.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/mdh-xml.test.js`
Expected: FAIL — actual is `<_id><_oid>000000000000000000000001</_oid></_id>`.

- [ ] **Step 3: Implement**

In `src/mdh/xml.ts`, add the import:

```ts
import { getEjsonType, formatEjsonValue } from './displayValue.js';
```

and give `valueToXml` the EJSON branch, matching what `csvCell` and `cellXml` already do:

```ts
// null/undefined -> <name/>; array -> repeated <name>; EJSON wrapper -> its scalar
// text (a nested <_oid> could never come back — toXmlName strips the '$');
// object -> nested; primitive -> text.
export function valueToXml(name: string, value: unknown): string {
  const tag = toXmlName(name);
  if (value === null || value === undefined) return `<${tag}/>`;
  if (Array.isArray(value)) return value.map((v) => valueToXml(name, v)).join('');
  if (typeof value === 'object') {
    const ejson = getEjsonType(value);
    if (ejson) return `<${tag}>${escapeXml(formatEjsonValue(value, ejson))}</${tag}>`;
    return `<${tag}>${Object.entries(value).map(([k, v]) => valueToXml(k, v)).join('')}</${tag}>`;
  }
  return `<${tag}>${escapeXml(value)}</${tag}>`;
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run tests/mdh-xml.test.js && npm run typecheck`
Expected: PASS. If an existing test asserted the `<_oid>` nesting, it was asserting the bug — update it to the new output and note that in the test name.

- [ ] **Step 5: Stage**

```bash
git add -A
```

---

### Task 7: The round-trip guarantee

Spec §8. This is the acceptance test for the whole plan — the thing the user asked for, stated once, for every format.

**Files:**
- Create: `tests/mdh-round-trip.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1-6, plus `dedupeById` from `src/mdh/importFile.ts` (it applies `normalizeDocId`, which is what turns an exported 24-hex `_id` back into `{$oid}` on the real Insert path).
- Produces: nothing.

- [ ] **Step 1: Write the test**

Create `tests/mdh-round-trip.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { csvHeader, csvRow, parseCsv, orderColumns } from '../src/mdh/csv.js';
import { docToXml, parseXml } from '../src/mdh/xml.js';
import { buildXlsxSerializer } from '../src/mdh/xlsxWrite.js';
import { parseXlsx } from '../src/mdh/xlsx.js';
import { discoverLeafPaths } from '../src/mdh/columnDiscovery.js';
import { restoreDocs } from '../src/mdh/restoreValues.js';
import { deriveShape, validateAgainstShape } from '../src/mdh/shape.js';
import { dedupeById } from '../src/mdh/importFile.js';
import { flattenDoc } from '../src/mdh/flatten.js';

// Synthetic. One value of every kind that the flat formats flatten, plus an
// optional field so a non-uniform collection is covered.
const RECORDS = [
  {
    _id: { $oid: '000000000000000000000001' },
    key: { code: 'AAA', system: 'SysOne' },
    name: 'ALPHA SUPPLIES LTD',
    terms: 'NET45',
    active: true,
    limit: 1500,
    tags: ['x', 'y'],
    address: { line: ['PO BOX 1'], city: 'TOWN', country: 'US' },
    ref: { $oid: '0000000000000000000000ff' },
  },
  {
    _id: { $oid: '000000000000000000000002' },
    key: { code: 'BBB', system: 'SysOne' },
    name: 'BETA WORKS INC',
    terms: 'NET30',
    active: false,
    limit: 250,
    tags: ['z'],
    address: { line: ['1 MAIN ST'], city: 'CITY', country: 'US', region: 'ST' },
    ref: { $oid: '0000000000000000000000fe' },
    updated: { $date: '2026-01-31T09:00:00.000Z' },
  },
];

const SHAPE = deriveShape(RECORDS);

// The union of leaf paths, computed the way the real export computes it: drive
// discoverLeafPaths with a fake aggregate that answers each level from RECORDS.
async function leafPaths() {
  const aggregate = async (_c, pipeline) => {
    const facet = pipeline[pipeline.length - 1].$facet;
    const out = {};
    for (const [fk, stages] of Object.entries(facet)) {
      const expr = stages[0].$project.kv.$cond[1].$objectToArray;
      const path = expr === '$$ROOT' ? null : expr.slice(1);
      const byKey = new Map();
      for (const rec of RECORDS) {
        const node = path === null ? rec : path.split('.').reduce((o, s) => (o == null ? o : o[s]), rec);
        if (node === null || typeof node !== 'object' || Array.isArray(node)) continue;
        for (const [k, v] of Object.entries(node)) {
          if (!byKey.has(k)) byKey.set(k, new Set());
          byKey.get(k).add(
            v === null ? 'null'
              : Array.isArray(v) ? 'array'
                : typeof v === 'object' ? (Object.keys(v).length === 1 && Object.keys(v)[0].startsWith('$') ? Object.keys(v)[0].slice(1) : 'object')
                  : typeof v === 'number' ? 'int' : typeof v === 'boolean' ? 'bool' : 'string',
          );
        }
      }
      out[fk] = [...byKey].map(([k, types]) => ({ _id: k, types: [...types] }));
    }
    return { result: [out] };
  };
  return orderColumns(await discoverLeafPaths('c', [{ $match: {} }], { aggregate }));
}

// The real Insert tail: restore, then dedupeById (which re-wraps a 24-hex _id
// as {$oid} via normalizeDocId).
const importTail = (docs) => dedupeById(restoreDocs(docs, SHAPE).docs).kept;

function expectRoundTrip(restored) {
  expect(validateAgainstShape(restored, SHAPE)).toMatchObject({ ok: true });
  expect(restored).toEqual(RECORDS);
}

describe('export → import round trip (the guarantee)', () => {
  it('JSON / JSONL is lossless', () => {
    expectRoundTrip(importTail(JSON.parse(JSON.stringify(RECORDS))));
  });

  it('CSV', async () => {
    const columns = await leafPaths();
    const text = [csvHeader(columns), ...RECORDS.map((d) => csvRow(d, columns))].join('\r\n');
    expectRoundTrip(importTail(parseCsv(text, {}).docs));
  });

  it('Excel', async () => {
    const columns = await leafPaths();
    const ser = buildXlsxSerializer({ sheetName: 'Sheet1', header: true, columns });
    const parts = [];
    await ser.start(async (b) => { parts.push(b.slice()); }, { collectionName: 'c', pipelineStages: [] });
    await ser.writeDocs(RECORDS);
    await ser.finish();
    const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) { bytes.set(p, off); off += p.length; }
    expectRoundTrip(importTail((await parseXlsx(bytes.buffer, {})).docs));
  });

  it('XML', () => {
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<records>\n'
      + RECORDS.map((d) => '  ' + docToXml(d, 'record')).join('\n')
      + '\n</records>\n';
    expectRoundTrip(importTail(parseXml(xml, {}).docs));
  });
});

describe('backward compatibility (spec §5)', () => {
  it('a CSV exported BEFORE this change still imports correctly', () => {
    // Legacy layout: top-level headers only, each nested value one JSON cell.
    const columns = orderColumns([...new Set(RECORDS.flatMap((d) => Object.keys(d)))]);
    const legacyRow = (doc) => columns
      .map((c) => {
        const v = doc[c];
        if (v === undefined) return '';
        if (v && typeof v === 'object' && Object.keys(v).length === 1 && Object.keys(v)[0].startsWith('$')) {
          return Object.values(v)[0];
        }
        if (v && typeof v === 'object') return '"' + JSON.stringify(v).split('"').join('""') + '"';
        return String(v);
      })
      .join(',');
    const text = [csvHeader(columns), ...RECORDS.map(legacyRow)].join('\r\n');
    expectRoundTrip(importTail(parseCsv(text, {}).docs));
  });

  it('restore OFF leaves the parsed docs exactly as the parser produced them', () => {
    const parsed = parseCsv('a.b,c\r\n1,2', {}).docs;
    expect(parsed).toEqual([{ 'a.b': '1', c: '2' }]);   // no nesting without restore
  });
});

describe('the header the export writes matches the header the flattener produces', () => {
  it('every discovered path is a key of every flattened record, or absent from it', async () => {
    const columns = await leafPaths();
    for (const rec of RECORDS) {
      for (const k of Object.keys(flattenDoc(rec))) {
        expect(columns).toContain(k);   // nothing a record holds is missing from the header
      }
    }
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/mdh-round-trip.test.js`
Expected: PASS for all six cases.

If the Excel case fails on `updated`, read the failure before changing anything: the XLSX reader turns a date-styled cell into `{$date}` already (`src/mdh/xlsx.ts:156`), so a mismatch there means the writer's `DATE_STYLE_IDX` path is not being hit — fix the writer, not the assertion.

If the XML case fails on `tags` for the single-element record, that is layer 1's array wrapping (Task 3); confirm `SHAPE.paths.get('tags')` is `Set{'array'}`.

- [ ] **Step 3: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`

- [ ] **Step 4: Stage**

```bash
git add -A
```

---

### Task 8: Wire the restore into the import wizard

Spec §4.8 and §4.9. The restore must feed the preview, the validator and the upload from ONE memo, or the preview lies about what gets written.

**Files:**
- Modify: `src/mdh/formats/csv.tsx` (`DEFAULT_OPTS`, controls), `src/mdh/formats/xlsx.tsx`, `src/mdh/formats/xml.tsx`
- Modify: `src/mdh/components/ImportWizard.tsx`
- Modify: `src/mdh/components/ImportControls.tsx` (`CsvPreview`)
- Modify: `tests/mdh-import-wizard.test.js`

**Interfaces:**
- Consumes: `restoreDocs`, `formatRestoreSummary` (Task 3); `getByPath`, `hasByPath` (Task 1).
- Produces: `ImportConfirm` gains a `restoreSummary?: string | null` prop, consumed in Task 9.

- [ ] **Step 1: Add the control to each flat format**

In `src/mdh/formats/csv.tsx`, add to `DEFAULT_OPTS`:

```ts
  restoreValues: true,
```

and add the control to the toolbar, before the Advanced button, renaming the existing one:

```tsx
        <span class="csv-tb-item">
          <span class="csv-tb-k" title="Rebuild objects and arrays the export flattened, and match values to the types this collection already uses.">Restore structure {'&'} types</span>
          <Toggle checked={opts.restoreValues} onChange={(v) => setOpt('restoreValues', v)} testid="csv-restore"
            title="Rebuild what the export flattened." />
        </span>

        <span class="csv-tb-item">
          <span class="csv-tb-k" title="Read numbers and true/false out of text, for columns the collection has no type for.">Detect numbers {'&'} booleans</span>
          <Toggle checked={opts.inferTypes} onChange={(v) => setOpt('inferTypes', v)} testid="csv-infer"
            title="Detect numbers and true/false." />
        </span>
```

The old `Infer types` label and its `title` are replaced; the `inferTypes` key and the `csv-infer` testid are deliberately kept (spec §4.8).

In `src/mdh/formats/xlsx.tsx`, add `restoreValues: true` to `defaultOpts` and the same "Restore structure & types" toggle with testid `xlsx-restore`.

In `src/mdh/formats/xml.tsx`, add `restoreValues: true` to `defaultOpts`, the same toggle with testid `xml-restore`, and rename the existing `xml-infer` label to "Detect numbers & booleans".

Leave `json.ts` and `jsonl.ts` untouched — JSON already round-trips losslessly, so restore would be a chance to corrupt with nothing to gain.

- [ ] **Step 2: Write the failing wizard test**

Append to `tests/mdh-import-wizard.test.js` (follow the file's existing mount/`waitFor` helpers):

```js
it('restores a dotted CSV header into nested documents before import', async () => {
  // A collection whose shape says address.city is a string and n is a number.
  api.aggregate.mockResolvedValue({ result: [{ _id: { $oid: '000000000000000000000001' }, address: { city: 'X' }, n: 1 }] });
  const root = mountWizard();
  await dropCsv(root, 'address.city,n\r\nTOWN,42\r\n');
  const preview = await waitFor(() => root.querySelector('[data-testid="csv-preview"]'));
  expect(preview.textContent).toContain('TOWN');
  const summary = await waitFor(() => root.querySelector('[data-testid="import-restore-summary"]'));
  expect(summary.textContent).toMatch(/Restored 1 nested column/);
});
```

Adapt `mountWizard` / `dropCsv` to whatever helpers that file already defines; do not invent a new mounting style.

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/mdh-import-wizard.test.js`
Expected: FAIL — no `import-restore-summary` element exists.

- [ ] **Step 4: Wire the wizard**

In `src/mdh/components/ImportWizard.tsx`, add the imports:

```ts
import { useMemo } from 'preact/hooks';
import { restoreDocs, formatRestoreSummary } from '../restoreValues.js';
```

(`useMemo` joins the existing `preact/hooks` import — do not add a second import line.)

Add the parse-options helper next to `setOpt`. Inference must NOT run in the parser when restore is on, or a column the collection calls a string is already a number before layer 1 ever sees it (spec §4.9):

```ts
  // Inference is layer 3 and must lose to the collection's own types, so it is
  // relocated out of the parser into restoreDocs whenever restore is on.
  const parseOpts = (o: Record<string, any>) => (o.restoreValues ? { ...o, inferTypes: false } : o);
```

Use it at both parse sites — in `handleFile`:

```ts
      const res = await Promise.resolve(f.parse(input, parseOpts(initialOpts)));
```

and in the re-parse effect:

```ts
    Promise.resolve(fmt.parse(rawInput, parseOpts(opts)))
```

Add the single restore memo after the shape effect:

```ts
  // ONE source of truth: the preview, the shape check and the upload all read
  // these docs, so what the user sees is exactly what gets written.
  const restored = useMemo(() => {
    if (!parsed) return null;
    if (!opts.restoreValues) return { docs: parsed.docs, summary: null };
    const r = restoreDocs(parsed.docs, shape, { inferTypes: !!opts.inferTypes });
    return { docs: r.docs, summary: r.summary };
  }, [parsed, shape, opts.restoreValues, opts.inferTypes]);

  const importDocs = restored?.docs ?? [];
  const restoreSummary = restored?.summary
    ? formatRestoreSummary(restored.summary, { hasShape: !!shape, shapeError })
    : null;
```

Replace every downstream use of `parsed.docs` with `importDocs`:

- the `<CsvPreview>` / `<JsonPreview>` render — pass `parsed={{ ...parsed, docs: importDocs }}` and `nested={!!opts.restoreValues}` to `CsvPreview`, and `docs={importDocs}` to `JsonPreview`;
- `<ImportConfirm docs={importDocs} … restoreSummary={restoreSummary} />`;
- in `startImport`, `const docs = importDocs;` instead of `parsed.docs`.

Also surface the restore warnings alongside the parse warnings by merging them into the object handed to `CsvPreview`:

```tsx
parsed={{ ...parsed, docs: importDocs, warnings: [...(parsed.warnings || []), ...(restored?.summary?.warnings || [])] }}
```

- [ ] **Step 5: Make the preview read by path**

In `src/mdh/components/ImportControls.tsx`, import the helpers and add the `nested` prop:

```ts
import { getByPath, hasByPath } from '../flatten.js';
```

```tsx
export function CsvPreview({ parsed, limit = 5, nested = false }: { parsed: any; limit?: number; nested?: boolean }) {
```

and inside the body row map, replace the cell:

```tsx
                    {columns.map((c: any) => {
                      // With restore on, docs are nested but the header is still the
                      // raw column — and the header IS the encoded path, so this is exact.
                      const value = nested ? getByPath(doc, c) : doc[c];
                      const present = nested ? hasByPath(doc, c) : Object.prototype.hasOwnProperty.call(doc, c);
                      return <td key={c}><PreviewValue value={value} present={present} /></td>;
                    })}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run tests/mdh-import-wizard.test.js && npm run typecheck`
Expected: the new test still fails on `import-restore-summary` (Task 9 renders it) but everything else passes. If other wizard tests break, they are asserting `parsed.docs` flowing straight through — update them to the restored docs, which is the new contract.

- [ ] **Step 7: Stage**

```bash
git add -A
```

---

### Task 9: `ImportConfirm` — the summary line and the direction of every error

Spec §4.8 and §2.5. Closes the user's second complaint: `date → string` never said which side was which.

**Files:**
- Modify: `src/mdh/components/ImportConfirm.tsx:44-60` (props), `:118-160` (shape block)
- Modify: `tests/mdh-import-confirm.test.js`

**Interfaces:**
- Consumes: `restoreSummary` from Task 8.
- Produces: nothing.

- [ ] **Step 1: Write the failing tests**

In `tests/mdh-import-confirm.test.js`, replace the two over-rejection tests (`'non-uniform + mismatching docs…'` and `'non-uniform + matching docs…'`) with:

```js
  it('a row missing an optional field no longer trips the guard', () => {
    const shape = deriveShape([{ sku: 'A1', price: 10 }, { sku: 'B2', price: 20, note: 'x' }]);
    const root = mount(h(ImportConfirm, { ...base, mode: 'insert', shape, shapeCount: 2 }));
    expect(root.querySelector('[data-testid="import-shape-error"]')).toBe(null);
    expect(root.querySelector('[data-testid="import-shape-ok"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="import-go"]').disabled).toBe(false);
  });

  it('no longer shows the over-rejection note, because it no longer over-rejects', () => {
    const shape = deriveShape([{ sku: 'A1', price: 10 }, { sku: 'B2', price: 20, note: 'x' }]);
    const root = mount(h(ImportConfirm, { ...base, mode: 'insert', shape }));
    expect(root.textContent).not.toMatch(/over-reject/i);
  });
```

and append:

```js
  it('states which side each error came from', () => {
    const shape = deriveShape([{ sku: 'A1', at: { $date: '2026-01-31T09:00:00.000Z' } }]);
    const root = mount(h(ImportConfirm, {
      ...base, shape, shapeCount: 1, docs: [{ sku: 'B2', at: 'text', extra: 1 }],
    }));
    const err = root.querySelector('[data-testid="import-shape-error"]').textContent;
    expect(err).toMatch(/in the file, not in the collection/i);
    expect(err).toMatch(/collection has date/i);
    expect(err).toMatch(/file has string/i);
    expect(err).not.toMatch(/date → string/);
  });

  it('names the missing side explicitly too', () => {
    const shape = deriveShape([{ sku: 'A1', region: 'EU' }]);
    const root = mount(h(ImportConfirm, { ...base, shape, shapeCount: 1, docs: [{ sku: 'B2' }] }));
    expect(root.querySelector('[data-testid="import-shape-error"]').textContent)
      .toMatch(/in the collection, not in the file/i);
  });

  it('renders the restore summary when one is given, and nothing when it is null', () => {
    const withIt = mount(h(ImportConfirm, { ...base, restoreSummary: 'Restored 9 nested columns to match the collection.' }));
    expect(withIt.querySelector('[data-testid="import-restore-summary"]').textContent)
      .toMatch(/Restored 9 nested columns/);
    const without = mount(h(ImportConfirm, { ...base, restoreSummary: null }));
    expect(without.querySelector('[data-testid="import-restore-summary"]')).toBe(null);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/mdh-import-confirm.test.js`
Expected: FAIL on the direction copy and the missing summary element. The two rewritten optional-path tests should now PASS (Task 2 already fixed the guard) — if they do not, Task 2 is incomplete.

- [ ] **Step 3: Add the prop**

In `ImportConfirm`'s signature and its type block, add:

```ts
  restoreSummary = null,
```

```ts
  restoreSummary?: string | null;
```

- [ ] **Step 4: Render the summary line**

Immediately before the `{shapeLoading && …}` line:

```tsx
      {restoreSummary && (
        <div class="import-shape-line" data-testid="import-restore-summary">{restoreSummary}</div>
      )}
```

- [ ] **Step 5: State the direction on every error row**

Replace the three `<li>` rows in the error list:

```tsx
            {shapeCheck.missing.length > 0 && (
              <li><span class="import-error-label">Missing</span><span class="import-error-fields">
                <span class="import-error-side">in the collection, not in the file</span>
                {shapeCheck.missing.map((p: any) => <FieldName key={p} name={p} />)}
              </span></li>
            )}
            {shapeCheck.unknown.length > 0 && (
              <li><span class="import-error-label">Unexpected</span><span class="import-error-fields">
                <span class="import-error-side">in the file, not in the collection</span>
                {shapeCheck.unknown.map((p: any) => <FieldName key={p} name={p} />)}
              </span></li>
            )}
            {shapeCheck.typeMismatch.length > 0 && (
              <li><span class="import-error-label">Wrong type</span><span class="import-error-fields">
                {shapeCheck.typeMismatch.map((t: any) => (
                  <code key={t.path}>
                    <SpecialText value={t.path} quote markEdgeSpaces />
                    {` — collection has ${t.expected.join('/')} · file has ${t.got}`}
                  </code>
                ))}
              </span></li>
            )}
```

The `{'…'}` expression form is required for the dash and middot — see Global Constraints.

- [ ] **Step 6: Delete the over-rejection note**

Remove the whole `{shape && !shape.uniform && ( … )}` block. `deriveShape` no longer returns `uniform` (Task 2), so leaving it would silently render nothing forever.

- [ ] **Step 7: Add the side-label style**

In `src/console/console.css`, next to the existing `.import-error-fields` rule, add:

```css
.import-error-side {
  color: var(--text-muted);
  font-size: 11px;
  margin-right: 6px;
}
```

Use whichever muted-text variable that file already defines — grep `--text-muted` first and match the local name. Do NOT introduce a short class name (Global Constraints).

- [ ] **Step 8: Run the full suite, typecheck, and build**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green, including the wizard test from Task 8 and `tests/css-class-collision-boundary.test.js`.

- [ ] **Step 9: Stage**

```bash
git add -A
```

---

### Task 10: Live verification gates

Spec §7. Four claims this design rests on that have not been proven against a live backend. **Internal sandbox org only — never a customer org.** Nothing here changes code unless a gate fails.

**Files:**
- Modify: `docs/superpowers/specs/2026-08-24-mdh-export-import-round-trip-design.md` (record each result in §7)

**Interfaces:**
- Consumes: the `mcp__plugin_rossum-sa_rossum-api__data_storage_*` tools, or the dogfood recipe in the extension itself.
- Produces: a verified or amended §7.

- [ ] **Step 1: Create a scratch collection**

Use a throwaway name (e.g. `zz_roundtrip_probe`). Insert three synthetic documents with: three levels of nesting, one path that is an object in one record and a scalar in another, one real `{$date}`, one non-`_id` `{$oid}`, one array, and one key named `a.b`.

- [ ] **Step 2: V1 + V2 — the discovery walk**

Run `buildLevelPipeline`'s output by hand through `data_storage_aggregate`, level by level. Confirm:
- `$facet` accepts the positional `f0`/`f1` keys;
- `$type` returns `objectId` and `date` for the real BSON values, and `object` only for genuine sub-documents;
- the union of leaf paths equals a client-side `flattenDoc` walk over all three documents.

If `$facet` is rejected, fall back to one aggregation per parent (the driver's loop already isolates this — only `buildLevelPipeline` changes) and record that in §7.

- [ ] **Step 3: V4 — `{$date}` through `insert_many`**

Insert `{ probe: 'v4', at: { $date: '2026-01-31T09:00:00.000Z' } }` and read it back. It must return as `{$date}`, not as a string.

- [ ] **Step 4: V3 — `{$date}` through the data-matching upload**

PUT-replace the scratch dataset with a JSON blob containing an EJSON `{$date}` value, wait for the operation, then read the record back through Data Storage. It must be a real date.

**If V3 fails:** Update/Replace cannot carry dates. Change `restoreDocs` to accept a `dates: boolean` option, pass `false` from `ImportWizard` when `mode !== 'insert'`, and extend `formatRestoreSummary` to say dates were left as text for those modes. Record the outcome in §7 either way.

- [ ] **Step 5: Drop the scratch collection**

Leave the sandbox as you found it.

- [ ] **Step 6: Record the results**

Replace §7's table with the outcome of each gate and the date, so the next reader knows these are measured rather than assumed.

- [ ] **Step 7: Final verification**

Run: `npm test && npm run typecheck && npm run build`

Then tell the owner: what shipped, what the gates proved, and that `dist/` is rebuilt so the extension can be reloaded. **Stage only — do not commit.**

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §4.1 layered restore, ordering rule | 3 (module), 8 (inference relocation) |
| §4.2 path grammar, opaque keys, conflicts | 1 |
| §4.3 restoreValues rules table, summary | 3 |
| §4.4 exhaustive deep discovery | 4 |
| §4.4 column ordering | 5 |
| §4.5 dotted rows (csv, xlsx, preview) | 5 |
| §4.6 XML EJSON as scalar text | 6 |
| §4.7 optional paths, shared grammar, `uniform` removed | 2, 9 |
| §4.8 controls, rename, summary line, error direction | 8, 9 |
| §4.9 data flow, one memo, preview lookup | 8 |
| §5 backward compatibility | 7 |
| §7 verification gates | 10 |
| §8 testing | every task; acceptance in 7 |

**Type consistency:** `restoreDocs` / `formatRestoreSummary` / `RestoreSummary` are named identically in Tasks 3, 8 and 9. `discoverLeafPaths` / `buildLevelPipeline` / `MAX_DISCOVERY_DEPTH` are identical in Tasks 4, 5 and 7. `flattenDoc` / `unflattenDoc` / `getByPath` / `hasByPath` / `isOpaqueKey` / `isEjsonWrapper` / `joinPath` / `splitPath` / `encodeSegment` are identical in Tasks 1, 2, 3, 4, 5 and 7. `orderExportColumns(loaded, discoveredPaths)` keeps its arity.

**Known cross-task red state:** Task 2 breaks two `tests/mdh-import-confirm.test.js` tests on purpose (they assert the over-rejection this plan removes); Task 9 replaces them. Task 8's new wizard test fails until Task 9 renders the summary element. Both are called out where they occur so an executor does not "fix" them the wrong way.
