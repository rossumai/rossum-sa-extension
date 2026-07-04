# Import Wizard: Random-Sample Shape Validation, Whitespace Detection, Verbose Explanations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shape-validate imports against a random `$sample` of the collection, explicitly detect and visualize whitespace-only column-name differences, remove the match estimate in favor of verified verbose "What will happen" step lists, block keyless rows exactly, and strip `_id` from server-side Update/Replace uploads.

**Architecture:** Pure helpers first (`shape.js` pairing, `SpecialText` edge markers, `importPlan.js` key counter, `importFile.js` id stripper), then wiring in `ImportWizard.jsx` (sampling, estimate removal, `_id` strip) and `ImportConfirm.jsx` (step lists, guard, whitespace rendering). Spec: `docs/superpowers/specs/2026-07-03-import-shape-sample-verbose-design.md` — its F1–F14 fact table is the source of truth for every UI copy claim.

**Tech Stack:** Preact + signals, vitest (jsdom), esbuild. No new dependencies.

## Global Constraints

- **NO git commits at any step** (user preference overrides the usual commit cadence — leave everything uncommitted on `master`).
- Tests are `.test.js` files rendering via `h(Component, {...})` — **no raw JSX in test files** (breaks oxc).
- JSX unicode escapes: `\uXXXX` does NOT work in JSX text/attributes — use `{'—'}`-style expressions or literal characters (see CLAUDE.md).
- **No customer names or customer data** anywhere (code, tests, fixtures, copy). Generic field names only (`sku`, `name`, `region`, `price`).
- UI copy in Tasks 6–9 must match the spec §5/§6 lines **verbatim**.
- Run scoped tests per task; full `npm test` + `npm run build` in the final task (the loaded extension runs `dist/`, so remind the user to rebuild/reload).

---

### Task 1: Whitespace-only mismatch pairing in `shape.js`

**Files:**
- Modify: `src/mdh/shape.js` (extend `validateAgainstShape`, lines 71–101)
- Test: `tests/mdh-shape.test.js` (append a describe block)

**Interfaces:**
- Consumes: existing `deriveShape(docs)`, `validateAgainstShape(docs, shape)`.
- Produces: `validateAgainstShape` result gains `whitespace: Array<{expected: string, got: string}>`; paired paths are removed from `missing`/`unknown`; `ok` is false when `whitespace.length > 0`. Consumed by Task 9.

- [ ] **Step 1: Write the failing tests** — append to `tests/mdh-shape.test.js` (it already imports `deriveShape`/`validateAgainstShape`; if the import line lists them differently, extend it rather than duplicating):

```js
describe('validateAgainstShape — whitespace pairing', () => {
  const ref = deriveShape([{ sku: 'A1', price: 10 }]);

  it('pairs a trailing-space file column with the existing column', () => {
    const r = validateAgainstShape([{ 'sku ': 'A1', price: 10 }], ref);
    expect(r.ok).toBe(false);
    expect(r.whitespace).toEqual([{ expected: 'sku', got: 'sku ' }]);
    expect(r.missing).toEqual([]);
    expect(r.unknown).toEqual([]);
  });

  it('pairs a leading-space and an NBSP-edged column', () => {
    const lead = validateAgainstShape([{ ' sku': 'A1', price: 10 }], ref);
    expect(lead.whitespace).toEqual([{ expected: 'sku', got: ' sku' }]);
    const nbsp = validateAgainstShape([{ 'sku\u00A0': 'A1', price: 10 }], ref); // NBSP-edged key, explicit escape
    expect(nbsp.whitespace).toEqual([{ expected: 'sku', got: 'sku\u00A0' }]);
  });

  it('pairs when BOTH sides carry different edge whitespace', () => {
    const refWs = deriveShape([{ 'sku ': 'A1' }]);
    const r = validateAgainstShape([{ ' sku': 'A1' }], refWs);
    expect(r.whitespace).toEqual([{ expected: 'sku ', got: ' sku' }]);
  });

  it('pairs nested path segments (a. b vs a.b)', () => {
    const nested = deriveShape([{ a: { b: 1 } }]);
    const r = validateAgainstShape([{ a: { ' b': 1 } }], nested);
    expect(r.whitespace).toEqual([{ expected: 'a.b', got: 'a. b' }]);
  });

  it('pairs multiple file variants of one existing field', () => {
    const r = validateAgainstShape([{ 'sku ': 'A1', price: 10 }, { ' sku': 'B2', price: 20 }], ref);
    expect(r.whitespace).toEqual(expect.arrayContaining([
      { expected: 'sku', got: 'sku ' },
      { expected: 'sku', got: ' sku' },
    ]));
    expect(r.unknown).toEqual([]);
    expect(r.missing).toEqual([]);
  });

  it('a genuine rename stays missing+unknown, not whitespace', () => {
    const r = validateAgainstShape([{ item: 'A1', price: 10 }], ref);
    expect(r.whitespace).toEqual([]);
    expect(r.missing).toEqual(['sku']);
    expect(r.unknown).toEqual(['item']);
  });

  it('failedDocCount still counts whitespace-failing docs', () => {
    const r = validateAgainstShape([{ 'sku ': 'A1', price: 10 }, { sku: 'B2', price: 20 }], ref);
    expect(r.failedDocCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mdh-shape.test.js`
Expected: FAIL — `whitespace` is `undefined` / lists contain the unpaired paths.

