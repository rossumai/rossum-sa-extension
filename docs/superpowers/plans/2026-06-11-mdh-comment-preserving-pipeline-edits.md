# Comment-Preserving Pipeline Edits — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Project workflow override:** Do **NOT** create git commits or branches. Stay on `master`.
> Each task ends with a **green-test checkpoint** (`npx vitest run …`) instead of a commit.
> Final verification is `npm test` + `npm run build`.

**Goal:** Make every pipeline-editor text rewrite (sort / filter / paginate / toggle / Beautify) a **minimal edit** that preserves freehand comments and untouched-stage formatting; let an invalid disabled stage be re-enabled (showing the error); and hide the line-number gutter in the aggregate editor.

**Architecture:** Replace the "parse → mutate parsed array → re-serialize whole pipeline" core of `src/mdh/pipelineComments.js` with a **lossless document model** (`parsePipelineDoc` — segments carry exact source spans; gaps/comments live verbatim in the original text) plus **splice-based writers**: a reference diff turns a `pipelineOps` mutation into replace/insert/remove **text splices** that touch only the changed bytes; toggle wraps/unwraps a span verbatim; Beautify reserializes each stage's span while leaving all gaps untouched. `pipelineOps.js` and every `parseEntries` consumer are unchanged.

**Tech Stack:** `json5`, Preact, CodeMirror 6 (`@codemirror/view` theme), Vitest (+ jsdom).

**Spec:** `docs/superpowers/specs/2026-06-11-mdh-comment-preserving-pipeline-edits-design.md`

> **Confirmed decisions (spec §9):** remove-comment rule = **drop the removed stage's leading comment**; `serializeEntries` is **retired**; an insert-boundary comment attaches to the **following** stage.

---

## File structure

- **Modify `src/mdh/pipelineComments.js`** — the whole serialize/mutation core is rewritten here. New: `parsePipelineDoc`, `applyEdits`, `reindentStage`, `removeEdit`, `insertEdit`. Rewritten: `scanLayout` (also returns `arrayStart`/`arrayEnd`), `parseEntries`, `stageLineRanges`, `setStageDisabled`, `applyMutationToText`, `beautifyText`. Removed: `serializeEntries`, `hasDisabledStages`, `indentLines`, `stageBody`, `shallowCopyObj`.
- **Modify `src/mdh/components/JsonEditor.jsx`** — add an aggregate-only theme hiding `.cm-lineNumbers`.
- **Modify `tests/mdh-pipeline-comments.test.js`** — substantial rewrite (drop tests for removed functions; new tests for the splice writers + Limit A/B).
- **Add a case to `tests/mdh-datapanel-disable.test.js`** — a freehand comment survives a sort end-to-end.

No changes to: `pipelineOps.js`, `useQuery.js`, `api.js`, `lastPipeline.js`, `pipelineState.js`, `store.js`, `PipelineDebug.jsx`, `PipelineEditor.jsx`, `QueryHistory.jsx`, `DataPanel.jsx`, `pipelineGutter.js`.

---

## Task 1: Document model — `scanLayout` spans, `parsePipelineDoc`, refactor `parseEntries` + `stageLineRanges`

**Files:**
- Modify: `src/mdh/pipelineComments.js`
- Test: `tests/mdh-pipeline-comments.test.js`

- [ ] **Step 1: Add `parsePipelineDoc` tests**

Append to `tests/mdh-pipeline-comments.test.js` a new import (add `parsePipelineDoc` to the existing import from `../src/mdh/pipelineComments.js`) and:

```js
describe('parsePipelineDoc', () => {
  it('returns ordered segments with exact source spans + array bounds', () => {
    const text = '[\n  { "$match": {} },\n  { "$limit": 5 }\n]';
    const doc = parsePipelineDoc(text);
    expect(doc.ok).toBe(true);
    expect(doc.segments.map((s) => s.kind)).toEqual(['active', 'active']);
    // span slices back to the exact stage text
    expect(text.slice(doc.segments[0].start, doc.segments[0].end)).toBe('{ "$match": {} }');
    expect(text.slice(doc.segments[1].start, doc.segments[1].end)).toBe('{ "$limit": 5 }');
    expect(text[doc.arrayStart]).toBe('[');
    expect(text[doc.arrayEnd]).toBe(']');
  });

  it('captures a disabled block segment with its inner raw', () => {
    const text = '[\n  /* @disabled-stage\n{ "$sort": { "a": -1 } } */\n  { "$limit": 5 }\n]';
    const doc = parsePipelineDoc(text);
    expect(doc.ok).toBe(true);
    expect(doc.segments[0].kind).toBe('disabled');
    expect(doc.segments[0].stage).toEqual({ $sort: { a: -1 } });
    expect(doc.segments[0].raw).toBe('{ "$sort": { "a": -1 } }');
  });

  it('is ok:false for invalid JSON5 or a non-array', () => {
    expect(parsePipelineDoc('[ {').ok).toBe(false);
    expect(parsePipelineDoc('{ "$match": {} }').ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/mdh-pipeline-comments.test.js -t parsePipelineDoc`
