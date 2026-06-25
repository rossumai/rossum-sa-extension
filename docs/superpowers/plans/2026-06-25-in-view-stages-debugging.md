# In-view "Stages" debugging (no modal) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the debugging modal with a third results-pane view mode (List / Table / **Stages**) that renders the per-stage debug view inline, with the left panel's row-click switching to it.

**Architecture:** Repurpose the modal body `PipelineInspector` into an inline `StagesView` driven by live props. `RecordList` gains a controlled `view` incl. `'stages'` and renders `StagesView` in place of the records. `DataPanel` owns the view + a scroll target; `PipelineDebug` row-click drives them. The modal is removed.

**Tech Stack:** Preact + `@preact/signals`, esbuild (IIFE), Vitest (jsdom), MDH Data Storage REST client (`src/mdh/api.js`).

## Global Constraints

- **No git commits during this run.** Stay on `master`, no branches/worktrees; do NOT `git commit`. Each task ends by running its tests; the final task runs the full suite + build. (Replaces the usual "Commit" step.)
- **Preact classic JSX:** every `.jsx` starts with `import { h } from 'preact';`. Tests are `.test.js` rendering via `h(Component, null)`; `waitFor`-poll for async (no fixed sleeps); `afterEach` unmount (`render(null, root)`) to stop a prior test's deferred effect from polluting the next test's mock calls.
- **Safety invariants for every aggregation the Stages view issues:** `$search` stays the first stage of any prefix; `stripWriteStages` removes `$out`/`$merge`.
- **Backward compatibility:** the `Modal` system stays (other features use it) — only this feature's `openModal(PipelineInspector)` usage is removed. `mdhResultsView` adds `'stages'`; `list`/`table`/legacy `json`→`list` unaffected. `useStageCounts` and `RecordCard` `readOnly` reused unchanged. Keep the `.pipeline-inspect-*` CSS class names; remove only the modal-only rules.
- **JSX unicode:** render glyphs via JS-expression strings (`{'→'}`, `{'–'}`, `{'—'}`, `{'…'}`) or literal chars — never `\uXXXX` in raw JSX.
- **Commands:** `npm test` = `vitest run`; single file `npx vitest run tests/<file>.test.js`; build `npm run build`.

---

## File Structure

- **Rename/rewrite** `src/mdh/components/PipelineInspector.jsx` → `src/mdh/components/StagesView.jsx` — inline per-stage debug view, live props, no modal chrome/selector/local-entries; state-driven highlight.
- **Rename/rewrite** `tests/mdh-pipeline-inspector.test.js` → `tests/mdh-stages-view.test.js`.
- **Modify** `src/mdh/components/RecordList.jsx` — controlled `view` incl. `'stages'`; render `StagesView` in that mode; trim toolbar; hide pagination; `ViewAsButton` Stages.
- **Modify** `src/mdh/components/DataPanel.jsx` — own `resultsView` (persist) + `inspectTarget`; `handleInspectStage`; pass `view`/`onChangeView`/`entries`/`onToggleStage`/`inspectTarget` to `RecordList`; pass `onInspectStage` to `PipelineDebug`.
- **Modify** `src/mdh/components/PipelineDebug.jsx` — drop modal; row-click → `onInspectStage`.
- **Modify** `src/console/console.css` — remove modal-only rules; add `overscroll-behavior: contain`.
- **Modify** `CLAUDE.md` — Stages mode; `mdhResultsView` adds `stages`; drop `mdhInspectSampleSize`; note modal removal.
- **Modify** `tests/mdh-pipeline-debug.test.js` — row-click asserts `onInspectStage`.

To keep the build green at every task, **Task 1 creates `StagesView` alongside the still-present modal**; **Task 2 makes Stages reachable via the dropdown** (modal still on row-click); **Task 3 rewires row-click and deletes the modal**.

---

## Task 1: `StagesView` component (inline, live-props)

**Files:**
- Create: `src/mdh/components/StagesView.jsx`
- Create: `tests/mdh-stages-view.test.js`

**Interfaces:**
- Consumes: `RecordCard` (`readOnly`), `useStageCounts(collection, activeStages)`, `api.aggregate(collection, pipeline, { signal })`, `stripWriteStages`.
- Produces: `export default function StagesView({ collection, entries, onToggleStage, inspectTarget })`.
  - `entries`: live `{ disabled, stage }[]` (no local copy).
  - `onToggleStage(entryIndex)`: called by each stage's toggle checkbox.
  - `inspectTarget`: `{ index } | null` (active-stage index, `-1` = input) — scroll/highlight target; a new object reference re-fires it.
  - Renders `.pipeline-inspect` → `.pipeline-inspect-scroll` → an input `<section data-idx="-1">` + one `<section data-idx={activeIndex}>` per entry. Active stages fetch `[...stripWriteStages(prefix), { $limit: 10 }]`; input fetches `[{ $limit: 10 }]`. Highlight is the `pipeline-inspect-highlight` class applied via state.

