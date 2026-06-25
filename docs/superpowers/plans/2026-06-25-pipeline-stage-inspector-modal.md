# Full-pipeline stage inspector modal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the small one-stage-at-a-time preview modal with a near-fullscreen modal showing every pipeline stage's sample output at once (Atlas-style), reusing the data-view `RecordCard`.

**Architecture:** A new `PipelineInspector` component renders the modal body — a vertical list of stage sections (input + one per stage), each with the stage definition and its sample output (read-only `RecordCard`s). `PipelineDebug` opens it on row-click, passing the counts it already computed. `RecordCard` gains a `readOnly` mode.

**Tech Stack:** Preact + `@preact/signals`, esbuild (IIFE), Vitest (jsdom), the MDH Data Storage REST client (`src/mdh/api.js`).

## Global Constraints

- **No git commits during this run.** Per the project owner's standing preference, do NOT `git commit` intermediate work; stay on `master`, no branches/worktrees. Each task ends by running its tests; the final task runs the full suite + build. (Replaces the usual "Commit" step.)
- **Preact classic JSX:** every `.jsx` file starts with `import { h } from 'preact';`. Tests are `.test.js` rendering via `h(Component, null)` (never raw JSX in `.test.js`).
- **Tests:** `npm test` = `vitest run`. Single file: `npx vitest run tests/<file>.test.js`. jsdom env via top-of-file `// @vitest-environment jsdom`. Use `waitFor`-polling for async, never fixed `setTimeout` sleeps. `chrome` is not globally mocked — set `globalThis.chrome` in the test.
- **Safety invariants (must hold for every aggregation the modal issues):** `$search` stays the first stage of any prefix request; `stripWriteStages` (`src/mdh/pipelineOps.js`) removes `$out`/`$merge` from every request.
- **Backward compatibility:** the inline `PipelineDebug` panel behavior is unchanged (counts, timing, slow-flag, toggles, error blocks, tooltips, `$collStats` input row). `RecordCard` `readOnly` defaults `false` → existing call sites (data view, BulkDelete/BulkUpdate, selection mode) unaffected. Keep `.sample-card(s)` CSS (BulkDelete/BulkUpdate use it); only retire `.pipeline-inspect-info`.
- **JSX unicode:** render glyphs via JS-expression strings (e.g. `{'→'}`) or literal characters, never `\uXXXX` in raw JSX text/attributes.

---

## File Structure

- **Create** `src/mdh/components/PipelineInspector.jsx` — modal body: stage sections + per-stage preview fetch + read-only doc rendering + docs/stage selector + scroll-to-clicked.
- **Create** `tests/mdh-pipeline-inspector.test.js` — unit tests for the above.
- **Create** `tests/mdh-record-card.test.js` — unit tests for `RecordCard` `readOnly`.
- **Modify** `src/mdh/components/RecordCard.jsx` — add `readOnly` prop.
- **Modify** `src/mdh/components/PipelineDebug.jsx` — open `PipelineInspector` on click; remove `StageInspector` + `DEBUG_PREVIEW_LIMIT`.
- **Modify** `tests/mdh-pipeline-debug.test.js` — retarget the one `StageInspector`-specific test.
- **Modify** `src/console/console.css` — add `.modal-card:has(.pipeline-inspect)` + `.pipeline-inspect-*` rules; remove `.pipeline-inspect-info`.
- **Modify** `CLAUDE.md` — add `mdhInspectSampleSize` storage key; touch up MDH component note.

---

## Task 1: `RecordCard` read-only mode

**Files:**
- Modify: `src/mdh/components/RecordCard.jsx`
- Test: `tests/mdh-record-card.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `RecordCard` accepts optional prop `readOnly` (boolean, default `false`). When `true`: no Edit/Del buttons, no selection checkbox (ignores global `selectionMode`); keeps Copy + chevron expand/collapse + `JsonTree` body.

- [ ] **Step 1: Write the failing test**

Create `tests/mdh-record-card.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';
import RecordCard from '../src/mdh/components/RecordCard.jsx';
import { selectionMode } from '../src/mdh/store.js';

function mount(props) {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(RecordCard, {
    record: { _id: '1', name: 'ACME' },
    index: 0,
    expanded: true,
    onToggle: () => {},
    onCopy: () => {},
    onEdit: () => {},
    onDelete: () => {},
    sortState: {},
    filterState: {},
    onSort: () => {},
    onFilter: () => {},
    charBudget: 80,
    indexes: [],
    ...props,
  }), root);
  return root;
}

beforeEach(() => { selectionMode.value = false; });