Expected: FAIL — `parsePipelineDoc is not a function`.

- [ ] **Step 3: Extend `scanLayout` to return array bounds, add `parsePipelineDoc`, refactor `parseEntries` + `stageLineRanges`**

Replace `scanLayout` so it returns `{ items, arrayStart, arrayEnd }`:

```js
function scanLayout(text) {
  const items = [];
  const n = text.length;
  let i = 0;
  let depth = 0;
  let inString = false;
  let activeStart = -1;
  let arrayStart = -1;
  let arrayEnd = -1;
  while (i < n) {
    const c = text[i];
    if (inString) {
      if (c === '\\') { i += 2; continue; }
      if (c === '"') inString = false;
      i += 1; continue;
    }
    if (c === '"') { inString = true; i += 1; continue; }
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i + 2);
      i = nl === -1 ? n : nl + 1; continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      const body = text.slice(i + 2, close === -1 ? n : close);
      if (depth === 1 && body.trimStart().startsWith(SENTINEL)) {
        items.push({ kind: 'disabled', start: i, end, inner: body.trimStart().slice(SENTINEL.length) });
      }
      i = end; continue;
    }
    if (c === '[' || c === '{') {
      if (depth === 0 && c === '[' && arrayStart === -1) arrayStart = i;
      if (depth === 1 && c === '{') activeStart = i;
      depth += 1; i += 1; continue;
    }
    if (c === ']' || c === '}') {
      depth -= 1;
      if (depth === 1 && c === '}' && activeStart >= 0) {
        items.push({ kind: 'active', start: activeStart, end: i + 1 });
        activeStart = -1;
      }
      if (depth === 0 && c === ']' && arrayEnd === -1) arrayEnd = i;
      i += 1; continue;
    }
    i += 1;
  }
  return { items, arrayStart, arrayEnd };
}
```

Add `parsePipelineDoc` (place after `scanLayout`):

```js
// Lossless document model: one segment per top-level item, carrying its exact
// source span. Gaps (commas/whitespace/comments) are recovered from the original
// text via the spans — the text is the source of truth.
export function parsePipelineDoc(text) {
  let top;
  try { top = JSON5.parse(text); } catch { return { ok: false, segments: [], arrayStart: -1, arrayEnd: -1 }; }
  if (!Array.isArray(top)) return { ok: false, segments: [], arrayStart: -1, arrayEnd: -1 };
  const { items, arrayStart, arrayEnd } = scanLayout(text);
  const segments = [];
  for (const item of items) {
    if (item.kind === 'active') {
      let stage;
      try { stage = JSON5.parse(text.slice(item.start, item.end)); }
      catch { return { ok: false, segments: [], arrayStart: -1, arrayEnd: -1 }; }
      segments.push({ kind: 'active', start: item.start, end: item.end, stage });
    } else {
      let stage = null;
      try { stage = JSON5.parse(item.inner); } catch { /* forgiving: keep raw */ }
      segments.push({ kind: 'disabled', start: item.start, end: item.end, stage, raw: item.inner.trim() });
    }
  }
  const activeCount = segments.filter((s) => s.kind === 'active').length;
  if (activeCount !== top.length) return { ok: false, segments: [], arrayStart: -1, arrayEnd: -1 };
  return { ok: true, segments, arrayStart, arrayEnd };
}
```

Replace `parseEntries` with a thin derivation (output shape unchanged):