- [ ] **Step 1: Write the failing test**

Create `tests/mdh-stages-view.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { h, render } from 'preact';

vi.mock('../src/mdh/api.js');
// Stub RecordCard: assert the readOnly prop without depending on its internals
// (covered by tests/mdh-record-card.test.js).
vi.mock('../src/mdh/components/RecordCard.jsx', () => ({
  default: (props) => h('div', { class: 'rc-stub', 'data-readonly': String(!!props.readOnly) }, JSON.stringify(props.record)),
}));

import * as api from '../src/mdh/api.js';
import StagesView from '../src/mdh/components/StagesView.jsx';

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

let currentRoot = null;
function mount(props) {
  document.body.innerHTML = '';
  currentRoot = document.createElement('div');
  document.body.appendChild(currentRoot);
  render(h(StagesView, { onToggleStage: () => {}, inspectTarget: null, ...props }), currentRoot);
  return currentRoot;
}
function rerender(props) {
  render(h(StagesView, { onToggleStage: () => {}, inspectTarget: null, ...props }), currentRoot);
}

// A preview request ends in { $limit: 10 } — NOT the $collStats input-count probe
// ([{$collStats},{$limit:1}]) and NOT the per-stage { $count } probes.
const previewCalls = () =>
  api.aggregate.mock.calls.filter((c) => {
    const pl = c[1];
    if (!Array.isArray(pl) || pl.length === 0) return false;
    if (pl[0]?.$collStats) return false;
    return pl[pl.length - 1]?.$limit != null;
  });

afterEach(() => {
  if (currentRoot) { render(null, currentRoot); currentRoot = null; }
  document.body.innerHTML = '';
});
beforeEach(() => { vi.clearAllMocks(); });

describe('StagesView', () => {
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

  it('fires one 10-doc preview per active stage plus input, $search first', async () => {
    const search = { $search: { index: 'default', text: { query: 'foo', path: 'name' } } };
    const entries = [{ disabled: false, stage: search }, { disabled: false, stage: { $match: { x: 1 } } }];
    api.aggregate.mockResolvedValue({ result: [] });
    mount({ collection: 'vendors', entries });
    await waitFor(() => previewCalls().length >= 3, 'input + 2 stage previews');
    const calls = previewCalls();
    expect(calls.some((c) => JSON.stringify(c[1]) === JSON.stringify([{ $limit: 10 }]))).toBe(true);
    const stagePreviews = calls.filter((c) => c[1].length > 1);
    expect(stagePreviews.length).toBe(2);
    for (const [, pl] of stagePreviews) {
      expect(pl[0]).toEqual(search);
      expect(pl[pl.length - 1]).toEqual({ $limit: 10 });
    }
  });

  it('strips $out/$merge from every request', async () => {
    const entries = [{ disabled: false, stage: { $match: {} } }, { disabled: false, stage: { $out: 'archive' } }];
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

  it('renders read-only RecordCards', async () => {
    const entries = [{ disabled: false, stage: { $match: {} } }];
    api.aggregate.mockResolvedValue({ result: [{ _id: '1', name: 'ACME' }] });
    const root = mount({ collection: 'vendors', entries });
    await waitFor(() => root.querySelectorAll('.rc-stub').length > 0, 'doc cards rendered');
    for (const stub of root.querySelectorAll('.rc-stub')) expect(stub.getAttribute('data-readonly')).toBe('true');
  });

  it('surfaces a per-stage preview error independently', async () => {
    const entries = [{ disabled: false, stage: { $match: {} } }, { disabled: false, stage: { $sort: { _id: 1 } } }];
    api.aggregate.mockImplementation((col, pl) => {
      if (JSON.stringify(pl) === JSON.stringify([{ $limit: 10 }])) return Promise.resolve({ result: [{ _id: 'i' }] });
      if (JSON.stringify(pl).includes('$sort')) return Promise.reject(Object.assign(new Error('boom'), { status: 400 }));
      return Promise.resolve({ result: [{ _id: '1' }] });
    });
    const root = mount({ collection: 'vendors', entries });
    await waitFor(() => root.querySelector('.pipeline-inspect-error'), 'error rendered');
    const err = root.querySelector('.pipeline-inspect-error');
    expect(err.textContent).toContain('boom');
    expect(err.textContent).toMatch(/400/);
    expect(root.querySelectorAll('.rc-stub').length).toBeGreaterThan(0);
  });

  it('renders disabled stages greyed and issues no preview for them', async () => {
    const entries = [{ disabled: false, stage: { $match: {} } }, { disabled: true, stage: { $sort: { a: -1 } } }];
    api.aggregate.mockResolvedValue({ result: [] });
    const root = mount({ collection: 'vendors', entries });
    await waitFor(() => previewCalls().length >= 2, 'input + 1 active preview');
    expect(root.querySelector('.pipeline-inspect-disabled')).not.toBeNull();
    for (const [, pl] of api.aggregate.mock.calls) expect(JSON.stringify(pl)).not.toContain('$sort');
  });

  it('fetches and shows a count delta in the stage header', async () => {
    const entries = [{ disabled: false, stage: { $match: {} } }];
    api.aggregate.mockImplementation((col, pl) => {
      if (pl[0]?.$collStats) return Promise.resolve({ result: [{ count: 1240 }] });
      if (pl[pl.length - 1]?.$count) return Promise.resolve({ result: [{ n: 420 }] });
      return Promise.resolve({ result: [] });
    });
    const root = mount({ collection: 'vendors', entries });
    await waitFor(() => root.textContent.includes('1,240') && root.textContent.includes('420'), 'counts rendered');
    expect(root.textContent).toContain('1,240');
    expect(root.textContent).toContain('420');
  });

  it('calls onToggleStage with the entry index when a stage toggle is clicked', async () => {
    const entries = [{ disabled: false, stage: { $match: {} } }, { disabled: false, stage: { $limit: 50 } }];
    api.aggregate.mockResolvedValue({ result: [] });
    const toggled = [];
    const root = mount({ collection: 'vendors', entries, onToggleStage: (i) => toggled.push(i) });
    await waitFor(() => root.querySelectorAll('.pipeline-stage-toggle').length === 2, 'two stage toggles');
    root.querySelectorAll('.pipeline-stage-toggle')[1].click();
    expect(toggled).toEqual([1]);
  });

  it('reflects a disabled stage when entries prop changes (live, no local copy)', async () => {
    const entries = [{ disabled: false, stage: { $match: {} } }, { disabled: false, stage: { $sort: { _id: 1 } } }];
    api.aggregate.mockResolvedValue({ result: [] });
    const root = mount({ collection: 'vendors', entries });
    await waitFor(() => api.aggregate.mock.calls.some((c) => JSON.stringify(c[1]).includes('$sort')), '$sort referenced');
    vi.clearAllMocks();
    api.aggregate.mockResolvedValue({ result: [] });
    rerender({ collection: 'vendors', entries: [{ disabled: false, stage: { $match: {} } }, { disabled: true, stage: { $sort: { _id: 1 } } }] });
    await waitFor(() => root.querySelector('.pipeline-inspect-disabled'), 'stage greyed via prop');
    await waitFor(() => api.aggregate.mock.calls.length > 0, 'requests re-issued');
    expect(api.aggregate.mock.calls.every((c) => !JSON.stringify(c[1]).includes('$sort'))).toBe(true);
  });

  it('scrolls to and highlights the inspectTarget stage', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const entries = [{ disabled: false, stage: { $match: {} } }, { disabled: false, stage: { $limit: 50 } }];
    api.aggregate.mockResolvedValue({ result: [] });
    const root = mount({ collection: 'vendors', entries, inspectTarget: { index: 1 } });
    await waitFor(() => root.querySelector('.pipeline-inspect-highlight'), 'highlighted section');
    expect(root.querySelector('.pipeline-inspect-highlight').getAttribute('data-idx')).toBe('1');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mdh-stages-view.test.js`