- [ ] **Step 3: Implement pairing in `validateAgainstShape`** — keep the doc loop intact but collect into `Set`s you can mutate, then pair before returning. Replace the function's tail (the `return {...}` block) with:

```js
// Whitespace pairing: a "missing" and an "unknown" path that are the same
// after per-segment trim differ only by leading/trailing whitespace — report
// them as one explicit finding instead of two opaque ones. trim() also strips
// NBSP/TAB/FEFF-class edge characters, not just U+0020.
function normalizePath(path) {
  return String(path).split('.').map((s) => s.trim()).join('.');
}
```

(top-level helper, above `validateAgainstShape`), and inside `validateAgainstShape`, after the `for (const doc of list)` loop:

```js
  const whitespace = [];
  const missingByNorm = new Map();
  for (const m of missing) {
    const n = normalizePath(m);
    if (!missingByNorm.has(n)) missingByNorm.set(n, m);
  }
  for (const u of [...unknown]) {
    const m = missingByNorm.get(normalizePath(u));
    if (m !== undefined && m !== u) {
      whitespace.push({ expected: m, got: u });
      unknown.delete(u);
      missing.delete(m);
    }
  }
  return {
    ok: missing.size === 0 && unknown.size === 0 && typeMismatch.size === 0 && whitespace.length === 0,
    missing: [...missing],
    unknown: [...unknown],
    typeMismatch: [...typeMismatch.values()],
    whitespace,
    failedDocCount,
  };
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/mdh-shape.test.js`
Expected: PASS (all pre-existing tests too — the return shape only gains a key).

### Task 2: `SpecialText` edge-space markers

**Files:**
- Modify: `src/mdh/components/SpecialText.jsx`
- Test: `tests/mdh-special-text.test.js` (append)

**Interfaces:**
- Produces: `SpecialText` accepts `markEdgeSpaces` (bool, default false): leading/trailing runs of U+0020 render as one marker per space — `<span class="mdh-special mdh-special-space" title="U+0020 SPACE">·</span>`. Interior spaces stay plain; other special chars keep existing markers; clean strings render byte-identical. Consumed by Task 9.

- [ ] **Step 1: Write the failing tests** — append to `tests/mdh-special-text.test.js`, matching that file's existing mount/render helpers (it renders via `h(SpecialText, {...})`):

```js
describe('SpecialText markEdgeSpaces', () => {
  it('marks leading and trailing ordinary spaces', () => {
    const el = mount(h(SpecialText, { value: ' name  ', markEdgeSpaces: true }));
    const marks = el.querySelectorAll('.mdh-special-space');
    expect(marks.length).toBe(3); // 1 leading + 2 trailing
    expect(marks[0].getAttribute('title')).toBe('U+0020 SPACE');
    expect(el.textContent).toBe('·name··');
  });

  it('leaves interior spaces plain', () => {
    const el = mount(h(SpecialText, { value: 'full name', markEdgeSpaces: true }));
    expect(el.querySelectorAll('.mdh-special-space').length).toBe(0);
    expect(el.textContent).toBe('full name');
  });

  it('still marks interior special characters in the core', () => {
    const el = mount(h(SpecialText, { value: ' a\u00A0b', markEdgeSpaces: true })); // leading space + interior NBSP
    expect(el.textContent).toContain('NBSP');
    expect(el.querySelectorAll('.mdh-special-space').length).toBe(1); // the leading U+0020 only
  });

  it('quotes around the marked value', () => {
    const el = mount(h(SpecialText, { value: 'name ', quote: true, markEdgeSpaces: true }));
    expect(el.textContent).toBe('"name·"');
  });

  it('renders a clean string byte-identical', () => {
    const el = mount(h(SpecialText, { value: 'name', markEdgeSpaces: true }));
    expect(el.textContent).toBe('name');
    expect(el.querySelector('.mdh-special')).toBe(null);
  });

  it('handles an all-spaces value without double-marking', () => {
    const el = mount(h(SpecialText, { value: '  ', markEdgeSpaces: true }));
    expect(el.querySelectorAll('.mdh-special-space').length).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mdh-special-text.test.js`
Expected: FAIL — no markers rendered for plain edge spaces.

- [ ] **Step 3: Implement** — in `SpecialText.jsx`, add the prop and an edge-splitting branch at the top of the component (before the `hasSpecial` fast path):

```jsx
export default function SpecialText({ value, quote = false, limit, markEdgeSpaces = false }) {
  if (typeof value !== 'string') return value;
  const q = quote ? '"' : '';

  if (markEdgeSpaces) {
    const lead = (value.match(/^ +/) || [''])[0];
    const rest = value.slice(lead.length);
    const trail = (rest.match(/ +$/) || [''])[0];
    if (lead || trail) {
      const core = rest.slice(0, rest.length - trail.length);
      const marks = (run, keyBase) => [...run].map((_, i) => (
        <span key={keyBase + i} class="mdh-special mdh-special-space" title="U+0020 SPACE">{'·'}</span>
      ));
      return (
        <Fragment>
          {q}
          {marks(lead, 'l')}
          <SpecialText value={core} />
          {marks(trail, 't')}
          {q}
        </Fragment>
      );
    }
  }
  // ... existing body unchanged (hasSpecial fast path + tokenize branch) ...
```