describe('RecordCard readOnly', () => {
  it('default (not readOnly) shows Edit and Del actions', () => {
    const root = mount({});
    expect(root.querySelector('.action-edit')).not.toBeNull();
    expect(root.querySelector('.action-delete')).not.toBeNull();
    expect(root.querySelector('.action-copy')).not.toBeNull();
  });

  it('readOnly hides Edit/Del but keeps Copy and renders the JSON body', () => {
    const root = mount({ readOnly: true });
    expect(root.querySelector('.action-edit')).toBeNull();
    expect(root.querySelector('.action-delete')).toBeNull();
    expect(root.querySelector('.action-copy')).not.toBeNull();
    // Expanded body renders the JsonTree.
    expect(root.querySelector('.json-tree')).not.toBeNull();
  });

  it('readOnly suppresses the selection checkbox even in selection mode', () => {
    selectionMode.value = true;
    const root = mount({ readOnly: true });
    expect(root.querySelector('.record-checkbox')).toBeNull();
    expect(root.querySelector('.action-edit')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mdh-record-card.test.js`
Expected: the `readOnly` cases FAIL (Edit/Del/checkbox still render).

- [ ] **Step 3: Implement the prop**

In `src/mdh/components/RecordCard.jsx`, add `readOnly = false` to the destructured props (after `indexes`):

```jsx
export default function RecordCard({
  record,
  index,
  expanded,
  onToggle,
  onCopy,
  onEdit,
  onDelete,
  sortState,
  filterState,
  onSort,
  onFilter,
  charBudget,
  indexes,
  readOnly = false,
}) {
```

Change the selection-mode line so read-only never enters selection mode:

```jsx
  const isSelectionMode = !readOnly && selectionMode.value;
```

Gate Edit and Del on `!readOnly` as well (replace the two existing buttons):

```jsx
          {!isSelectionMode && !readOnly && (
            <button class="action-edit" title="Edit with update expression" onClick={() => onEdit(record)}>Edit</button>
          )}
          {!isSelectionMode && !readOnly && (
            <button class="action-delete" title="Delete this record" onClick={() => onDelete(record, index)}>Del</button>
          )}
```

(The Copy button, chevron, summary, and `JsonTree` body are unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mdh-record-card.test.js`
Expected: PASS (all 3).

- [ ] **Step 5: Verify no regression in RecordCard consumers**

Run: `npx vitest run tests/mdh-record-list-footer.test.js tests/mdh-record-selection.test.js`
Expected: PASS.

---

## Task 2: `PipelineInspector` core (sections + per-stage previews)

**Files:**
- Create: `src/mdh/components/PipelineInspector.jsx`
- Test: `tests/mdh-pipeline-inspector.test.js`

**Interfaces:**
- Consumes: `RecordCard` with `readOnly` (Task 1); `api.aggregate(collection, pipeline, { signal })` → `{ result: [...] }`; `stripWriteStages(stages)`.
- Produces: `export default function PipelineInspector({ collection, entries, counts = {}, inputInfo = null, clickedIndex = -1 })`.
  - `entries`: `{ disabled: boolean, stage: object }[]` (same shape `PipelineDebug` renders).
  - `counts`: object keyed by **active-stage index** → `{ count?: number, ms?: number, error?: {...} }` (the panel's `stageCounts`).
  - `inputInfo`: `{ count?: number, ms?: number, error?: {...} } | null` (the panel's `inputInfo`).
  - `clickedIndex`: active-stage index to scroll to; `-1` = input section. (Scroll behavior added in Task 4; the prop is accepted now and `data-idx` attributes are rendered.)
  - Root element has `class="pipeline-inspect"`. Each section has `class="pipeline-inspect-section"` and `data-idx` (`-1` for input, active index otherwise). Active stages issue `api.aggregate(collection, [...stripWriteStages(prefix), { $limit: 10 }], { signal })`; input issues `[{ $limit: 10 }]`. Read-only docs render via `RecordCard` (`readOnly`).

- [ ] **Step 1: Write the failing test**

Create `tests/mdh-pipeline-inspector.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';

globalThis.chrome = { storage: { local: { get: (k, cb) => cb && cb({}), set() {}, remove() {} } } };

vi.mock('../src/mdh/api.js');
// Stub RecordCard so we can assert the readOnly prop is passed without depending
// on RecordCard internals (those are covered by tests/mdh-record-card.test.js).
vi.mock('../src/mdh/components/RecordCard.jsx', () => ({
  default: (props) => h('div', { class: 'rc-stub', 'data-readonly': String(!!props.readOnly) }, JSON.stringify(props.record)),
}));

import * as api from '../src/mdh/api.js';
import PipelineInspector from '../src/mdh/components/PipelineInspector.jsx';

async function waitFor(condition, description = 'condition', timeoutMs = 2000) {
  const start = Date.now();
  for (;;) {
    let ok = false;
    try { ok = condition(); } catch { ok = false; }
    if (ok) return;
    if (Date.now() - start > timeoutMs) throw new Error(`Timeout waiting for ${description} after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function mount(props) {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(PipelineInspector, { counts: {}, inputInfo: null, clickedIndex: -1, ...props }), root);
  return root;
}

const previewCalls = () =>
  api.aggregate.mock.calls.filter((c) => {
    const pl = c[1];
    return Array.isArray(pl) && pl.length > 0 && pl[pl.length - 1]?.$limit != null;
  });

beforeEach(() => { vi.clearAllMocks(); });

describe('PipelineInspector core', () => {
  it('renders an input section plus one section per active stage', async () => {
    const entries = [
      { disabled: false, stage: { $match: { x: 1 } } },
      { disabled: false, stage: { $limit: 50 } },
    ];
    api.aggregate.mockResolvedValue({ result: [{ _id: 'a' }] });

    const root = mount({ collection: 'vendors', entries });
    await waitFor(() => root.querySelectorAll('.pipeline-inspect-section').length === 3, '3 sections');

    const text = root.textContent;
    expect(text).toContain('input');
    expect(text).toContain('$match');
    expect(text).toContain('$limit');
  });

  it('fires one $limit preview per active stage plus input, $search first', async () => {
    const search = { $search: { index: 'default', text: { query: 'foo', path: 'name' } } };
    const entries = [
      { disabled: false, stage: search },
      { disabled: false, stage: { $match: { x: 1 } } },
    ];
    api.aggregate.mockResolvedValue({ result: [] });

    mount({ collection: 'vendors', entries });
    await waitFor(() => previewCalls().length >= 3, 'input + 2 stage previews');

    const calls = previewCalls();
    // Input preview is exactly [{ $limit: 10 }].
    expect(calls.some((c) => JSON.stringify(c[1]) === JSON.stringify([{ $limit: 10 }]))).toBe(true);
    // Stage previews start with $search and end with { $limit: 10 }.
    const stagePreviews = calls.filter((c) => c[1].length > 1);
    expect(stagePreviews.length).toBe(2);
    for (const [, pl] of stagePreviews) {
      expect(pl[0]).toEqual(search);
      expect(pl[pl.length - 1]).toEqual({ $limit: 10 });
    }
  });

  it('strips $out/$merge from every preview request', async () => {
    const entries = [
      { disabled: false, stage: { $match: {} } },
      { disabled: false, stage: { $out: 'archive' } },
    ];
    api.aggregate.mockResolvedValue({ result: [] });

    mount({ collection: 'vendors', entries });
    await waitFor(() => previewCalls().length >= 3, 'previews issued');

    for (const [, pl] of api.aggregate.mock.calls) {
      for (const stage of pl) {
        const key = Object.keys(stage)[0];
        expect(key).not.toBe('$out');
        expect(key).not.toBe('$merge');
      }
    }
  });

  it('renders read-only RecordCards for the docs', async () => {
    const entries = [{ disabled: false, stage: { $match: {} } }];
    api.aggregate.mockResolvedValue({ result: [{ _id: '1', name: 'ACME' }] });

    const root = mount({ collection: 'vendors', entries });
    await waitFor(() => root.querySelectorAll('.rc-stub').length > 0, 'doc cards rendered');

    for (const stub of root.querySelectorAll('.rc-stub')) {
      expect(stub.getAttribute('data-readonly')).toBe('true');
    }
  });

  it('surfaces a per-stage preview error independently', async () => {
    const entries = [
      { disabled: false, stage: { $match: {} } },
      { disabled: false, stage: { $sort: { _id: 1 } } },
    ];
    api.aggregate.mockImplementation((col, pl) => {
      // input ok
      if (JSON.stringify(pl) === JSON.stringify([{ $limit: 10 }])) return Promise.resolve({ result: [{ _id: 'i' }] });
      // stage 2 (contains $sort) errors; stage 1 ok
      if (JSON.stringify(pl).includes('$sort')) return Promise.reject(Object.assign(new Error('boom'), { status: 400 }));
      return Promise.resolve({ result: [{ _id: '1' }] });
    });

    const root = mount({ collection: 'vendors', entries });
    await waitFor(() => root.querySelector('.pipeline-inspect-error'), 'error rendered');

    const err = root.querySelector('.pipeline-inspect-error');
    expect(err.textContent).toContain('boom');
    expect(err.textContent).toMatch(/400/);
    // The other stage still rendered doc cards.
    expect(root.querySelectorAll('.rc-stub').length).toBeGreaterThan(0);
  });

  it('renders disabled stages greyed and issues no preview for them', async () => {
    const entries = [
      { disabled: false, stage: { $match: {} } },
      { disabled: true, stage: { $sort: { a: -1 } } },
    ];
    api.aggregate.mockResolvedValue({ result: [] });

    const root = mount({ collection: 'vendors', entries });
    await waitFor(() => previewCalls().length >= 2, 'input + 1 active preview');

    expect(root.querySelector('.pipeline-inspect-disabled')).not.toBeNull();
    for (const [, pl] of api.aggregate.mock.calls) {
      expect(JSON.stringify(pl)).not.toContain('$sort');
    }
  });

  it('shows a count delta and timing in the stage header from passed-in counts', async () => {
    const entries = [{ disabled: false, stage: { $match: {} } }];
    api.aggregate.mockResolvedValue({ result: [] });

    const root = mount({
      collection: 'vendors',
      entries,
      counts: { 0: { count: 420, ms: 34 } },
      inputInfo: { count: 1240, ms: 12 },
    });
    await waitFor(() => root.querySelector('.pipeline-inspect-section'), 'sections rendered');

    const text = root.textContent;
    expect(text).toContain('1,240'); // input count / delta-from
    expect(text).toContain('420');   // stage count
    expect(text).toContain('34ms');  // stage timing
    expect(text).toContain('12ms');  // input timing
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mdh-pipeline-inspector.test.js`
Expected: FAIL — `PipelineInspector.jsx` does not exist.

- [ ] **Step 3: Implement `PipelineInspector.jsx`**

Create `src/mdh/components/PipelineInspector.jsx`:

```jsx
import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import * as api from '../api.js';
import { stripWriteStages } from '../pipelineOps.js';
import RecordCard from './RecordCard.jsx';

const DEFAULT_SAMPLE = 10;
const SLOW_QUERY_MS = 1000;

const timeCls = (ms) => 'pipeline-inspect-time' + (ms > SLOW_QUERY_MS ? ' pipeline-inspect-time-slow' : '');

// One sample document, with its own expand/collapse state. RecordCard's expand
// is controlled by the parent, so we hold the state here and feed it back.
function InspectorDoc({ record, index }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <RecordCard
      record={record}
      index={index}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
      onCopy={() => {}}
      onEdit={() => {}}
      onDelete={() => {}}
      sortState={{}}
      filterState={{}}
      onSort={() => {}}
      onFilter={() => {}}
      charBudget={80}
      indexes={[]}
      readOnly
    />
  );
}

function StageHeader({ num, label, prevCount, count, ms }) {
  let countText = '…';
  let countCls = 'pipeline-inspect-count';
  if (typeof count === 'number') {
    countText = (typeof prevCount === 'number' && prevCount !== count)
      ? `${prevCount.toLocaleString()} ${'→'} ${count.toLocaleString()} docs`
      : `${count.toLocaleString()} docs`;
    if (count === 0) countCls += ' pipeline-inspect-zero';
  }
  return (
    <div class="pipeline-inspect-section-head">
      <span class="pipeline-inspect-num">{num}</span>
      <span class="pipeline-inspect-key">{label}</span>
      <span class={countCls}>{countText}</span>
      {typeof ms === 'number' && <span class={timeCls(ms)}>{ms}ms</span>}
    </div>
  );
}

function StageOutput({ info }) {
  if (!info) return <div class="pipeline-inspect-loading">Loading{'…'}</div>;
  if (info.error) {
    return (
      <div class="pipeline-inspect-error">
        {info.error.status ? `HTTP ${info.error.status}: ` : ''}{info.error.message}
      </div>
    );
  }
  if (!info.docs || info.docs.length === 0) return <div class="pipeline-inspect-empty">No documents at this stage</div>;
  return info.docs.map((doc, i) => <InspectorDoc key={i} record={doc} index={i} />);
}

export default function PipelineInspector({ collection, entries, counts = {}, inputInfo = null, clickedIndex = -1 }) {
  const [sampleSize] = useState(DEFAULT_SAMPLE);
  const [previews, setPreviews] = useState({}); // key: 'input' | activeIndex → { docs } | { error }
  const rootRef = useRef(null);

  const list = Array.isArray(entries) ? entries : [];
  const activeStages = list.filter((e) => !e.disabled).map((e) => e.stage);
  const activeKey = JSON.stringify(activeStages);

  useEffect(() => {
    if (!collection) { setPreviews({}); return; }
    setPreviews({});
    const controller = new AbortController();

    api.aggregate(collection, [{ $limit: sampleSize }], { signal: controller.signal })
      .then((res) => { if (!controller.signal.aborted) setPreviews((p) => ({ ...p, input: { docs: res.result || [] } })); })
      .catch((err) => {
        if (err?.name === 'AbortError' || controller.signal.aborted) return;
        setPreviews((p) => ({ ...p, input: { error: { message: err?.message || String(err), status: err?.status } } }));
      });

    activeStages.forEach((_, i) => {
      const prefix = activeStages.slice(0, i + 1);
      api.aggregate(collection, [...stripWriteStages(prefix), { $limit: sampleSize }], { signal: controller.signal })
        .then((res) => { if (!controller.signal.aborted) setPreviews((p) => ({ ...p, [i]: { docs: res.result || [] } })); })
        .catch((err) => {
          if (err?.name === 'AbortError' || controller.signal.aborted) return;
          setPreviews((p) => ({ ...p, [i]: { error: { message: err?.message || String(err), status: err?.status } } }));
        });
    });

    return () => controller.abort();
  }, [collection, activeKey, sampleSize]);

  let activeIdx = -1;

  return (
    <div class="pipeline-inspect" ref={rootRef}>
      <div class="pipeline-inspect-scroll">
        <section class="pipeline-inspect-section" data-idx="-1">
          <StageHeader num="0" label="input" count={inputInfo?.count} ms={inputInfo?.ms} />
          <div class="pipeline-inspect-body">
            <pre class="pipeline-inspect-def">all records (pipeline input)</pre>
            <div class="pipeline-inspect-output"><StageOutput info={previews.input} /></div>
          </div>
        </section>
        {list.map((entry, entryIndex) => {
          const stage = entry.stage || {};
          const stageKey = Object.keys(stage)[0] || '?';
          if (entry.disabled) {
            return (
              <section class="pipeline-inspect-section pipeline-inspect-disabled" key={entryIndex}>
                <div class="pipeline-inspect-section-head">
                  <span class="pipeline-inspect-num">{'–'}</span>
                  <span class="pipeline-inspect-key">{stageKey}</span>
                  <span class="pipeline-inspect-disabled-badge">disabled {'—'} not executed</span>
                </div>
              </section>
            );
          }
          activeIdx += 1;
          const myIdx = activeIdx;
          const prevCount = myIdx === 0 ? inputInfo?.count : counts[myIdx - 1]?.count;
          return (
            <section class="pipeline-inspect-section" data-idx={myIdx} key={entryIndex}>
              <StageHeader num={`${myIdx + 1}`} label={stageKey} prevCount={prevCount} count={counts[myIdx]?.count} ms={counts[myIdx]?.ms} />
              <div class="pipeline-inspect-body">
                <pre class="pipeline-inspect-def">{JSON.stringify(stage, null, 2)}</pre>
                <div class="pipeline-inspect-output"><StageOutput info={previews[myIdx]} /></div>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mdh-pipeline-inspector.test.js`
Expected: PASS (all 7).

---

## Task 3: docs/stage selector + persistence

**Files:**
- Modify: `src/mdh/components/PipelineInspector.jsx`
- Test: `tests/mdh-pipeline-inspector.test.js` (add cases)

**Interfaces:**
- Consumes: `chrome.storage.local` (`mdhInspectSampleSize`: one of `5 | 10 | 25`).
- Produces: a `5 / 10 / 25` segmented control (`.pipeline-inspect-seg` / `.pipeline-inspect-seg-opt`) that re-fires previews and persists the choice. Initial value loads from `mdhInspectSampleSize` (falls back to `10`).

- [ ] **Step 1: Write the failing tests**

Append to `tests/mdh-pipeline-inspector.test.js` (inside the existing top-level scope, e.g. a new `describe`):

```js
describe('PipelineInspector docs/stage selector', () => {
  it('changing the selector re-fires previews with the new limit', async () => {
    const entries = [{ disabled: false, stage: { $match: {} } }];
    api.aggregate.mockResolvedValue({ result: [] });

    const root = mount({ collection: 'vendors', entries });
    await waitFor(
      () => api.aggregate.mock.calls.some((c) => JSON.stringify(c[1]) === JSON.stringify([{ $limit: 10 }])),
      'default 10 input preview',
    );

    const opt25 = [...root.querySelectorAll('.pipeline-inspect-seg-opt')].find((b) => b.textContent === '25');
    expect(opt25).toBeTruthy();
    opt25.click();

    await waitFor(
      () => api.aggregate.mock.calls.some((c) => JSON.stringify(c[1]) === JSON.stringify([{ $limit: 25 }])),
      '25 input preview after change',
    );
  });

  it('loads the persisted sample size from chrome.storage', async () => {
    const prevGet = globalThis.chrome.storage.local.get;
    globalThis.chrome.storage.local.get = (k, cb) => cb({ mdhInspectSampleSize: 5 });
    try {
      const entries = [{ disabled: false, stage: { $match: {} } }];
      api.aggregate.mockResolvedValue({ result: [] });
      mount({ collection: 'vendors', entries });
      await waitFor(
        () => api.aggregate.mock.calls.some((c) => JSON.stringify(c[1]) === JSON.stringify([{ $limit: 5 }])),
        'persisted 5 input preview',
      );
    } finally {
      globalThis.chrome.storage.local.get = prevGet;
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mdh-pipeline-inspector.test.js -t "docs/stage selector"`
Expected: FAIL — no `.pipeline-inspect-seg-opt`; sample size not loaded from storage.

- [ ] **Step 3: Implement the selector + persistence**

In `src/mdh/components/PipelineInspector.jsx`:

Replace the sample-size state line:

```jsx
  const [sampleSize] = useState(DEFAULT_SAMPLE);
```

with:

```jsx
  const [sampleSize, setSampleSize] = useState(DEFAULT_SAMPLE);

  useEffect(() => {
    chrome.storage.local.get(['mdhInspectSampleSize'], ({ mdhInspectSampleSize }) => {
      if ([5, 10, 25].includes(mdhInspectSampleSize)) setSampleSize(mdhInspectSampleSize);
    });
  }, []);

  function changeSample(n) {
    setSampleSize(n);
    chrome.storage.local.set({ mdhInspectSampleSize: n });
  }
```

Add the toolbar as the first child of the root `.pipeline-inspect` div (immediately before `<div class="pipeline-inspect-scroll">`):

```jsx
      <div class="pipeline-inspect-toolbar">
        <span class="pipeline-inspect-toolbar-label">docs / stage</span>
        <div class="pipeline-inspect-seg">
          {[5, 10, 25].map((n) => (
            <button
              key={n}
              class={'pipeline-inspect-seg-opt' + (sampleSize === n ? ' pipeline-inspect-seg-opt-active' : '')}
              onClick={() => changeSample(n)}
            >{n}</button>
          ))}
        </div>
      </div>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mdh-pipeline-inspector.test.js`
Expected: PASS (core + selector cases).

---

## Task 4: scroll to (and highlight) the clicked stage

**Files:**
- Modify: `src/mdh/components/PipelineInspector.jsx`
- Test: `tests/mdh-pipeline-inspector.test.js` (add case)

**Interfaces:**
- Consumes: `clickedIndex` prop (already accepted; `-1` = input) and the `data-idx` attributes already rendered on each section.
- Produces: on open, the matching section is scrolled into view (`scrollIntoView`) and briefly gets class `pipeline-inspect-highlight`.

- [ ] **Step 1: Write the failing test**

Append to `tests/mdh-pipeline-inspector.test.js`:

```js
describe('PipelineInspector scroll-to-clicked', () => {
  it('scrolls to and highlights the clicked stage section', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const entries = [
      { disabled: false, stage: { $match: {} } },
      { disabled: false, stage: { $limit: 50 } },
    ];
    api.aggregate.mockResolvedValue({ result: [] });

    const root = mount({ collection: 'vendors', entries, clickedIndex: 1 });
    await waitFor(() => root.querySelector('.pipeline-inspect-highlight'), 'highlighted section');

    const highlighted = root.querySelector('.pipeline-inspect-highlight');
    expect(highlighted.getAttribute('data-idx')).toBe('1');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mdh-pipeline-inspector.test.js -t "scroll-to-clicked"`
Expected: FAIL — no `.pipeline-inspect-highlight`.

- [ ] **Step 3: Implement the scroll/highlight effect**

In `src/mdh/components/PipelineInspector.jsx`, add this effect after the preview-fetch `useEffect` (it uses the existing `rootRef`):

```jsx
  useEffect(() => {
    const el = rootRef.current?.querySelector(`[data-idx="${clickedIndex}"]`);
    if (!el) return;
    el.scrollIntoView?.({ block: 'start' });
    el.classList.add('pipeline-inspect-highlight');
    const t = setTimeout(() => el.classList.remove('pipeline-inspect-highlight'), 1300);
    return () => clearTimeout(t);
  }, [clickedIndex]);
```

- [ ] **Step 4: Run the whole inspector suite to verify it passes**

Run: `npx vitest run tests/mdh-pipeline-inspector.test.js`
Expected: PASS (all cases).

---

## Task 5: wire `PipelineDebug` to open the inspector; remove `StageInspector`

**Files:**
- Modify: `src/mdh/components/PipelineDebug.jsx`
- Test: `tests/mdh-pipeline-debug.test.js`

**Interfaces:**
- Consumes: `PipelineInspector` (Tasks 2–4).
- Produces: clicking a stage row → `openModal('Inspect pipeline', () => <PipelineInspector collection={collection} entries={list} counts={stageCounts} inputInfo={inputInfo} clickedIndex={activeIdx} />)`; clicking the input row passes `clickedIndex={-1}`. `StageInspector` and `DEBUG_PREVIEW_LIMIT` are deleted. Panel count/timing/toggle/error behavior is unchanged.

- [ ] **Step 1: Update the one StageInspector-specific test**

In `tests/mdh-pipeline-debug.test.js`, replace the test `'clicking the 0th row previews the first raw documents (before any stage)'` (the whole `it(...)` block) with:

```js
  it('clicking the 0th row opens the pipeline inspector previewing the raw input', async () => {
    const pipeline = [{ $match: { vendor: 'NOPE' } }];
    api.aggregate.mockImplementation((col, pl) => {
      if (pl[0]?.$collStats) return Promise.resolve({ result: [{ count: 3 }] });
      // Input preview from the inspector is exactly [{ $limit: 10 }].
      if (JSON.stringify(pl) === JSON.stringify([{ $limit: 10 }])) {
        return Promise.resolve({ result: [{ _id: '1', vendor: 'ACME' }] });
      }
      return Promise.resolve({ result: [{ n: 0 }] });
    });

    document.body.innerHTML = '';
    const root = document.createElement('div');
    document.body.appendChild(root);
    render(h('div', null,
      h(PipelineDebug, { entries: stagesToEntries(pipeline), onToggleStage: () => {} }),
      h(Modal, null),
    ), root);
    await waitFor(() => root.querySelector('.pipeline-debug-input-row'), 'input row rendered');

    root.querySelector('.pipeline-debug-input-row').click();
    // Clicking opens the full-pipeline inspector modal.
    await waitFor(() => document.querySelector('.pipeline-inspect'), 'inspector modal opened');

    // The inspector previews the raw collection via [{ $limit: 10 }] (no $match prefix).
    expect(api.aggregate.mock.calls.some(
      (c) => JSON.stringify(c[1]) === JSON.stringify([{ $limit: 10 }]),
    )).toBe(true);
  });
```

(All other tests in this file assert the panel itself — counts, timing, errors, disabled rows, write-stage safety — and stay unchanged.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mdh-pipeline-debug.test.js -t "opens the pipeline inspector"`
Expected: FAIL — `.pipeline-inspect` never appears (PipelineDebug still opens `StageInspector`).

- [ ] **Step 3: Rewire `PipelineDebug.jsx`**

In `src/mdh/components/PipelineDebug.jsx`:

Add the import (next to the other imports):

```jsx
import PipelineInspector from './PipelineInspector.jsx';
```

Remove the now-unused constant:

```jsx
const DEBUG_PREVIEW_LIMIT = 5;
```

Replace `inspectStage` and `inspectInput`:

```jsx
  function inspectStage(activeIndex) {
    openModal('Inspect pipeline', () => (
      <PipelineInspector collection={collection} entries={list} counts={stageCounts} inputInfo={inputInfo} clickedIndex={activeIndex} />
    ));
  }
  function inspectInput() {
    openModal('Inspect pipeline', () => (
      <PipelineInspector collection={collection} entries={list} counts={stageCounts} inputInfo={inputInfo} clickedIndex={-1} />
    ));
  }
```

Update the stage row's click handler (it currently calls `inspectStage(prefix, myDisplayNo, stageKey)`):

```jsx
              <div class="pipeline-debug-row" onClick={() => inspectStage(myActiveIdx)}>
```

Delete the entire `StageInspector` function (from `function StageInspector({ collection, prefix, stageIndex, stageKey, isInput }) {` through its closing `}`). The `stripWriteStages` import stays (still used by the per-stage `$count` effect). The `prefix` local computed for each row is no longer needed for the click; remove the now-unused `const prefix = activeStages.slice(...)` line **only if** nothing else references it (the count effect computes its own prefix), otherwise leave it.

- [ ] **Step 4: Run the debug suite to verify it passes**

Run: `npx vitest run tests/mdh-pipeline-debug.test.js`
Expected: PASS (the rewritten test + all unchanged panel tests).

- [ ] **Step 5: Grep to confirm `StageInspector`/`DEBUG_PREVIEW_LIMIT` are gone**

Run: `grep -rn "StageInspector\|DEBUG_PREVIEW_LIMIT\|pipeline-inspect-info" src/`
Expected: only `src/console/console.css` may still show `.pipeline-inspect-info` (removed in Task 6); no `StageInspector`/`DEBUG_PREVIEW_LIMIT` hits in `src/`.

---

## Task 6: CSS, docs, and full verification

**Files:**
- Modify: `src/console/console.css`
- Modify: `CLAUDE.md`

**Interfaces:** none (styling + docs + final build/test gate).

- [ ] **Step 1: Remove the obsolete `.pipeline-inspect-info` rule**

In `src/console/console.css`, delete the block:

```css
.pipeline-inspect-info {
  font-size: 11px; color: var(--text-secondary);
  font-family: var(--font-mono); margin-bottom: 8px;
}
```

(Keep the `.sample-cards` / `.sample-card*` rules below it — BulkDelete/BulkUpdate use them.)

- [ ] **Step 2: Add the inspector styles**

Append to `src/console/console.css` (near the other modal rules, e.g. just after the `.modal-card:has(.csv-import-wizard)` rule):

```css
/* ── Full-pipeline stage inspector modal ──────────────────── */
.modal-card:has(.pipeline-inspect) {
  max-width: none; width: 96vw; height: 92vh; max-height: 92vh;
}
.pipeline-inspect {
  display: flex; flex-direction: column; flex: 1; min-height: 0;
}
.pipeline-inspect-toolbar {
  display: flex; align-items: center; justify-content: flex-end; gap: 8px;
  padding: 8px 14px; border-bottom: 1px solid var(--border); font-size: 12px;
  color: var(--text-secondary); flex-shrink: 0;
}
.pipeline-inspect-toolbar-label { font-size: 11px; }
.pipeline-inspect-seg { display: inline-flex; border: 1px solid var(--border); border-radius: 7px; overflow: hidden; }
.pipeline-inspect-seg-opt {
  padding: 4px 10px; font-size: 11px; font-family: inherit; line-height: 1.4;
  border: none; border-right: 1px solid var(--border);
  background: var(--bg-card); color: var(--text-secondary); cursor: pointer;
}
.pipeline-inspect-seg-opt:last-child { border-right: none; }
.pipeline-inspect-seg-opt-active { background: var(--accent); color: var(--accent-fg, #fff); }
.pipeline-inspect-scroll {
  flex: 1; min-height: 0; overflow-y: auto;
  padding: 12px 14px 16px; display: flex; flex-direction: column; gap: 14px;
}
.pipeline-inspect-section {
  border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden;
}
.pipeline-inspect-section-head {
  display: flex; align-items: baseline; gap: 8px;
  padding: 8px 10px; background: var(--bg-hover);
  font-family: var(--font-mono); font-size: 12px;
}
.pipeline-inspect-num { color: var(--text-secondary); }
.pipeline-inspect-key { color: var(--accent); font-weight: 600; }
.pipeline-inspect-count { margin-left: auto; font-weight: 600; color: var(--success); }
.pipeline-inspect-zero { color: var(--danger); }
.pipeline-inspect-time { color: var(--text-secondary); opacity: 0.7; min-width: 46px; text-align: right; }
.pipeline-inspect-time-slow { color: var(--warning); opacity: 1; font-weight: 600; }
.pipeline-inspect-body {
  display: grid; grid-template-columns: minmax(220px, 340px) 1fr; gap: 10px; padding: 10px;
}
@media (max-width: 900px) { .pipeline-inspect-body { grid-template-columns: 1fr; } }
.pipeline-inspect-def {
  margin: 0; font-family: var(--font-mono); font-size: 11px; line-height: 1.4;
  color: var(--text-code); background: var(--bg-code); padding: 8px 10px;
  border-radius: var(--radius); overflow: auto; max-height: 42vh;
  white-space: pre-wrap; word-break: break-word;
}
.pipeline-inspect-output {
  max-height: 42vh; overflow-y: auto; display: flex; flex-direction: column; gap: 6px;
}
.pipeline-inspect-disabled { opacity: 0.55; }
.pipeline-inspect-disabled-badge {
  margin-left: auto; font-size: 10px; color: var(--text-secondary); font-style: italic;
}
.pipeline-inspect-error {
  color: var(--danger); font-family: var(--font-mono); font-size: 11px;
  white-space: pre-wrap; word-break: break-word;
}
.pipeline-inspect-empty, .pipeline-inspect-loading {
  color: var(--text-secondary); font-size: 12px; font-style: italic;
}
.pipeline-inspect-highlight { animation: pipeline-inspect-flash 1.2s ease-out; }
@keyframes pipeline-inspect-flash {
  from { box-shadow: inset 0 0 0 2px var(--accent); }
  to { box-shadow: inset 0 0 0 0 transparent; }
}
```

- [ ] **Step 3: Update `CLAUDE.md`**

In the **Chrome Storage Keys → MDH state** bullet, add `mdhInspectSampleSize` to the list, e.g. after `mdhResultsView (...)`:

```
, `mdhInspectSampleSize` (pipeline inspector sample docs per stage: `5`|`10`|`25`)
```

In the **Dataset Management (MDH)** section's `components/` line, bump the count and mention the new component, e.g. change "26 JSX components" to "27 JSX components" and add a short clause: "`PipelineInspector.jsx` (near-fullscreen full-pipeline stage inspector; per-stage sample previews via read-only `RecordCard`s)."

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS — all tests green (the count was ~1299 before; expect that plus the new inspector/record-card cases).

- [ ] **Step 5: Build the extension**

Run: `npm run build`
Expected: clean build into `dist/` (esbuild bundles `PipelineInspector` into `console.js`), no errors.

- [ ] **Step 6 (optional, manual): visual smoke test**

Load `dist/` as an unpacked extension, open a Rossum tab, open Dataset Management, build a multi-stage pipeline, and click a stage row in the Aggregate Pipeline Debug panel. Confirm the modal opens near-fullscreen, scrolls to the clicked stage, shows per-stage definitions + sample docs, the 5/10/25 selector re-fetches, and disabled stages render greyed. (Requires a live Rossum org/token; not part of automated tests.)

---

## Self-Review

**Spec coverage:**
- Near-fullscreen modal → Task 6 CSS `.modal-card:has(.pipeline-inspect)`. ✓
- Vertical stage list, all stages at once → Task 2 sections. ✓
- Reuse data-view component (`RecordCard`) read-only → Task 1 + Task 2 (`InspectorDoc`). ✓
- 10 docs/stage, adjustable 5/10/25, persisted → Task 3. ✓
- Stage definition as plain code block → Task 2 `.pipeline-inspect-def` `<pre>`. ✓
- Count delta + timing reused from panel → Task 2 `StageHeader`. ✓
- Per-stage independent loading/error → Task 2 `StageOutput`. ✓
- Disabled stages greyed, no preview → Task 2. ✓
- Scroll-to/highlight clicked stage → Task 4. ✓
- Entry point = row click opens the one modal; remove `StageInspector` → Task 5. ✓
- Safety invariants ($search-first, stripWriteStages) → Task 2 tests + impl. ✓
- Backward compat: panel unchanged; `readOnly` default off; keep `.sample-card`; retire `.pipeline-inspect-info` → Tasks 1, 5, 6. ✓
- Tests: update debug test + new inspector/record-card tests → Tasks 1, 2, 3, 4, 5. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows full code; every command has expected output. ✓

**Type/name consistency:** `PipelineInspector({ collection, entries, counts, inputInfo, clickedIndex })` used identically in Task 5's `openModal`. `readOnly` prop name consistent across Tasks 1–2. `data-idx`/`clickedIndex` semantics (`-1` = input) consistent across Tasks 2 and 4. `previews` keyed by `'input'`/active index consistent across Tasks 2–3. Selector classes `.pipeline-inspect-seg(-opt)(-active)` consistent across Task 3 + Task 6 CSS. ✓