Expected: FAIL — `StagesView.jsx` does not exist.

- [ ] **Step 3: Create `StagesView.jsx`**

Create `src/mdh/components/StagesView.jsx`:

```jsx
import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import * as api from '../api.js';
import { stripWriteStages } from '../pipelineOps.js';
import RecordCard from './RecordCard.jsx';
import useStageCounts from '../hooks/useStageCounts.js';

const SAMPLE = 10;
const SLOW_QUERY_MS = 1000;
const HIGHLIGHT_MS = 1500;

const timeCls = (ms) => 'pipeline-inspect-time' + (ms > SLOW_QUERY_MS ? ' pipeline-inspect-time-slow' : '');

// One sample document, expanded by default; its own collapse state.
function InspectorDoc({ record, index }) {
  const [expanded, setExpanded] = useState(true);
  return (
    <RecordCard
      record={record} index={index} expanded={expanded} onToggle={() => setExpanded((v) => !v)}
      onCopy={() => {}} onEdit={() => {}} onDelete={() => {}}
      sortState={{}} filterState={{}} onSort={() => {}} onFilter={() => {}}
      charBudget={80} indexes={[]} readOnly
    />
  );
}

function StageToggle({ entryIndex, disabled, onToggle }) {
  return (
    <input
      type="checkbox"
      class={'pipeline-stage-toggle' + (disabled ? ' pipeline-stage-toggle-off' : '')}
      checked={!disabled}
      title={disabled ? 'Enable stage' : 'Disable stage'}
      onClick={(e) => { e.stopPropagation(); if (onToggle) onToggle(entryIndex); }}
    />
  );
}

function StageHeader({ toggle, num, label, prevCount, count, ms }) {
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
      {toggle || <span class="pipeline-stage-toggle-spacer" />}
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

export default function StagesView({ collection, entries, onToggleStage, inspectTarget }) {
  const [previews, setPreviews] = useState({}); // key: 'input' | activeIndex → { docs } | { error }
  const [highlightIdx, setHighlightIdx] = useState(null);
  const rootRef = useRef(null);

  const list = Array.isArray(entries) ? entries : [];
  const activeStages = list.filter((e) => !e.disabled).map((e) => e.stage);
  const activeKey = JSON.stringify(activeStages);
  const { counts, inputInfo } = useStageCounts(collection, activeStages);

  useEffect(() => {
    if (!collection) { setPreviews({}); return; }
    setPreviews({});
    const controller = new AbortController();

    api.aggregate(collection, [{ $limit: SAMPLE }], { signal: controller.signal })
      .then((res) => { if (!controller.signal.aborted) setPreviews((p) => ({ ...p, input: { docs: res.result || [] } })); })
      .catch((err) => {
        if (err?.name === 'AbortError' || controller.signal.aborted) return;
        setPreviews((p) => ({ ...p, input: { error: { message: err?.message || String(err), status: err?.status } } }));
      });

    activeStages.forEach((_, i) => {
      const prefix = activeStages.slice(0, i + 1);
      api.aggregate(collection, [...stripWriteStages(prefix), { $limit: SAMPLE }], { signal: controller.signal })
        .then((res) => { if (!controller.signal.aborted) setPreviews((p) => ({ ...p, [i]: { docs: res.result || [] } })); })
        .catch((err) => {
          if (err?.name === 'AbortError' || controller.signal.aborted) return;
          setPreviews((p) => ({ ...p, [i]: { error: { message: err?.message || String(err), status: err?.status } } }));
        });
    });

    return () => controller.abort();
  }, [collection, activeKey]);

  useEffect(() => {
    if (!inspectTarget) return;
    const idx = inspectTarget.index;
    setHighlightIdx(idx);
    const el = rootRef.current?.querySelector(`[data-idx="${idx}"]`);
    el?.scrollIntoView?.({ block: 'start' });
    const t = setTimeout(() => setHighlightIdx((cur) => (cur === idx ? null : cur)), HIGHLIGHT_MS);
    return () => clearTimeout(t);
  }, [inspectTarget]);

  const sectionCls = (idx) => 'pipeline-inspect-section' + (highlightIdx === idx ? ' pipeline-inspect-highlight' : '');

  let activeIdx = -1;

  return (
    <div class="pipeline-inspect" ref={rootRef}>
      <div class="pipeline-inspect-scroll">
        <section class={sectionCls(-1)} data-idx="-1">
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
                  <StageToggle entryIndex={entryIndex} disabled onToggle={onToggleStage} />
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
            <section class={sectionCls(myIdx)} data-idx={myIdx} key={entryIndex}>
              <StageHeader
                toggle={<StageToggle entryIndex={entryIndex} disabled={false} onToggle={onToggleStage} />}
                num={`${myIdx + 1}`} label={stageKey} prevCount={prevCount} count={counts[myIdx]?.count} ms={counts[myIdx]?.ms}
              />
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

Run: `npx vitest run tests/mdh-stages-view.test.js` (run 2-3×; expect stable)
Expected: PASS (all cases).

---

## Task 2: Stages view mode in `RecordList` (reachable via the View dropdown)

**Files:**
- Modify: `src/mdh/components/RecordList.jsx`
- Modify: `src/mdh/components/DataPanel.jsx`
- Test: `tests/mdh-record-list-footer.test.js` (extend) or a focused render check

**Interfaces:**
- Consumes: `StagesView` (Task 1).
- Produces: `RecordList` accepts `view` (`'list'|'table'|'stages'`), `onChangeView(v)`, `entries`, `onToggleStage`, `inspectTarget`; renders `StagesView` when `view==='stages'`. `DataPanel` owns `resultsView` (persisted to `mdhResultsView`) + passes the above.

- [ ] **Step 1: Write the failing test**

Append to `tests/mdh-record-list-footer.test.js` a new describe (it already mocks `RecordCard`, `chrome`, `ResizeObserver`, and `api`). Add a `StagesView` stub mock near the other `vi.mock` calls at the top of that file:

```js
vi.mock('../src/mdh/components/StagesView.jsx', () => ({ default: () => h('div', { class: 'stages-view-stub' }) }));
```

Then append:

```js
describe('RecordList — stages view', () => {
  it('renders StagesView (not records) and hides pagination when view=stages', () => {
    const root = renderList({ view: 'stages', onChangeView() {}, entries: [{ disabled: false, stage: { $match: {} } }], onToggleStage() {}, inspectTarget: null });
    expect(root.querySelector('.stages-view-stub')).not.toBeNull();
    expect(root.querySelector('.record-list')).toBeNull();   // records container not rendered
    expect(root.querySelector('.pagination')).toBeNull();    // pagination hidden
  });

  it('offers a Stages option in the View menu and calls onChangeView', () => {
    const calls = [];
    const root = renderList({ view: 'list', onChangeView: (v) => calls.push(v) });
    // open the View dropdown
    const viewBtn = [...root.querySelectorAll('.btn')].find((b) => /View:/.test(b.textContent));
    viewBtn.click();
    const stagesItem = [...root.querySelectorAll('.toolbar-menu-item')].find((b) => /Stages/.test(b.textContent));
    expect(stagesItem).toBeTruthy();
    stagesItem.click();
    expect(calls).toContain('stages');
  });
});
```

Update that file's `renderList` defaults to include the new props (add to the props object): `view: 'list', onChangeView() {}, entries: [], onToggleStage() {}, inspectTarget: null,`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mdh-record-list-footer.test.js`
Expected: FAIL — `view` is not controlled; no Stages option; pagination still renders.