(The recursive `<SpecialText value={core} />` carries no quote/limit — it handles interior specials via the existing path. `markEdgeSpaces` is for short field names; `limit` is not combined with it.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/mdh-special-text.test.js tests/mdh-special-chars.test.js`
Expected: PASS.

### Task 3: `countRowsMissingKeys` in `importPlan.js`

**Files:**
- Modify: `src/mdh/importPlan.js`
- Test: `tests/mdh-import-plan.test.js` (append)

**Interfaces:**
- Produces: `countRowsMissingKeys(docs, keys) → number` — rows where any dotted key path is absent (own-property walk, no array traversal; `null` values count as PRESENT per fact F5). Consumed by Task 7.

- [ ] **Step 1: Write the failing tests** — append to `tests/mdh-import-plan.test.js` (add `countRowsMissingKeys` to its existing `importPlan.js` import):

```js
describe('countRowsMissingKeys', () => {
  it('counts rows lacking a top-level key', () => {
    expect(countRowsMissingKeys([{ sku: 'A' }, { name: 'x' }, { sku: null }], ['sku'])).toBe(1);
  });
  it('null key values count as present (server accepts them)', () => {
    expect(countRowsMissingKeys([{ sku: null }], ['sku'])).toBe(0);
  });
  it('requires ALL keys per row', () => {
    expect(countRowsMissingKeys([{ sku: 'A', region: 'EU' }, { sku: 'B' }], ['sku', 'region'])).toBe(1);
  });
  it('walks dotted paths without traversing arrays', () => {
    expect(countRowsMissingKeys([{ sku: { code: 'X' } }], ['sku.code'])).toBe(0);
    expect(countRowsMissingKeys([{ sku: ['X'] }], ['sku.0'])).toBe(1);
    expect(countRowsMissingKeys([{ sku: 'plain' }], ['sku.code'])).toBe(1);
  });
  it('non-object rows are missing everything; empty keys count nothing', () => {
    expect(countRowsMissingKeys([null, 42, [1]], ['sku'])).toBe(3);
    expect(countRowsMissingKeys([{ sku: 'A' }], [])).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mdh-import-plan.test.js`
Expected: FAIL with "countRowsMissingKeys is not a function" (or not exported).

- [ ] **Step 3: Implement** — append to `src/mdh/importPlan.js`:

```js
// Presence of a dotted key path via own-property walk; arrays are leaves.
function hasPath(doc, path) {
  let cur = doc;
  for (const seg of String(path).split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) return false;
    cur = cur[seg];
  }
  return true;
}

// How many rows would make the server-side Update fail outright: a row missing
// ANY match key fails the WHOLE data-matching PATCH (verified live 2026-07-03,
// CLIENT_ERROR "ID key ... not found in the updated element"). A null key
// value is accepted by the server, so null counts as present.
export function countRowsMissingKeys(docs, keys) {
  if (!Array.isArray(docs) || !Array.isArray(keys) || keys.length === 0) return 0;
  let n = 0;
  for (const d of docs) {
    const obj = (d && typeof d === 'object' && !Array.isArray(d)) ? d : null;
    if (!obj || !keys.every((k) => hasPath(obj, k))) n++;
  }
  return n;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/mdh-import-plan.test.js`
Expected: PASS.

### Task 4: `stripIds` in `importFile.js`

**Files:**
- Modify: `src/mdh/importFile.js`
- Test: `tests/mdh-import-file.test.js` (append)

**Interfaces:**
- Produces: `stripIds(docs) → docs` — new array; rows carrying own `_id` become shallow copies without it; other rows pass through by reference. Consumed by Task 8.

- [ ] **Step 1: Write the failing tests** — append to `tests/mdh-import-file.test.js` (add `stripIds` to its `importFile.js` import):

```js
describe('stripIds', () => {
  it('removes _id (plain or EJSON) without mutating inputs', () => {
    const docs = [{ _id: { $oid: 'a'.repeat(24) }, sku: 'A' }, { _id: '1', sku: 'B' }, { sku: 'C' }];
    const out = stripIds(docs);
    expect(out).toEqual([{ sku: 'A' }, { sku: 'B' }, { sku: 'C' }]);
    expect(docs[0]._id).toBeTruthy(); // originals untouched
    expect(out[2]).toBe(docs[2]);     // no-_id rows pass through by reference
  });
  it('leaves non-object rows alone', () => {
    expect(stripIds([null, 5])).toEqual([null, 5]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mdh-import-file.test.js`
Expected: FAIL — `stripIds` not exported.

- [ ] **Step 3: Implement** — append to `src/mdh/importFile.js`:

```js
// Data-matching (Update/Replace) uploads reject rows carrying an EJSON _id:
// the whole operation fails with "batch op errors occurred", and id_keys=_id
// can never match (verified live 2026-07-03). _id cannot round-trip through
// that API anyway, so server-side uploads send _id-less copies.
export function stripIds(docs) {
  return (docs || []).map((d) => {
    if (!d || typeof d !== 'object' || Array.isArray(d) || !Object.prototype.hasOwnProperty.call(d, '_id')) return d;
    const copy = { ...d };
    delete copy._id;
    return copy;
  });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/mdh-import-file.test.js`
Expected: PASS.

### Task 5: Random-sample shape fetch in `ImportWizard.jsx`

**Files:**
- Modify: `src/mdh/components/ImportWizard.jsx` (confirm-stage effect, lines 112–121; props to `ImportConfirm`)
- Test: `tests/mdh-import-wizard.test.js`

**Interfaces:**
- Consumes: `api.aggregate(collection, pipeline)` (exists, `api.js:195`), `api.find(collection, {limit})`.
- Produces: wizard state `shapeCount` (number, sampled-record count) passed to `ImportConfirm` as `shapeCount`. Task 6 renders it.

- [ ] **Step 1: Update the API mock + write failing tests** — in `tests/mdh-import-wizard.test.js`, add `aggregate` to the `vi.mock('../src/mdh/api.js', ...)` factory (line 4):

```js
  aggregate: vi.fn().mockResolvedValue({ result: [] }),
```

and append a describe block:

```js
describe('ImportWizard — shape sampling', () => {
  it('derives the shape from a random $sample aggregation', async () => {
    api.aggregate.mockResolvedValueOnce({ result: [{ sku: 'A', price: 1 }] });
    const root = mount(h(ImportWizard, { onSuccess: vi.fn() }));
    await toConfirmViaFile(root, [{ sku: 'B', price: 2 }]);
    await waitFor(() => api.aggregate.mock.calls.length > 0);
    expect(api.aggregate).toHaveBeenCalledWith('vendors', [{ $sample: { size: 500 } }]);
    expect(api.find).not.toHaveBeenCalled();
  });

  it('falls back to find(limit 500) when $sample fails', async () => {
    api.aggregate.mockRejectedValueOnce(new Error('no $sample'));
    const root = mount(h(ImportWizard, { onSuccess: vi.fn() }));
    await toConfirmViaFile(root, [{ sku: 'B', price: 2 }]);
    await waitFor(() => api.find.mock.calls.length > 0);
    expect(api.find).toHaveBeenCalledWith('vendors', { limit: 500 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mdh-import-wizard.test.js`
Expected: the two new tests FAIL (aggregate never called).

- [ ] **Step 3: Implement** — in `ImportWizard.jsx`: add `const SHAPE_SAMPLE = 500;` beside the other module constants, add state `const [shapeCount, setShapeCount] = useState(0);`, and replace the confirm-stage effect body:

```js
  // ---- confirm: derive the existing collection's shape from a RANDOM sample
  // ($sample — F1), falling back to the old first-N find so shape validation
  // never silently disappears if aggregation is unavailable. ----
  async function fetchShapeSample(collection) {
    try {
      const res = await api.aggregate(collection, [{ $sample: { size: SHAPE_SAMPLE } }]);
      return res?.result || [];
    } catch {
      const res = await api.find(collection, { limit: SHAPE_SAMPLE });
      return res?.result || [];
    }
  }

  useEffect(() => {
    if (stage !== STAGE.CONFIRM) return undefined;
    let alive = true;
    setShapeLoading(true);
    fetchShapeSample(selectedCollection.value)
      .then((existing) => {
        if (!alive) return;
        setShape(existing.length ? deriveShape(existing) : null);
        setShapeCount(existing.length);
        setShapeLoading(false);
      })
      .catch(() => { if (alive) { setShape(null); setShapeCount(0); setShapeLoading(false); } });
    return () => { alive = false; };
  }, [stage, selectedCollection.value]);
```

and pass `shapeCount={shapeCount}` to `<ImportConfirm ...>` (rendered in Task 6's copy).

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/mdh-import-wizard.test.js`
Expected: new tests PASS. The pre-existing estimate test still passes (its `find` branch mock now only serves the estimate probe — the shape fetch goes through `aggregate`).

### Task 6: Remove the estimate feature

**Files:**
- Delete: `src/mdh/matchEstimate.js`, `tests/mdh-match-estimate.test.js`
- Modify: `src/mdh/components/ImportWizard.jsx` (import line 13, state lines 41–42, effect lines 123–139, props lines 264), `src/mdh/components/ImportConfirm.jsx` (props, `import-estimate` block lines 118–128), `src/console/console.css` (`.import-estimate` rules, lines 1602–1604), `tests/mdh-import-confirm.test.js` (base props line 10, three estimate tests lines 50–70), `tests/mdh-import-wizard.test.js` (estimate test lines 198–223)

**Interfaces:**
- Produces: `ImportConfirm` props no longer include `estimate`/`estimateLoading`; wizard has no estimate state. Nothing else may reference `estimateMatches` or `import-estimate`.

- [ ] **Step 1: Delete the module + its test; excise wizard wiring**

```bash
rm src/mdh/matchEstimate.js tests/mdh-match-estimate.test.js
```

In `ImportWizard.jsx` remove: the `import { estimateMatches } ...` line; the `estimate`/`estimateLoading` `useState` pair; the `estKeysKey` const and the whole estimate `useEffect`; the `estimate={estimate} estimateLoading={estimateLoading}` props.
In `ImportConfirm.jsx` remove `estimate, estimateLoading,` from the destructured props and delete the entire `{isUpdate && keys.length > 0 && (<div class="import-estimate" ...>...)}` block.
In `console.css` delete the three `.import-estimate` rules.

- [ ] **Step 2: Update tests** — in `tests/mdh-import-confirm.test.js`: drop `estimate: null, estimateLoading: false,` from `base` and delete the three estimate `it(...)` blocks. In `tests/mdh-import-wizard.test.js`: delete the `'Update shows a matched-vs-insert estimate from the chosen key'` test.

- [ ] **Step 3: Verify no references remain and tests pass**

Run: `grep -rn "estimateMatches\|matchEstimate\|import-estimate\|estimateLoading" src/ tests/` — Expected: no output.
Run: `npx vitest run tests/mdh-import-confirm.test.js tests/mdh-import-wizard.test.js`
Expected: PASS.

### Task 7: Verbose "What will happen" step lists + key guard in `ImportConfirm.jsx`

**Files:**
- Modify: `src/mdh/components/ImportConfirm.jsx`, `src/console/console.css` (replace `.import-summary` rules, lines 1599–1601)
- Test: `tests/mdh-import-confirm.test.js`

**Interfaces:**
- Consumes: `countRowsMissingKeys(docs, keys)` (Task 3), `shapeCount` prop (Task 5).
- Produces: `data-testid="import-plan"` now contains the step list; `data-testid="import-key-guard"` blocking panel; `canImport` additionally requires `missingKeyRows === 0` in Update mode.

- [ ] **Step 1: Write the failing tests** — in `tests/mdh-import-confirm.test.js`: replace the insert (lines 13–17) and replace (lines 27–30) summary tests with the step-list tests below; in the existing `'update requires match keys (Go disabled until a key is chosen)'` test (lines 19–25) KEEP both button-state assertions and only swap its final text expectation to `expect(withKeys.querySelector('[data-testid="import-plan"]').textContent).toMatch(/matched to existing records by sku/i);`. Then add the new update/guard/hint tests:

```js
  it('insert step list explains verified insert behavior and enables Go', () => {
    const root = mount(h(ImportConfirm, { ...base, mode: 'insert' }));
    const t = root.querySelector('[data-testid="import-plan"]').textContent;
    expect(root.querySelector('[data-testid="import-go"]').disabled).toBe(false);
    expect(t).toMatch(/What will happen/i);
    expect(t).toMatch(/added as a new record/i);
    expect(t).toMatch(/never modified/i);
    expect(t).toMatch(/already exists in the collection is rejected/i);
    expect(t).toMatch(/cancelling keeps the rows already inserted/i);
  });

  it('update step list explains verified upsert behavior including the _id gotcha', () => {
    const root = mount(h(ImportConfirm, { ...base, mode: 'update', keys: ['sku'] }));
    const t = root.querySelector('[data-testid="import-plan"]').textContent;
    expect(t).toMatch(/matched to existing records by sku/i);
    expect(t).toMatch(/replaced by the row entirely/i);
    expect(t).toMatch(/only one of them is updated/i);
    expect(t).toMatch(/match nothing are inserted/i);
    expect(t).toMatch(/_id.*ignored/i);
    expect(t).toMatch(/can.t be recalled or undone/i); // apostrophe is curly (U+2019) in the copy
  });

  it('update step list prompts for keys when none chosen', () => {
    const root = mount(h(ImportConfirm, { ...base, mode: 'update', keys: [] }));
    expect(root.querySelector('[data-testid="import-plan"]').textContent).toMatch(/Choose one or more fields/i);
  });

  it('replace step list explains wipe-and-load including the _id gotcha', () => {
    const root = mount(h(ImportConfirm, { ...base, mode: 'replace' }));
    const t = root.querySelector('[data-testid="import-plan"]').textContent;
    expect(t).toMatch(/Deletes every existing record/i);
    expect(t).toMatch(/Custom indexes are kept/i);
    expect(t).toMatch(/ids from an export are not preserved/i);
  });

  it('blocks Update with the exact missing-key row count', () => {
    const mixed = [{ sku: 'A' }, { name: 'no-key' }, { name: 'also-none' }];
    const root = mount(h(ImportConfirm, { ...base, docs: mixed, mode: 'update', keys: ['sku'] }));
    const guard = root.querySelector('[data-testid="import-key-guard"]');
    expect(guard.textContent).toMatch(/2 rows are missing/);
    expect(guard.textContent).toMatch(/sku/);
    expect(root.querySelector('[data-testid="import-go"]').disabled).toBe(true);
  });

  it('shows the random-sample size when a shape was derived', () => {
    const shape = deriveShape([{ sku: 'A1', price: 10 }]);
    const root = mount(h(ImportConfirm, { ...base, validateShape: true, shape, shapeCount: 137, docs: [{ sku: 'B2', price: 20 }] }));
    expect(root.querySelector('[data-testid="import-shape"]').textContent).toMatch(/random sample of 137/i);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mdh-import-confirm.test.js`
Expected: new tests FAIL (old one-line summary rendered; no guard testid).

- [ ] **Step 3: Implement** — in `ImportConfirm.jsx`:

Imports/props: add `shapeCount` to props; `import { collectFieldPaths, countRowsMissingKeys } from '../importPlan.js';`.

Guard computation (after `fieldPaths`):

```js
  const missingKeyRows = useMemo(
    () => (isUpdate && keys.length > 0 ? countRowsMissingKeys(docs, keys) : 0),
    [isUpdate, docs, keys],
  );
```

`canImport` for update becomes `keys.length > 0 && shapeOk && missingKeyRows === 0`.

Sample-size hint — inside the `import-shape` div, after the success line:

```jsx
          {!shapeLoading && shape && (
            <div class="input-hint">Checked against a random sample of {shapeCount.toLocaleString()} existing records.</div>
          )}
```

Replace the whole `import-summary` div with the step list (copy verbatim — each claim maps to spec facts F2–F11):

```jsx
      <div class="import-steps" data-testid="import-plan">
        <div class="import-steps-head">What will happen</div>
        {mode === 'insert' && (
          <ul>
            <li>Every row is added as a new record. Existing records are never modified.</li>
            <li>Rows keep their <code>_id</code> if they have one; rows without one get a server-assigned id. If several rows in the file share an <code>_id</code>, the first is kept and the rest are dropped before upload.</li>
            <li>A row whose <code>_id</code> already exists in the collection is rejected by the server; the other rows still import, and every rejection is reported at the end.</li>
            <li>Runs from this browser in batches of 1,000 {'—'} cancelling keeps the rows already inserted.</li>
          </ul>
        )}
        {isUpdate && keys.length === 0 && <ul><li>Choose one or more fields to match existing records by.</li></ul>}
        {isUpdate && keys.length > 0 && (
          <ul>
            <li>Each row is matched to existing records by <code>{keys.join(', ')}</code>.</li>
            <li>A matched record is <strong>replaced by the row entirely</strong> {'—'} fields the row doesn{'’'}t include are removed. The record keeps its <code>_id</code>.</li>
            <li>If several existing records share the same key value, only <strong>one</strong> of them is updated (which one is not guaranteed).</li>
            <li>Rows that match nothing are <strong>inserted</strong> as new records.</li>
            <li>Existing records not matched by any row are left untouched.</li>
            <li><code>_id</code> values in the file are ignored {'—'} records are identified only by the match keys, never by <code>_id</code>. A re-imported export can{'’'}t be matched by <code>_id</code>; pick a business key instead.</li>
            <li>Runs on the Rossum server as a single operation (typically 30{'–'}60 s, even for small files). Once started it can{'’'}t be recalled or undone.</li>
          </ul>
        )}
        {isReplace && (
          <ul>
            <li><strong>Deletes every existing record</strong>, then loads this file as the collection{'’'}s entire new contents.</li>
            <li>Custom indexes are kept. <code>_id</code> values in the file are ignored {'—'} the server assigns fresh ids, so record ids from an export are not preserved.</li>
            <li>Runs on the Rossum server (typically 30{'–'}60 s). Once started it can{'’'}t be recalled or undone.</li>
          </ul>
        )}
      </div>
```

Key guard panel (between the step list and `.modal-actions`):

```jsx
      {isUpdate && keys.length > 0 && missingKeyRows > 0 && (
        <div class="import-error" data-testid="import-key-guard" role="alert">
          <div class="import-error-head">
            <span class="import-error-icon" aria-hidden="true">{'⚠'}</span>
            <span><strong>{missingKeyRows.toLocaleString()} row{missingKeyRows === 1 ? ' is' : 's are'} missing <code>{keys.join(', ')}</code>.</strong> The server rejects the whole import if any row lacks a match key. Fix the file or pick different keys.</span>
          </div>
        </div>
      )}
```

CSS — replace the three `.import-summary` rules in `console.css` with:

```css
.import-steps { margin-top: 14px; font-size: 13px; line-height: 1.5; color: var(--text-secondary); }
.import-steps-head { font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-primary); margin-bottom: 4px; }
.import-steps ul { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 3px; }
.import-steps strong { color: var(--text-primary); }
.import-steps code { font-family: var(--font-mono); font-size: 11px; background: var(--bg-hover); padding: 1px 4px; border-radius: 3px; color: var(--text-primary); }
```

Then `grep -n "import-summary" src/ tests/ -r` — remove/adjust any remaining references (the old insert-count `<strong>` line is gone; `insertStats`/`insertCount` stay — the go-button label uses them).

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/mdh-import-confirm.test.js`
Expected: PASS.

### Task 8: `_id` fix — strip on upload, drop `_id` defaults and picker entry

**Files:**
- Modify: `src/mdh/components/ImportWizard.jsx` (upload blob, `defaultKeysFor` call sites lines 76/92/108, import line 8), `src/mdh/components/ImportConfirm.jsx` (remove `defaultKeysFor` export lines 16–20; filter picker paths)
- Test: `tests/mdh-import-wizard.test.js`, `tests/mdh-import-confirm.test.js`

**Interfaces:**
- Consumes: `stripIds` (Task 4).
- Produces: Update/Replace upload bodies carry no `_id`; match keys start `[]`; `MatchKeyPicker` never offers `_id`. `defaultKeysFor` no longer exists.

- [ ] **Step 1: Update the wizard routing tests** — in `tests/mdh-import-wizard.test.js`:

Replace the Update routing test body (lines 137–169) with one that picks a business key via the picker and asserts `_id` is stripped:

```js
  it('Update requires picking a business key and uploads _id-less rows', async () => {
    selectedCollection.value = 'products';
    const docs = [{ _id: '1', name: 'Foo' }, { _id: '2', name: 'Bar' }];
    const root = mount(h(ImportWizard, { onSuccess: vi.fn() }));
    await toConfirmViaFile(root, docs);

    const modeUpdate = [...root.querySelectorAll('.csv-seg-opt')].find((b) => b.textContent.trim() === 'Update');
    modeUpdate.click();

    // No auto-default: the go button stays disabled until a key is chosen,
    // and _id is not offered as a suggestion.
    const keyInput = await waitFor(() => root.querySelector('[data-testid="match-key-input"]'));
    expect(root.querySelector('[data-testid="import-go"]').disabled).toBe(true);
    keyInput.focus();
    const items = await waitFor(() => {
      const btns = [...root.querySelectorAll('[data-testid="match-key-suggest"] button')];
      return btns.length ? btns : null;
    });
    expect(items.map((b) => b.textContent.trim())).not.toContain('_id');
    items.find((b) => b.textContent.trim() === 'name').click();

    const goBtn = await waitFor(() => { const b = root.querySelector('[data-testid="import-go"]'); return b && !b.disabled ? b : null; });
    goBtn.click();

    await waitFor(() => api.datasetUpdate.mock.calls.length > 0);
    const [collArg, blobArg, keysArg] = api.datasetUpdate.mock.calls[0];
    expect(collArg).toBe('products');
    expect(keysArg).toEqual(['name']);
    const body = JSON.parse(await blobArg.text());
    expect(body).toHaveLength(docs.length);
    for (const row of body) expect(row).not.toHaveProperty('_id');
    expect(body[0].name).toBe('Foo'); // rows otherwise intact
  });
```

In the Replace routing test, change the `_id` assertion (line 128) to:

```js
    expect(body[0]).not.toHaveProperty('_id');
    expect(body[0].name).toBe('Foo');
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mdh-import-wizard.test.js`
Expected: FAIL — keys auto-default to `_id`, upload bodies still carry `_id`.

- [ ] **Step 3: Implement** — in `ImportWizard.jsx`:
  - `import { runChunkedInsert, dedupeById, stripIds } from '../importFile.js';`
  - Drop `defaultKeysFor` from the `ImportConfirm.jsx` import; replace all three `setKeys(defaultKeysFor(...))` calls with `setKeys([])`.
  - In `startImport`, build the server-mode blob from stripped rows: `const blob = new Blob([JSON.stringify(stripIds(docs))], { type: 'application/json' });`

  In `ImportConfirm.jsx`: delete the `defaultKeysFor` export; pass `_id`-less paths to the picker:

```jsx
          <MatchKeyPicker paths={fieldPaths.filter((p) => p !== '_id')} keys={keys} setKeys={setKeys} />
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/mdh-import-wizard.test.js tests/mdh-import-confirm.test.js`
Expected: PASS. Also run `grep -rn "defaultKeysFor" src/ tests/` — Expected: no output.

### Task 9: Whitespace findings rendered visibly in the shape-error block

**Files:**
- Modify: `src/mdh/components/ImportConfirm.jsx` (shape-error block, previously lines 81–100)
- Test: `tests/mdh-import-confirm.test.js`

**Interfaces:**
- Consumes: `shapeCheck.whitespace` (Task 1), `SpecialText` `markEdgeSpaces` (Task 2).

- [ ] **Step 1: Write the failing tests** — append to `tests/mdh-import-confirm.test.js`:

```js
  it('reports a whitespace-only column difference explicitly and visibly', () => {
    const shape = deriveShape([{ sku: 'A1', price: 10 }]);
    const root = mount(h(ImportConfirm, {
      ...base, validateShape: true, shape, shapeCount: 1,
      docs: [{ 'sku ': 'B2', price: 20 }],
    }));
    const err = root.querySelector('[data-testid="import-shape-error"]');
    expect(err.textContent).toMatch(/only by leading\/trailing whitespace/i);
    expect(err.textContent).toMatch(/"sku·"/);      // file side, marked
    expect(err.textContent).toMatch(/"sku"/);            // existing side
    expect(err.querySelector('.mdh-special-space')).toBeTruthy();
    expect(root.querySelector('[data-testid="import-go"]').disabled).toBe(true);
  });

  it('renders Missing/Unexpected names through the whitespace-revealing renderer', () => {
    const shape = deriveShape([{ 'region\u00A0': 'EU' }]); // NBSP (U+00A0) lives in the DB field name
    const root = mount(h(ImportConfirm, {
      ...base, validateShape: true, shape, shapeCount: 1,
      docs: [{ zone: 'EU' }],
    }));
    const err = root.querySelector('[data-testid="import-shape-error"]');
    expect(err.textContent).toContain('NBSP'); // DB-side NBSP made visible in the Missing list
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mdh-import-confirm.test.js`
Expected: FAIL — names render as plain text; no whitespace row.

- [ ] **Step 3: Implement** — in `ImportConfirm.jsx`: `import SpecialText from './SpecialText.jsx';` and add a tiny local helper above the component:

```jsx
function FieldName({ name }) {
  return <code><SpecialText value={name} quote markEdgeSpaces /></code>;
}
```

Replace the three list renderings inside `import-error-list`:

```jsx
                {shapeCheck.whitespace.length > 0 && (
                  <li><span class="import-error-label">Whitespace</span><span class="import-error-fields">
                    {shapeCheck.whitespace.map((w) => (
                      <span key={w.got}><FieldName name={w.got} /> (file) vs <FieldName name={w.expected} /> (existing)</span>
                    ))}
                  </span></li>
                )}
                {shapeCheck.missing.length > 0 && (
                  <li><span class="import-error-label">Missing</span><span class="import-error-fields">{shapeCheck.missing.map((p) => <FieldName key={p} name={p} />)}</span></li>
                )}
                {shapeCheck.unknown.length > 0 && (
                  <li><span class="import-error-label">Unexpected</span><span class="import-error-fields">{shapeCheck.unknown.map((p) => <FieldName key={p} name={p} />)}</span></li>
                )}
                {shapeCheck.typeMismatch.length > 0 && (
                  <li><span class="import-error-label">Wrong type</span><span class="import-error-fields">{shapeCheck.typeMismatch.map((t) => <code key={t.path}><SpecialText value={t.path} quote markEdgeSpaces />{`: ${t.expected.join('/')} → ${t.got}`}</code>)}</span></li>
                )}
```

And extend the hint line under the list when whitespace findings exist:

```jsx
              <div class="import-error-hint">
                {shapeCheck.whitespace.length > 0 && <span>Columns marked {'·'} differ only by leading/trailing whitespace. </span>}
                Fix the file to match, or turn off shape validation above to import anyway.
              </div>
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/mdh-import-confirm.test.js`
Expected: PASS.

### Task 10: Full-suite verification + build

**Files:** none new.

- [ ] **Step 1: Reference sweep**

Run: `grep -rn "estimateMatches\|matchEstimate\|import-estimate\|estimateLoading\|defaultKeysFor\|import-summary" src/ tests/`
Expected: no output. (If `import-summary` remains in CSS only, delete it there.)

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all green (baseline was 1579+; net test count grows).

- [ ] **Step 3: Build for the browser**

Run: `npm run build`
Expected: clean build. Remind the user: tests run against `src/`, but the loaded extension runs `dist/` — reload the extension to see the new confirm screen.

- [ ] **Step 4: NO commit** — leave all changes uncommitted on `master` (user preference).

### Task 11: Clipboard editor accepts JSON-lines (user-reported bug, added 2026-07-03)

**Files:**
- Modify: `src/mdh/components/JsonEditor.jsx` (JSON5 validation, lines ~137–149, ~189–191, ~231), `src/mdh/components/ImportWizard.jsx` (clipboard `<JsonEditor>`)
- Test: `tests/mdh-import-wizard.test.js` (or the JsonEditor test file if one exists — check `ls tests/ | grep -i json-editor`)

**Context/bug:** The clipboard import stage says "Paste or type JSON (array, object, or JSON-lines)" and its Next path (`getFormat('json').parse`) accepts JSON-lines via the NDJSON fallback — verified: `{"a":1}\n{"b":1}\n{"c":1}` parses to 3 docs. But `JsonEditor` validates every change with bare `JSON5.parse`, so JSON-lines input shows a red `JSON5: invalid character '{' at 2:1` error while being perfectly importable. The editor must not contradict the wizard.

**Interfaces:**
- Produces: `JsonEditor` accepts `jsonLines` (bool, default false). When true, content that fails `JSON5.parse` is re-checked line-wise (each non-empty line `JSON.parse`d); if every line parses, the content is VALID (no error text, no `json-editor-invalid` class, `isValid()` true). JSON5-only behavior everywhere else is unchanged (the pipeline editor must not become lenient).
- `ImportWizard` passes `jsonLines` to the clipboard editor only.

- [ ] **Step 1: Write the failing test** — drive the wizard's clipboard mode with JSON-lines and assert the editor shows no error (and Next works):

```js
describe('ImportWizard — clipboard JSON-lines', () => {
  it('accepts JSON-lines in the clipboard editor without a validation error', async () => {
    const root = mount(h(ImportWizard, { onSuccess: vi.fn() }));
    const clip = [...root.querySelectorAll('.csv-seg-opt')].find((b) => b.textContent.trim() === 'Clipboard');
    clip.click();
    await waitFor(() => root.querySelector('.cm-content'));
    // Type JSON-lines into the CodeMirror editor via its view API is heavy in jsdom;
    // instead assert the prop wiring + validation contract at the JsonEditor level
    // if direct typing is impractical — see the JsonEditor-level test below.
  });
});
```

If driving CodeMirror in jsdom proves impractical (known limitation), test the validation contract directly instead: extract the validation decision into a small exported pure helper in `JsonEditor.jsx`:

```js
// Pure: is `text` acceptable for this editor instance? JSON5 everywhere;
// with jsonLines also accept NDJSON (every non-empty line strict JSON).
export function isAcceptable(text, { jsonLines = false } = {}) {
  try { JSON5.parse(text); return true; } catch { /* fall through */ }
  if (!jsonLines) return false;
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return false;
  try { for (const l of lines) JSON.parse(l); return true; } catch { return false; }
}
```

and test it in a plain unit test file (`tests/mdh-json-editor-accept.test.js`):

```js
import { describe, it, expect } from 'vitest';
import { isAcceptable } from '../src/mdh/components/JsonEditor.jsx';

describe('JsonEditor isAcceptable', () => {
  it('accepts JSON5 everywhere', () => {
    expect(isAcceptable('{a: 1}', {})).toBe(true);
    expect(isAcceptable('{a: 1}', { jsonLines: true })).toBe(true);
  });
  it('accepts JSON-lines only when jsonLines is set', () => {
    const nd = '{"a":1}\n{"b":1}\n{"c":1}';
    expect(isAcceptable(nd, {})).toBe(false);
    expect(isAcceptable(nd, { jsonLines: true })).toBe(true);
  });
  it('rejects garbage in both modes', () => {
    expect(isAcceptable('{"a":1}\nnot json', { jsonLines: true })).toBe(false);
    expect(isAcceptable('', { jsonLines: true })).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/mdh-json-editor-accept.test.js` — FAIL (no export).

- [ ] **Step 3: Implement** — add `isAcceptable` (exported, above the component); thread a `jsonLines` prop through `JsonEditor` and use `isAcceptable(text, { jsonLines })` at ALL THREE validation sites (change-listener ~line 142, initial validation ~line 190, `isValid()` ~line 231) so the error banner, invalid styling, `onValidChange`, and `isValid()` all agree. When acceptable-but-not-JSON5, the error text must be cleared exactly like the valid case. `getParsed()` stays JSON5-only (its callers are pipeline-editor paths; the wizard uses `getValue`). In `ImportWizard.jsx`, pass `jsonLines` on the clipboard `<JsonEditor ...>` only.

- [ ] **Step 4: Run to verify pass** — `npx vitest run tests/mdh-json-editor-accept.test.js tests/mdh-import-wizard.test.js` — PASS.