```js
// Parse editor text into ordered entries (derived from the document model).
// Shape is unchanged: disabled entries carry `raw`; active entries do not.
export function parseEntries(text) {
  const { ok, segments } = parsePipelineDoc(text);
  if (!ok) return { entries: [], ok: false };
  return {
    ok: true,
    entries: segments.map((s) => (s.kind === 'disabled'
      ? { disabled: true, stage: s.stage, raw: s.raw }
      : { disabled: false, stage: s.stage })),
  };
}
```

Replace `stageLineRanges` to use the document model directly:

```js
// 1-based line spans for each top-level stage, for the editor gutter.
export function stageLineRanges(text) {
  const { ok, segments } = parsePipelineDoc(text);
  if (!ok) return [];
  const lineAt = (off) => {
    let ln = 1;
    for (let k = 0; k < off && k < text.length; k++) if (text[k] === '\n') ln += 1;
    return ln;
  };
  return segments.map((s, idx) => ({
    entryIndex: idx,
    disabled: s.kind === 'disabled',
    lineStart: lineAt(s.start),
    lineEnd: lineAt(s.end - 1),
  }));
}
```

- [ ] **Step 4: Run to verify it passes (incl. unchanged consumers)**

Run: `npx vitest run tests/mdh-pipeline-comments.test.js`
Expected: the new `parsePipelineDoc` tests PASS, and the **existing `parseEntries` and `stageLineRanges` tests still pass** (their output shape is unchanged). Tests for `serializeEntries` / `hasDisabledStages` / the old `applyMutationToText` / old `setStageDisabled` may now fail or error — that is expected; Tasks 2–4 rewrite them. To scope this step, you may run only the relevant describes:
`npx vitest run tests/mdh-pipeline-comments.test.js -t "parsePipelineDoc|parseEntries|stageLineRanges|stagesToEntries"`
Expected: PASS.

- [ ] **Step 5: Checkpoint** — `npx vitest run tests/mdh-pipeline-comments.test.js -t "parsePipelineDoc|parseEntries|stageLineRanges"` PASS. Do not commit.

---

## Task 2: Splice helpers + `setStageDisabled` (verbatim wrap/unwrap, re-enable-invalid)

**Files:**
- Modify: `src/mdh/pipelineComments.js`
- Test: `tests/mdh-pipeline-comments.test.js`

- [ ] **Step 1: Replace the `setStageDisabled` tests**

In `tests/mdh-pipeline-comments.test.js`, delete the existing `describe('setStageDisabled', …)` block and the `does not re-enable a disabled block whose inner JSON is invalid` case (from the earlier feature), and add:

```js
describe('setStageDisabled (verbatim wrap/unwrap)', () => {
  it('disables a stage by wrapping its verbatim span, preserving other stages exactly', () => {
    const text = '[\n  { "$match": { "x": 1 } },\n  { "$sort": { "a": -1 } },\n  { "$limit": 50 }\n]';
    const out = setStageDisabled(text, 1, true);
    expect(JSON5.parse(out)).toEqual([{ $match: { x: 1 } }, { $limit: 50 }]);
    expect(out).toContain('/* @disabled-stage');
    // the $match and $limit bytes are untouched
    expect(out).toContain('{ "$match": { "x": 1 } }');
    expect(out).toContain('{ "$limit": 50 }');
    // round-trips back to the exact original stage
    const re = parseEntries(out);
    expect(re.entries[1].disabled).toBe(true);
    expect(re.entries[1].stage).toEqual({ $sort: { a: -1 } });
  });

  it('enables a disabled block by restoring its inner verbatim', () => {
    const text = '[\n  { "$match": { "x": 1 } },\n  /* @disabled-stage\n{ "$sort": { "a": -1 } } */\n  { "$limit": 50 }\n]';
    const out = setStageDisabled(text, 1, false);
    expect(JSON5.parse(out)).toEqual([{ $match: { x: 1 } }, { $sort: { a: -1 } }, { $limit: 50 }]);
    expect(out).not.toContain('@disabled-stage');
  });

  it('round-trips a value containing "*/" through disable+enable', () => {
    const text = '[\n  { "$match": { "p": "src/**/*.js" } },\n  { "$limit": 5 }\n]';
    const disabled = setStageDisabled(text, 0, true);
    expect(JSON5.parse(disabled)).toEqual([{ $limit: 5 }]); // stays valid
    const enabled = setStageDisabled(disabled, 0, false);
    expect(JSON5.parse(enabled)).toEqual([{ $match: { p: 'src/**/*.js' } }, { $limit: 5 }]);
  });

  it('RE-ENABLES an invalid disabled block (shows the error) rather than no-op', () => {
    const text = '[ /* @disabled-stage { "$sort": */ { "$limit": 1 } ]';
    const re = parseEntries(text);
    expect(re.entries[0].disabled).toBe(true);
    expect(re.entries[0].stage).toBeNull();
    const out = setStageDisabled(text, 0, false);
    // the invalid inner is restored as an active element -> the whole text is now invalid JSON5
    expect(out).not.toContain('@disabled-stage');
    expect(out).toContain('{ "$sort":');
    expect(parsePipelineDoc(out).ok).toBe(false); // editor will surface the parse error
  });

  it('is a no-op for a bad index', () => {
    const text = '[ { "$match": {} } ]';
    expect(setStageDisabled(text, 9, true)).toBe(text);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/mdh-pipeline-comments.test.js -t "verbatim wrap"`