- [ ] **Step 3: Make `view` controlled + add the Stages branch in `RecordList.jsx`**

Add the import near the other component imports (after `import RecordTable from './RecordTable.jsx';`):

```jsx
import StagesView from './StagesView.jsx';
import { selectedCollection } from '../store.js';
```
(`selectedCollection` is already imported at the top of `RecordList.jsx` — do NOT duplicate it; only add the `StagesView` import.)

In the `RecordList({ ... })` props list, add `view`, `onChangeView`, `entries`, `onToggleStage`, `inspectTarget`:

```jsx
export default function RecordList({
  records, pipelineText, filterState, sortState, lastQueryMs, totalCount, pagination,
  onSort, onFilter, onPageChange, onEdit, onDelete, onRefresh, downloadState, onCancelDownload,
  onEnterSelectionMode, onExitSelectionMode, onBulkDelete, onBulkUpdate, onSelectPage, onClearSelection,
  onViewSelected, filtered = false,
  view, onChangeView, entries, onToggleStage, inspectTarget,
}) {
```

Remove the internal view state + load effect + `changeView` (delete these three pieces):

```jsx
  const [view, setView] = useState('list');
```
```jsx
  useEffect(() => {
    chrome.storage.local.get(['mdhResultsView'], ({ mdhResultsView }) => {
      if (mdhResultsView === 'table') setView('table');
    });
  }, []);
  function changeView(v) { setView(v); chrome.storage.local.set({ mdhResultsView: v }); }
```

Replace the toolbar block so stages mode shows only the View switch — change the `DefaultToolbar` invocation to pass `view`/`onChangeView` (rename `changeView` → `onChangeView`):

```jsx
          <DefaultToolbar
            allExpanded={allExpanded}
            toggleExpandAll={toggleExpandAll}
            downloadState={downloadState}
            onRefresh={onRefresh}
            onCancelDownload={onCancelDownload}
            onEnterSelectionMode={onEnterSelectionMode}
            onBulkDelete={onBulkDelete}
            onBulkUpdate={onBulkUpdate}
            view={view}
            changeView={onChangeView}
          />
```

Replace the records container + pagination region. Find:

```jsx
      <div class="record-list" ref={listRef}>
        {emptyContent}
        {records.length > 0 && view === 'table' && (
          <RecordTable
            records={records}
            columns={deriveColumns(records)}
            sortState={sortState}
            filterState={filterState}
            onSort={onSort}
            onFilter={onFilter}
          />
        )}
        {records.length > 0 && view === 'list' && records.map((record, i) => (
          <RecordCard
            key={i}
            record={record}
            index={i}
            expanded={expandAll || expandedSet.has(i)}
            onToggle={toggleExpand}
            onCopy={() => {}}
            onEdit={onEdit}
            onDelete={onDelete}
            sortState={sortState}
            filterState={filterState}
            onSort={onSort}
            onFilter={onFilter}
            charBudget={charBudget}
            indexes={indexes}
          />
        ))}
      </div>
      <div class="pagination">
        <span class="record-count">{countText}</span>
        <span class="pagination-hint">Click key to sort {'·'} Click value to filter {'·'} {ALT_KEY}+click to copy</span>
        <div class="pagination-controls">
          <button disabled={!pagination.hasPrev()} onClick={() => onPageChange('prev')}>{'←'} Prev</button>
          <span>Page {pagination.page()}</span>
          <button disabled={!pagination.hasNext(records.length, filtered)} onClick={() => onPageChange('next')}>Next {'→'}</button>
        </div>
      </div>
```

with:

```jsx
      {view === 'stages' ? (
        <StagesView
          collection={selectedCollection.value}
          entries={entries}
          onToggleStage={onToggleStage}
          inspectTarget={inspectTarget}
        />
      ) : (
        <div class="record-list" ref={listRef}>
          {emptyContent}
          {records.length > 0 && view === 'table' && (
            <RecordTable
              records={records}
              columns={deriveColumns(records)}
              sortState={sortState}
              filterState={filterState}
              onSort={onSort}
              onFilter={onFilter}
            />
          )}
          {records.length > 0 && view === 'list' && records.map((record, i) => (
            <RecordCard
              key={i}
              record={record}
              index={i}
              expanded={expandAll || expandedSet.has(i)}
              onToggle={toggleExpand}
              onCopy={() => {}}
              onEdit={onEdit}
              onDelete={onDelete}
              sortState={sortState}
              filterState={filterState}
              onSort={onSort}
              onFilter={onFilter}
              charBudget={charBudget}
              indexes={indexes}
            />
          ))}
        </div>
      )}
      {view !== 'stages' && (
        <div class="pagination">
          <span class="record-count">{countText}</span>
          <span class="pagination-hint">Click key to sort {'·'} Click value to filter {'·'} {ALT_KEY}+click to copy</span>
          <div class="pagination-controls">
            <button disabled={!pagination.hasPrev()} onClick={() => onPageChange('prev')}>{'←'} Prev</button>
            <span>Page {pagination.page()}</span>
            <button disabled={!pagination.hasNext(records.length, filtered)} onClick={() => onPageChange('next')}>Next {'→'}</button>
          </div>
        </div>
      )}
```

In `DefaultToolbar`, render only the View switch in stages mode. Change its signature + first lines:

```jsx
function DefaultToolbar({ allExpanded, toggleExpandAll, downloadState, onRefresh, onCancelDownload, onEnterSelectionMode, onBulkDelete, onBulkUpdate, view, changeView }) {
  if (view === 'stages') {
    return (
      <div style="display:contents">
        <div class="toolbar-group"><ViewAsButton view={view} changeView={changeView} /></div>
      </div>
    );
  }
  return (
    <div style="display:contents">
```

In `ViewAsButton`, add the Stages option. Change the label line + menu:

```jsx
  const label = view === 'table' ? 'Table' : view === 'stages' ? 'Stages' : 'List';
  return (
    <div ref={rootRef} class="dropdown-btn">
      <button class="btn btn-sm" onClick={(e) => { e.stopPropagation(); setOpen(!open); }} title="Change results view">
        View: {label} {'▾'}
      </button>
      {open && (
        <div class="toolbar-more-menu">
          <button class="toolbar-menu-item" onClick={() => { setOpen(false); changeView('list'); }}>{view === 'list' ? '✓ List' : 'List'}</button>
          <button class="toolbar-menu-item" onClick={() => { setOpen(false); changeView('table'); }}>{view === 'table' ? '✓ Table' : 'Table'}</button>
          <button class="toolbar-menu-item" onClick={() => { setOpen(false); changeView('stages'); }}>{view === 'stages' ? '✓ Stages' : 'Stages'}</button>
        </div>
      )}
    </div>
  );
```

- [ ] **Step 4: Lift the view state into `DataPanel.jsx`**

Near the other `useState`/signal reads at the top of `DataPanel`'s component body, add:

```jsx
  const [resultsView, setResultsView] = useState('list');
  const [inspectTarget, setInspectTarget] = useState(null);

  useEffect(() => {
    chrome.storage.local.get(['mdhResultsView'], ({ mdhResultsView }) => {
      if (mdhResultsView === 'table' || mdhResultsView === 'stages') setResultsView(mdhResultsView);
    });
  }, []);

  function changeResultsView(v) {
    setResultsView(v);
    setInspectTarget(null);
    chrome.storage.local.set({ mdhResultsView: v });
  }
```

Add a single `entries` variable (reused by `PipelineDebug` and `RecordList`). Find the `<PipelineDebug ... />` usage and replace its inline `parseEntries(...)` with a shared local computed just above the `return (`:

```jsx
  const debugEntries = parseEntries(pipeline.substituteWithTypes(editorState.text)).entries;
```
then change `<PipelineDebug entries={parseEntries(pipeline.substituteWithTypes(editorState.text)).entries} onToggleStage={handleToggleStage} />` to `<PipelineDebug entries={debugEntries} onToggleStage={handleToggleStage} />`.

In the `<RecordList ... />` usage, add the new props:

```jsx
          view={resultsView}
          onChangeView={changeResultsView}
          entries={debugEntries}
          onToggleStage={handleToggleStage}
          inspectTarget={inspectTarget}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/mdh-record-list-footer.test.js tests/mdh-stages-view.test.js`
Expected: PASS. Then run the broad MDH datapanel suite to confirm no regression:
Run: `npx vitest run tests/mdh-datapanel-disable.test.js tests/mdh-datapanel-variables.test.js tests/mdh-datapanel-write-suppress.test.js tests/mdh-datapanel-debug-default.test.js`
Expected: PASS.

(At this point Stages is reachable via the View dropdown; the row-click still opens the modal — removed next.)

---

## Task 3: Rewire row-click to the Stages view; remove the modal

**Files:**
- Modify: `src/mdh/components/PipelineDebug.jsx`
- Modify: `src/mdh/components/DataPanel.jsx`
- Delete: `src/mdh/components/PipelineInspector.jsx`
- Delete: `tests/mdh-pipeline-inspector.test.js`
- Modify: `tests/mdh-pipeline-debug.test.js`