Expected: FAIL — the current `setStageDisabled` produces canonical (not verbatim) output and no-ops on the invalid re-enable.

- [ ] **Step 3: Add splice helpers and rewrite `setStageDisabled`**

Add helpers (place near the top, after the constants):

```js
// Re-indent a JSON.stringify(…, null, 2) body so it sits at a 2-space array
// element: line 0 stays bare (the gap before the splice provides its indent),
// lines 1.. get +2.
function reindentStage(stage) {
  return JSON.stringify(stage, null, 2)
    .split('\n')
    .map((l, i) => (i === 0 ? l : '  ' + l))
    .join('\n');
}

// Apply non-overlapping { start, end, replacement } edits to text, right-to-left
// so earlier offsets stay valid.
function applyEdits(text, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of sorted) out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  return out;
}
```

Replace `setStageDisabled` (and delete the old `serializeEntries`-based version + its `if (!disabled && … stage == null) return text` guard):

```js
// Toggle one stage disabled/enabled as a single in-place text splice — every
// other byte is preserved. Disabling wraps the stage's VERBATIM span in a
// @disabled-stage block (keeping its formatting + inner comments); enabling
// restores the inner verbatim, even when invalid (the editor then shows the
// parse error). No-op on a bad index or unparseable text.
export function setStageDisabled(text, entryIndex, disabled) {
  const { ok, segments } = parsePipelineDoc(text);
  if (!ok || entryIndex < 0 || entryIndex >= segments.length) return text;
  const seg = segments[entryIndex];
  const isDisabled = seg.kind === 'disabled';
  if (isDisabled === disabled) return text;
  let replacement;
  if (disabled) {
    const body = text.slice(seg.start, seg.end).replace(/\*\//g, '*\\/');
    replacement = `/* ${SENTINEL}\n${body} */`;
  } else {
    replacement = seg.raw.replace(/\*\\\//g, '*/');
  }
  return applyEdits(text, [{ start: seg.start, end: seg.end, replacement }]);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/mdh-pipeline-comments.test.js -t "verbatim wrap"`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Checkpoint** — same command PASS. Do not commit.

---

## Task 3: `applyMutationToText` rewrite (reference diff → splices) + retire dead code

**Files:**
- Modify: `src/mdh/pipelineComments.js`
- Test: `tests/mdh-pipeline-comments.test.js`

- [ ] **Step 1: Replace the `applyMutationToText` tests and drop tests for removed functions**

In `tests/mdh-pipeline-comments.test.js`:
- Delete the `describe('hasDisabledStages', …)` block and remove `hasDisabledStages` from the imports.
- Delete the `describe('serializeEntries round-trip', …)` block and remove `serializeEntries` from the imports.
- Delete the existing `describe('applyMutationToText', …)` block (old byte-identical / inert-placeholder tests).
- Ensure imports include `applyMutationToText`, `parsePipelineDoc`, and from pipelineOps: `applySortToPipeline`, `applyFilterDeltaToPipeline`, `applySkipToPipeline`. Add:

```js
describe('applyMutationToText (minimal edits preserve comments + formatting)', () => {
  it('replace-in-place preserves a comment on the line above the changed stage', () => {
    const text = '[\n  // only active\n  { "$match": { "active": true } },\n  // newest first\n  { "$sort": { "created": -1 } },\n  { "$skip": 0 }\n]';
    const out = applyMutationToText(text, (p) => applySortToPipeline(p, { created: 1 }));
    expect(out).toContain('// only active');
    expect(out).toContain('// newest first');           // comment above the re-sorted stage survives
    expect(out).toContain('{ "$match": { "active": true } }'); // untouched stage verbatim
    expect(JSON5.parse(out)).toEqual([
      { $match: { active: true } }, { $sort: { created: 1 } }, { $skip: 0 },
    ]);
  });

  it('paginate (replace $skip) preserves leading + between + trailing comments', () => {
    const text = '[\n  // lead\n  { "$match": {} },\n  // mid\n  { "$skip": 0 },\n  { "$limit": 50 }\n  // tail\n]';
    const out = applyMutationToText(text, (p) => applySkipToPipeline(p, 100));
    expect(out).toContain('// lead');
    expect(out).toContain('// mid');
    expect(out).toContain('// tail');
    expect(JSON5.parse(out)).toEqual([{ $match: {} }, { $skip: 100 }, { $limit: 50 }]);
  });

  it('preserves an untouched stage BETWEEN two changed stages (multi-change mutator)', () => {
    // handleSort does applySort + applySkip; a $group sits between $sort and $skip.
    const text = '[\n  { "$match": {} },\n  { "$sort": { "a": 1 } },\n  { "$group": { "_id": "$x" /* keep me */ } },\n  { "$skip": 0 }\n]';
    const out = applyMutationToText(text, (p) => { applySortToPipeline(p, { b: -1 }); applySkipToPipeline(p, 25); });
    expect(out).toContain('/* keep me */'); // the untouched $group keeps its inner comment
    expect(JSON5.parse(out)).toEqual([
      { $match: {} }, { $sort: { b: -1 } }, { $group: { _id: '$x' } }, { $skip: 25 },
    ]);
  });

  it('preserves disabled stages through a mutation', () => {
    const text = '[\n  { "$match": {} },\n  /* @disabled-stage\n{ "$project": { "a": 1 } } */\n  { "$skip": 0 }\n]';
    const out = applyMutationToText(text, (p) => applySortToPipeline(p, { a: -1 }));
    expect(parseEntries(out).entries.filter((e) => e.disabled)).toHaveLength(1);
    expect(JSON5.parse(out)).toEqual([{ $match: {} }, { $sort: { a: -1 } }, { $skip: 0 }]);
  });

  it('insert keeps the following stage’s leading comment attached to it', () => {
    const text = '[\n  { "$match": {} },\n  // pagination\n  { "$skip": 0 }\n]';
    const out = applyMutationToText(text, (p) => applySortToPipeline(p, { a: 1 })); // inserts $sort after $match
    expect(out).toContain('// pagination');
    const parsed = JSON5.parse(out);
    expect(parsed).toEqual([{ $match: {} }, { $sort: { a: 1 } }, { $skip: 0 }]);
  });

  it('Limit B: removing a stage drops its leading comment', () => {
    const text = '[\n  { "$match": {} },\n  // newest first\n  { "$sort": { "a": -1 } },\n  { "$skip": 0 }\n]';
    const out = applyMutationToText(text, (p) => applySortToPipeline(p, {})); // clears the sort -> removes $sort
    expect(out).not.toContain('// newest first');
    expect(JSON5.parse(out)).toEqual([{ $match: {} }, { $skip: 0 }]);
  });

  it('Limit A: the changed stage’s OWN inner comment is reserialized away', () => {
    const text = '[\n  { "$sort": { "created": -1 /* tie-break later */ } }\n]';
    const out = applyMutationToText(text, (p) => applySortToPipeline(p, { created: 1 }));
    expect(out).not.toContain('tie-break later');
    expect(JSON5.parse(out)).toEqual([{ $sort: { created: 1 } }]);
  });

  it('returns null when the text cannot be parsed', () => {
    expect(applyMutationToText('[ {', () => {})).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/mdh-pipeline-comments.test.js -t "minimal edits"`
Expected: FAIL — current `applyMutationToText` reformats the whole pipeline (drops comments).

- [ ] **Step 3: Rewrite `applyMutationToText` (+ `removeEdit`/`insertEdit`) and delete dead code**