**Interfaces:**
- Produces: `PipelineDebug` accepts `onInspectStage(activeIndex)` (input row → `-1`); `DataPanel.handleInspectStage(index)` sets `resultsView='stages'` + `inspectTarget={ index }`.

- [ ] **Step 1: Update the row-click test in `tests/mdh-pipeline-debug.test.js`**

Replace the test `'clicking the 0th row opens the pipeline inspector previewing the raw input'` with:

```js
  it('clicking the 0th (input) row calls onInspectStage(-1)', async () => {
    const pipeline = [{ $match: { vendor: 'NOPE' } }];
    api.aggregate.mockResolvedValue({ result: [{ n: 0 }] });
    const inspected = [];

    document.body.innerHTML = '';
    const root = document.createElement('div');
    document.body.appendChild(root);
    render(h(PipelineDebug, { entries: stagesToEntries(pipeline), onToggleStage: () => {}, onInspectStage: (i) => inspected.push(i) }), root);
    await waitFor(() => root.querySelector('.pipeline-debug-input-row'), 'input row rendered');

    root.querySelector('.pipeline-debug-input-row').click();
    expect(inspected).toEqual([-1]);
  });

  it('clicking a stage row calls onInspectStage with its active index', async () => {
    const pipeline = [{ $match: {} }, { $sort: { _id: 1 } }];
    api.aggregate.mockResolvedValue({ result: [{ n: 1 }] });
    const inspected = [];

    document.body.innerHTML = '';
    const root = document.createElement('div');
    document.body.appendChild(root);
    render(h(PipelineDebug, { entries: stagesToEntries(pipeline), onToggleStage: () => {}, onInspectStage: (i) => inspected.push(i) }), root);
    await waitFor(() => root.querySelectorAll('.pipeline-debug-row:not(.pipeline-debug-input-row)').length === 2, 'stage rows rendered');

    root.querySelectorAll('.pipeline-debug-row:not(.pipeline-debug-input-row)')[1].click();
    expect(inspected).toEqual([1]);
  });
```