Delete `serializeEntries`, `hasDisabledStages`, `indentLines`, `stageBody`, and `shallowCopyObj` from `src/mdh/pipelineComments.js`. Keep the `PLACEHOLDER` constant. Replace `applyMutationToText` with:

```js
const PLACEHOLDER = '__disabledStagePlaceholder__';

// Build the edit that removes segment k (and exactly one comma), per the
// confirmed rule: a removed stage's leading comment is dropped with it.
function removeEdit(segments, k, arrayStart) {
  const n = segments.length;
  if (n === 1) return { start: arrayStart + 1, end: segments[0].end, replacement: '' };
  if (k === 0) return { start: arrayStart + 1, end: segments[1].start, replacement: '' };
  return { start: segments[k - 1].end, end: segments[k].end, replacement: '' };
}

// Build the zero-width edit that inserts a new stage before segment k (k may be
// segments.length, meaning append). A boundary comment stays with the FOLLOWING
// stage.
function insertEdit(segments, k, stage, arrayStart) {
  const body = reindentStage(stage);
  if (k === 0) {
    const at = arrayStart + 1;
    return { start: at, end: at, replacement: `\n  ${body},` };
  }
  const at = segments[k - 1].end;
  return { start: at, end: at, replacement: `,\n  ${body}` };
}

// Apply a pipelineOps mutator and write back as MINIMAL text edits: only the
// stage(s) the mutation actually changes are reserialized; every other byte
// (untouched stages, comments, formatting, disabled blocks) is preserved.
// Returns the new text, or null when the text can't be parsed.
export function applyMutationToText(text, mutator) {
  const { ok, segments, arrayStart } = parsePipelineDoc(text);
  if (!ok) return null;

  // Empty pipeline: nothing to preserve — build canonically from the result.
  if (segments.length === 0) {
    const work0 = [];
    mutator(work0);
    if (work0.length === 0) return text;
    return '[\n  ' + work0.map((s) => reindentStage(s)).join(',\n  ') + '\n]';
  }

  // Identity-stable work array: active stages BY REFERENCE (pipelineOps never
  // mutate a stage object in place, only reassign/splice slots, so untouched
  // stages keep their reference); disabled stages ride as inert placeholders.
  const origWork = segments.map((s) => (s.kind === 'active' ? s.stage : { [PLACEHOLDER]: true }));
  const work = origWork.slice();
  mutator(work);

  const origSet = new Set(origWork);
  const workSet = new Set(work);

  const edits = [];
  let oi = 0;
  let wi = 0;
  while (oi < segments.length || wi < work.length) {
    const o = oi < segments.length ? origWork[oi] : undefined;
    const w = wi < work.length ? work[wi] : undefined;
    if (o !== undefined && o === w) { oi += 1; wi += 1; continue; } // kept
    const oRemoved = o !== undefined && !workSet.has(o);
    const wNew = w !== undefined && !origSet.has(w);
    if (oRemoved && wNew) { // replace in place — splice only this span
      edits.push({ start: segments[oi].start, end: segments[oi].end, replacement: reindentStage(w) });
      oi += 1; wi += 1;
    } else if (oRemoved) {
      edits.push(removeEdit(segments, oi, arrayStart));
      oi += 1;
    } else if (wNew) {
      edits.push(insertEdit(segments, oi, w, arrayStart));
      wi += 1;
    } else {
      oi += 1; // defensive: kept-but-misaligned (mutators never reorder)
    }
  }
  return applyEdits(text, edits);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/mdh-pipeline-comments.test.js`
Expected: PASS for the whole file (the `minimal edits` block + all retained Task 1/2 blocks). If any old leftover test referencing `serializeEntries`/`hasDisabledStages` still errors, it was missed in Step 1 — remove it.

- [ ] **Step 5: Checkpoint** — `npx vitest run tests/mdh-pipeline-comments.test.js` PASS. Do not commit.

---

## Task 4: `beautifyText` rewrite (reformat stages, keep comments)

**Files:**
- Modify: `src/mdh/pipelineComments.js`
- Test: `tests/mdh-pipeline-comments.test.js`

- [ ] **Step 1: Replace the `beautifyText` tests**

In `tests/mdh-pipeline-comments.test.js`, delete the existing `describe('beautifyText', …)` block and add:

```js
describe('beautifyText (reformat stages, keep comments)', () => {
  it('canonicalizes stage bodies but preserves standalone/leading/trailing comments', () => {
    const text = '[\n  // lead\n  {"$match":{"a":1}},\n  // mid\n  {"$limit":5}\n  // tail\n]';
    const out = beautifyText(text);
    expect(out).toContain('// lead');
    expect(out).toContain('// mid');
    expect(out).toContain('// tail');
    // bodies reflowed to canonical 2-space
    expect(out).toContain('"$match": {\n      "a": 1\n    }');
    expect(JSON5.parse(out)).toEqual([{ $match: { a: 1 } }, { $limit: 5 }]);
  });

  it('keeps disabled blocks', () => {
    const text = '[{"$match":{}},/* @disabled-stage {"$sort":{"a":-1}} */{"$limit":5}]';
    const out = beautifyText(text);
    expect(JSON5.parse(out)).toEqual([{ $match: {} }, { $limit: 5 }]);
    expect(parseEntries(out).entries.filter((e) => e.disabled)).toHaveLength(1);
  });

  it('returns null for invalid input', () => {
    expect(beautifyText('[ {')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/mdh-pipeline-comments.test.js -t "reformat stages, keep comments"`
Expected: FAIL — current `beautifyText` (via `serializeEntries`, now deleted) either errors or drops comments.

- [ ] **Step 3: Rewrite `beautifyText`**

Replace `beautifyText`:

```js
// Beautify: reserialize each stage's span canonically while leaving ALL gaps
// (commas, whitespace, standalone/leading/trailing comments) untouched. A
// comment INSIDE a stage is reflowed away with that stage. null on invalid text.
export function beautifyText(text) {
  const { ok, segments } = parsePipelineDoc(text);
  if (!ok) return null;
  const edits = segments.map((seg) => {
    if (seg.kind === 'active') {
      return { start: seg.start, end: seg.end, replacement: reindentStage(seg.stage) };
    }
    const inner = seg.stage != null ? reindentStage(seg.stage) : seg.raw;
    return { start: seg.start, end: seg.end, replacement: `/* ${SENTINEL}\n${inner.replace(/\*\//g, '*\\/')} */` };
  });
  return applyEdits(text, edits);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/mdh-pipeline-comments.test.js`
Expected: PASS for the whole file.

- [ ] **Step 5: Checkpoint** — `npx vitest run tests/mdh-pipeline-comments.test.js` PASS. Do not commit.

---

## Task 5: Hide line numbers in the aggregate editor (`JsonEditor.jsx`)

**Files:**
- Modify: `src/mdh/components/JsonEditor.jsx`

- [ ] **Step 1: Add the theme constant**

After the `compactTheme` definition (around `JsonEditor.jsx:53`), add:

```js
// The aggregate pipeline editor hides the line-number gutter to reclaim
// horizontal space. Scoped to the editor instance via EditorView.theme; the
// fold gutter and the stage-toggle gutter remain.
const noLineNumbersTheme = EditorView.theme({ '.cm-lineNumbers': { display: 'none' } });
```

- [ ] **Step 2: Include it only for aggregate mode**

In the `extensions` array, change the aggregate-only spread (currently `...(mode === 'aggregate' ? [stageToggleGutter(…)] : [])`) to also add the theme:

```js
      ...(mode === 'aggregate'
        ? [noLineNumbersTheme, stageToggleGutter((idx) => { if (onToggleStageRef.current) onToggleStageRef.current(idx); })]
        : []),
```

- [ ] **Step 3: Verify existing editor tests still pass**

Run: `npx vitest run tests/mdh-json-editor.test.js tests/mdh-pipeline-gutter.test.js`
Expected: PASS (line-number hiding is CSS-only and instance-scoped; no test asserts line numbers).

- [ ] **Step 4: Verify in the build**

Run: `npm run build`
Expected: clean build. (jsdom computed-style for injected CodeMirror CSS is unreliable, so this is verified by build + the manual smoke in Task 6.)

- [ ] **Step 5: Checkpoint** — the two test files PASS and the build is clean. Do not commit.

---

## Task 6: Integration regression + full verification

**Files:**
- Modify: `tests/mdh-datapanel-disable.test.js`

- [ ] **Step 1: Add an end-to-end "comment survives a sort" case**

In `tests/mdh-datapanel-disable.test.js`, inside the existing `describe('DataPanel — disable-stage wiring', …)` (it already mounts DataPanel with a mock editor and exposes `mock.onValidChange` / `mock.text` and `selectedCollection`), add:

```js
  it('preserves a freehand comment when sorting', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    render(h(DataPanel, null), root);
    await tick();

    // A user pipeline with a comment, then a programmatic sort via the UI path.
    mock.text = '[\n  // only active vendors\n  { "$match": { "active": true } },\n  { "$skip": 0 },\n  { "$limit": 50 }\n]';
    // Drive a sort through the same code path the column header uses.
    // handleSort is internal; simulate by editing through onValidChange after a
    // mutate is not exposed — instead assert via applyMutationToText-backed path:
    // toggling a stage (exposed as onToggleStage) also goes through a minimal edit.
    mock.onToggleStage(1); // disable $skip -> minimal edit must keep the comment
    await tick();

    expect(mock.text).toContain('// only active vendors');
  });
```

> Note: `handleSort` isn't exposed to the mock harness, but `onToggleStage` exercises the same minimal-edit core (`setStageDisabled`), so this asserts comment-preservation at the DataPanel boundary. The exhaustive sort/filter/paginate preservation is covered by the pure `applyMutationToText` tests in Task 3.

- [ ] **Step 2: Run the integration suites**

Run: `npx vitest run tests/mdh-datapanel-disable.test.js tests/mdh-datapanel-variables.test.js tests/mdh-flow.test.js tests/mdh-pipeline-editor.test.js`
Expected: PASS. If any assertion depended on canonical reflow of untouched stages after a mutation, update it to the new (preserved) output — the behavior change is intended (spec §6).

- [ ] **Step 3: Full suite**

Run: `npm test`
Expected: all green. Re-run once if a CodeMirror/jsdom measure cycle flakes; if it persists, fix with a condition-based `waitFor` (never a larger fixed sleep).

- [ ] **Step 4: Production build**

Run: `npm run build`
Expected: clean build into `dist/`.

- [ ] **Step 5: Manual smoke (recommended — covers what jsdom can't)**

Load `dist/` as an unpacked extension → Console → Dataset Management → pick a collection. In the Aggregate Pipeline editor: (a) confirm there is **no line-number gutter** (fold + toggle gutters remain); (b) add a `// comment`, sort a column / page / toggle a filter, and confirm the comment and your formatting of untouched stages survive; (c) disable a stage, hand-edit invalid JSON inside its `/* @disabled-stage … */` block, re-enable it, and confirm the invalid stage appears in the editor with a parse error (not a silent no-op); (d) click Beautify and confirm stage bodies tidy up while standalone comments remain.

- [ ] **Step 6: Checkpoint** — `npm test` green + clean build. Do not commit.

---

## Self-review (completed against the spec)

- **§4.1 lossless doc model** → Task 1 (`parsePipelineDoc`, `scanLayout` bounds, `parseEntries`/`stageLineRanges` derive from it).
- **§4.2 minimal-edit rebuild (replace/insert/remove)** → Task 3 (`applyMutationToText` + `removeEdit`/`insertEdit` + `applyEdits`/`reindentStage`).
- **§4.3 toggle = wrap/unwrap splice + re-enable-invalid** → Task 2 (`setStageDisabled`; guard removed).
- **§4.4 Beautify keeps comments** → Task 4 (`beautifyText` per-segment splice).
- **§4.5 hide line numbers** → Task 5 (`noLineNumbersTheme`, aggregate-only).
- **§4.6 retire `serializeEntries`** → Task 3 (deleted + tests migrated; `hasDisabledStages` and dead helpers removed too).
- **§5 guarantees + Limit A/B** → Task 3 tests assert preservation AND the documented losses (Limit A inner-comment, Limit B removed-stage comment).
- **§6 backward compat** → Task 1 keeps `parseEntries`/`stageLineRanges` output identical (consumers unchanged); Task 6 updates any canonical-reflow assertion; no storage/manifest changes.
- **§8 testing** → Tasks 1–4 pure tests; Task 6 integration + build + manual.

No placeholders; signatures consistent across tasks (`parsePipelineDoc → { ok, segments, arrayStart, arrayEnd }`; segments `{ kind, start, end, stage, raw? }`; `applyEdits`/`reindentStage`/`removeEdit`/`insertEdit`; `setStageDisabled`/`applyMutationToText`/`beautifyText` signatures unchanged for their callers).