Remove the now-unneeded `Modal` import and `globalThis.chrome` stub from the top of `tests/mdh-pipeline-debug.test.js` (PipelineDebug no longer mounts the modal/inspector). Keep the `import ... PipelineDebug` and `stagesToEntries`/`api` imports.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mdh-pipeline-debug.test.js -t "onInspectStage"`
Expected: FAIL — `onInspectStage` not called (PipelineDebug still opens the modal).

- [ ] **Step 3: Rewire `PipelineDebug.jsx`**

Remove the modal import + the `openModal`/`PipelineInspector` usage. Change the imports:

```jsx
import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { selectedCollection } from '../store.js';
import useStageCounts from '../hooks/useStageCounts.js';
```
(Delete the `import { openModal } from './Modal.jsx';` and `import PipelineInspector from './PipelineInspector.jsx';` lines.)

Change the component signature to accept `onInspectStage`:

```jsx
export default function PipelineDebug({ entries, onToggleStage, onInspectStage }) {
```

Replace `inspectStage`/`inspectInput`:

```jsx
  function inspectStage(activeIndex) { if (onInspectStage) onInspectStage(activeIndex); }
  function inspectInput() { if (onInspectStage) onInspectStage(-1); }
```

(The input row's `onClick={inspectInput}` and the stage row's `onClick={() => inspectStage(myActiveIdx)}` stay as-is.)

- [ ] **Step 4: Wire `handleInspectStage` in `DataPanel.jsx`**

Add the handler near `changeResultsView`:

```jsx
  function handleInspectStage(index) {
    setResultsView('stages');
    setInspectTarget({ index });
    chrome.storage.local.set({ mdhResultsView: 'stages' });
  }
```

Add `onInspectStage={handleInspectStage}` to the `<PipelineDebug ... />` usage:

```jsx
        <PipelineDebug entries={debugEntries} onToggleStage={handleToggleStage} onInspectStage={handleInspectStage} />
```

- [ ] **Step 5: Delete the modal component + its test**

Run:
```bash
rm src/mdh/components/PipelineInspector.jsx tests/mdh-pipeline-inspector.test.js
```

- [ ] **Step 6: Run tests + confirm no stale references**

Run: `grep -rn "PipelineInspector\|openModal" src/mdh/components/PipelineDebug.jsx` → expect no matches.
Run: `npx vitest run tests/mdh-pipeline-debug.test.js`
Expected: PASS (both new row-click tests + all unchanged panel tests).

---

## Task 4: CSS, docs, full verification

**Files:**
- Modify: `src/console/console.css`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Remove the modal-only CSS rules**

In `src/console/console.css`, delete the modal-sizing rule:

```css
/* ── Full-pipeline stage inspector modal ──────────────────── */
/* Near-fullscreen so every stage's sample output is visible at once. */
.modal-card:has(.pipeline-inspect) {
  max-width: none; width: 96vw; height: 92vh; max-height: 92vh;
}
```

and the now-unused toolbar/selector rules:

```css
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
```

(Keep `.pipeline-inspect`, `.pipeline-inspect-scroll`, `.pipeline-inspect-section`, headers, `-body`, `-def`, `-output`, `-disabled*`, `-error`, `-empty`, `-loading`, `-highlight`, and the `@keyframes pipeline-inspect-flash` — `StagesView` reuses them. `.pipeline-inspect` already fills its flex parent, which now is the right pane.)

- [ ] **Step 2: Add `overscroll-behavior: contain` (the bounce fix)**

In `src/console/console.css`, update the scroll regions. Change `.pipeline-inspect-scroll` to add `overscroll-behavior: contain;`:

```css
.pipeline-inspect-scroll {
  flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  padding: 12px 14px 16px; display: flex; flex-direction: column; gap: 14px;
}
```

Update `.pipeline-inspect-output` (add `overscroll-behavior: contain;`):

```css
.pipeline-inspect-output {
  display: flex; flex-direction: row; gap: 8px; align-items: flex-start;
  overflow-x: auto; min-height: 0; padding-bottom: 4px; overscroll-behavior: contain;
}
```

Update `.pipeline-inspect-output > .record-card` (add `overscroll-behavior: contain;`):

```css
.pipeline-inspect-output > .record-card {
  flex: 0 0 300px; max-width: 300px; max-height: 100%; overflow-y: auto; overscroll-behavior: contain;
}
```

- [ ] **Step 3: Update `CLAUDE.md`**

In the **Dataset Management (MDH)** `components/` note, replace the `PipelineInspector.jsx` sentence with one describing `StagesView.jsx` (the in-pane Stages view; opened via the List/Table/Stages results-view switch or by clicking a stage row in the Aggregate Pipeline Debug panel; no modal). Update the component count accordingly (the modal component is removed and `StagesView` added — net unchanged count, but the description changes).

In **Chrome Storage Keys → MDH state**, change `mdhResultsView` to include `stages`: `mdhResultsView` (results view: `list`|`table`|`stages`; legacy `json` reads as `list`)`, and **remove** the `mdhInspectSampleSize` entry (no longer written; the Stages view is fixed at 10 docs/stage).

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS — all green. (`tests/mdh-pipeline-inspector.test.js` is gone; `tests/mdh-stages-view.test.js` + the updated debug/record-list/datapanel tests pass.)

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: clean build; confirm with `grep -c "pipeline-inspect" dist/console/console.js` (>0) and `grep -c "modal-card:has(.pipeline-inspect)" dist/console/console.css` (expect 0).

- [ ] **Step 6 (optional, manual): visual smoke test**

Load `dist/` unpacked, open a Rossum tab → Dataset Management, build a multi-stage pipeline. Confirm: the right pane View switch offers List / Table / **Stages**; Stages shows the stacked per-stage view inline (editor still visible, no overlay); scrolling stops cleanly at the edges (no rubber-band); clicking a stage row in the left panel switches to Stages and briefly highlights that stage; toggles work from both the panel and the Stages view. (Requires a live org/token; not automated.)

---

## Self-Review

**Spec coverage:**
- Stages as a third view mode (List/Table/Stages) → Task 2 (`RecordList` branch + `ViewAsButton`). ✓
- Inline, no overlay, editor visible → renders in the right pane, modal removed (Task 3). ✓
- Left panel stays as overview + entry point; row-click switches to Stages + scrolls/highlights → Task 3 (`onInspectStage`) + Task 1 (`inspectTarget` highlight). ✓
- `StagesView` = de-modaled inspector (live props, no local copy, no selector, 10 hardcoded, state-driven highlight, side-by-side expanded records, fixed-height sections) → Task 1. ✓
- Overscroll bounce fix → Task 4 Step 2. ✓
- `view` lifted + persisted (`mdhResultsView` + `stages`); dropdown clears `inspectTarget` → Task 2 Step 4 (`changeResultsView`). ✓
- Backward compat: Modal system kept; `useStageCounts`/`RecordCard readOnly` reused; class names kept; `mdhInspectSampleSize` dropped → Tasks 3/4. ✓
- Editing deferred (out of scope) → not implemented (correct). ✓
- Tests: StagesView, RecordList stages branch, debug row-click, datapanel regression → Tasks 1–3. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows full code or exact edits; every command has expected output. ✓

**Type/name consistency:** `StagesView({ collection, entries, onToggleStage, inspectTarget })` consistent across Task 1 (def), Task 2 (RecordList usage). `inspectTarget` is `{ index } | null` everywhere; `index` is the active-stage index (`-1` = input) matching `onInspectStage(activeIndex)` (Task 3) and the panel's `myActiveIdx`. `onChangeView`/`changeResultsView` consistent (RecordList prop ← DataPanel handler). `view` values `'list'|'table'|'stages'` consistent. CSS classes `pipeline-inspect-*` retained and referenced identically in Task 1 and Task 4. ✓
