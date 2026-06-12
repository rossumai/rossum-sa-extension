# Disable Individual Aggregation Stages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Project workflow override:** Do **NOT** create git commits or branches. Stay on `master`.
> Every task ends with a **green-test checkpoint** (`npx vitest run …`) instead of a commit.
> Final verification is `npm test` + `npm run build`.

**Goal:** Let the user toggle individual aggregation-pipeline stages on/off in the Dataset
Management Data panel — from both the Pipeline Debug stage list and the editor gutter — by
commenting/uncommenting them in place, so disabled stages persist and survive sort/filter/paging.

**Architecture:** A disabled stage is a `/* @disabled-stage … */` block comment in the editor
text. Because `JSON5.parse` drops comments, disabled stages are automatically excluded from the
query, per-stage counts, and downloads with no change to those paths. A new pure module
(`pipelineComments.js`) parses the text into ordered `{ disabled, stage }` entries and serializes
them back, preserving disabled blocks through the sort/filter/paginate rebuild (which today
re-serializes via `JSON.stringify` and strips comments). The existing `pipelineOps.js` mutators
are reused unchanged — during a rebuild, disabled stages ride along as inert placeholder objects
the mutators ignore, so their relative positions are preserved automatically.

**Tech Stack:** Preact + `@preact/signals`, CodeMirror 6 (`@codemirror/view` gutter + decorations),
`json5`, Vitest (+ jsdom). Tests live in `tests/*.test.js`.

**Spec:** `docs/superpowers/specs/2026-06-11-mdh-disable-aggregation-stages-design.md`

> **Refinements vs the spec (intentional):**
> - The spec's "reference-anchoring" (§4.2) is implemented by the more robust **inert-placeholder**
>   technique: disabled stages become no-op objects during a mutation, so `pipelineOps` keeps them
>   in place; no anchor matching is needed.
> - Empty-pipeline normalization (§4.3) lives in DataPanel via a pure `normalizeEffectivePipelineText`
>   helper, leaving `useQuery.js` untouched (honoring §7's "no changes to useQuery.js").

---

## File structure

- **Create `src/mdh/pipelineComments.js`** — pure parse/serialize/toggle/mutation layer. Sole new
  primitive; everything else consumes it.
- **Create `src/mdh/pipelineGutter.js`** — CodeMirror extension: stage toggle gutter + greyed
  disabled lines. Isolated so `JsonEditor.jsx` only gains a few lines.
- **Modify `src/mdh/components/PipelineDebug.jsx`** — consume entries; render disabled rows greyed;
  skip them in counts; per-row toggle.
- **Modify `src/mdh/components/JsonEditor.jsx`** — wire the aggregate-mode gutter via a new
  `onToggleStage` prop.
- **Modify `src/mdh/components/PipelineEditor.jsx`** — thread `onToggleStage`; make Beautify entries-aware.
- **Modify `src/mdh/components/DataPanel.jsx`** — comment-preserving `mutatePipelineText`; empty-pipeline
  normalization; pass entries + toggle handler to PipelineDebug and PipelineEditor.
- **Modify `src/mdh/components/QueryHistory.jsx`** — disable-aware `dedupKey`.
- **Modify `src/console/console.css`** — styles for disabled rows, toggle controls, gutter, greyed lines.

No changes to: `useQuery.js`, `pipelineOps.js`, `api.js`, `lastPipeline.js`, `pipelineState.js`,
`store.js`, the download serializers.

---

## Task 1: `pipelineComments.js` — parse / serialize / detect

**Files:**
- Create: `src/mdh/pipelineComments.js`
- Test: `tests/mdh-pipeline-comments.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/mdh-pipeline-comments.test.js
import { describe, it, expect } from 'vitest';
import {
  hasDisabledStages,
  parseEntries,
  serializeEntries,
  stagesToEntries,
} from '../src/mdh/pipelineComments.js';

const A = '[\n  { "$match": { "x": 1 } },\n  { "$limit": 50 }\n]';

describe('hasDisabledStages', () => {
  it('is false for a plain pipeline', () => {
    expect(hasDisabledStages(A)).toBe(false);
  });
  it('is true when a @disabled-stage block is present', () => {
    expect(hasDisabledStages('[ /* @disabled-stage\n{"$sort":{"a":-1}} */ ]')).toBe(true);
  });
});

describe('stagesToEntries', () => {
  it('wraps a plain stage array as all-enabled entries', () => {
    expect(stagesToEntries([{ $match: {} }, { $limit: 5 }])).toEqual([
      { disabled: false, stage: { $match: {} } },
      { disabled: false, stage: { $limit: 5 } },
    ]);
  });
  it('returns [] for null / non-array', () => {
    expect(stagesToEntries(null)).toEqual([]);
    expect(stagesToEntries({})).toEqual([]);
  });
});

describe('parseEntries', () => {
  it('parses an all-active pipeline in order', () => {
    const { entries, ok } = parseEntries(A);
    expect(ok).toBe(true);
    expect(entries).toEqual([
      { disabled: false, stage: { $match: { x: 1 } } },
      { disabled: false, stage: { $limit: 50 } },
    ]);
  });

  it('parses a disabled block interleaved at its position', () => {
    const text = '[\n  { "$match": { "x": 1 } },\n  /* @disabled-stage\n  {\n    "$sort": { "a": -1 }\n  } */\n  { "$limit": 50 }\n]';
    const { entries, ok } = parseEntries(text);
    expect(ok).toBe(true);
    expect(entries.map((e) => e.disabled)).toEqual([false, true, false]);
    expect(entries[1].stage).toEqual({ $sort: { a: -1 } });
    expect(entries[2].stage).toEqual({ $limit: 50 });
  });

  it('does not treat a sentinel inside a string literal as a disabled stage', () => {
    const text = '[ { "$match": { "note": "/* @disabled-stage */" } } ]';
    const { entries, ok } = parseEntries(text);
    expect(ok).toBe(true);
    expect(entries).toHaveLength(1);
    expect(entries[0].disabled).toBe(false);
  });

  it('ignores a @disabled-stage block nested inside a stage (depth > 1)', () => {
    const text = '[ { "$match": { "x": 1 } /* @disabled-stage {"$sort":{}} */ } ]';
    const { entries, ok } = parseEntries(text);
    expect(ok).toBe(true);
    expect(entries).toHaveLength(1);
    expect(entries[0].disabled).toBe(false);
  });

  it('returns ok:false for invalid JSON5', () => {
    expect(parseEntries('[ { "$match": ').ok).toBe(false);
  });

  it('returns ok:false for a non-array top level', () => {
    expect(parseEntries('{ "$match": {} }').ok).toBe(false);
  });

  it('keeps a disabled block whose inner JSON is invalid (forgiving), stage=null + raw', () => {
    const text = '[ /* @disabled-stage { "$sort": */ { "$limit": 1 } ]';
    const { entries, ok } = parseEntries(text);
    expect(ok).toBe(true);
    expect(entries[0].disabled).toBe(true);
    expect(entries[0].stage).toBeNull();
    expect(entries[0].raw).toContain('$sort');
  });
});

describe('serializeEntries round-trip', () => {
  it('parse -> serialize -> parse preserves stages and disabled flags', () => {
    const text = '[\n  { "$match": { "x": 1 } },\n  /* @disabled-stage\n  {\n    "$sort": { "a": -1 }\n  } */\n  { "$limit": 50 }\n]';
    const first = parseEntries(text);
    const round = parseEntries(serializeEntries(first.entries));
    expect(round.ok).toBe(true);
    expect(round.entries.map((e) => [e.disabled, e.stage])).toEqual(
      first.entries.map((e) => [e.disabled, e.stage]),
    );
  });

  it('serialized active-only output parses (via JSON5) to the active stages only', async () => {
    const JSON5 = (await import('json5')).default;
    const entries = [
      { disabled: false, stage: { $match: { x: 1 } } },
      { disabled: true, stage: { $sort: { a: -1 } } },
      { disabled: false, stage: { $limit: 50 } },
    ];
    const out = serializeEntries(entries);
    expect(JSON5.parse(out)).toEqual([{ $match: { x: 1 } }, { $limit: 50 }]);
    expect(out).toContain('/* @disabled-stage');
  });

  it('serializes an all-disabled pipeline to JSON5-empty (parses to [])', async () => {
    const JSON5 = (await import('json5')).default;
    const out = serializeEntries([{ disabled: true, stage: { $sort: { a: 1 } } }]);
    expect(JSON5.parse(out)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mdh-pipeline-comments.test.js`
Expected: FAIL — `Failed to resolve import "../src/mdh/pipelineComments.js"`.

- [ ] **Step 3: Write the implementation**

```js
// src/mdh/pipelineComments.js
import JSON5 from 'json5';

const SENTINEL = '@disabled-stage';

// Wrap a plain stage array as all-enabled entries (for callers/tests that hand
// us a parsed pipeline rather than editor text).
export function stagesToEntries(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((stage) => ({ disabled: false, stage }));
}

// Cheap gate for the fast path in applyMutationToText. A false positive only
// costs a (correct) slow path; never a false negative for text we generate.
export function hasDisabledStages(text) {
  return typeof text === 'string' && text.includes(SENTINEL);
}

// Single string/comment/depth-aware scan of the outer array. Returns ordered
// top-level items: active object-stages (char span) and @disabled-stage block
// comments (span + inner text). Aggregation stages are always objects, so an
// active element is detected as a `{` opened at depth 1.
function scanLayout(text) {
  const items = [];
  const n = text.length;
  let i = 0;
  let depth = 0;
  let inString = false;
  let activeStart = -1;
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
      if (depth === 1 && c === '{') activeStart = i;
      depth += 1; i += 1; continue;
    }
    if (c === ']' || c === '}') {
      depth -= 1;
      if (depth === 1 && c === '}' && activeStart >= 0) {
        items.push({ kind: 'active', start: activeStart, end: i + 1 });
        activeStart = -1;
      }
      i += 1; continue;
    }
    i += 1;
  }
  return items;
}

// Parse editor text into ordered entries. Validates overall shape with JSON5
// first (must parse to an array once comments are dropped), then maps positions.
export function parseEntries(text) {
  let top;
  try { top = JSON5.parse(text); } catch { return { entries: [], ok: false }; }
  if (!Array.isArray(top)) return { entries: [], ok: false };

  const items = scanLayout(text);
  const entries = [];
  for (const item of items) {
    if (item.kind === 'active') {
      let stage;
      try { stage = JSON5.parse(text.slice(item.start, item.end)); }
      catch { return { entries: [], ok: false }; }
      entries.push({ disabled: false, stage });
    } else {
      let stage = null;
      try { stage = JSON5.parse(item.inner); } catch { /* forgiving: keep raw */ }
      entries.push({ disabled: true, stage, raw: item.inner.trim() });
    }
  }
  return { entries, ok: true };
}

function indentLines(s, spaces) {
  const pad = ' '.repeat(spaces);
  return s.split('\n').map((l) => (l ? pad + l : l)).join('\n');
}

function stageBody(entry) {
  if (entry.disabled && entry.stage == null && entry.raw != null) return entry.raw;
  return JSON.stringify(entry.stage, null, 2);
}

// Serialize entries to editor text. Commas join consecutive ACTIVE elements only
// (disabled blocks are comments, invisible to JSON5). Format matches the chosen
// preview: `/* @disabled-stage\n<stage>\n*/` with `*/` on the stage's last line.
export function serializeEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '[]';
  let lastActive = -1;
  entries.forEach((e, i) => { if (!e.disabled) lastActive = i; });
  const parts = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const body = indentLines(stageBody(e), 2);
    if (e.disabled) {
      parts.push(`  /* @disabled-stage\n${body} */`);
    } else {
      parts.push(body + (i < lastActive ? ',' : ''));
    }
  }
  return `[\n${parts.join('\n')}\n]`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/mdh-pipeline-comments.test.js`
Expected: PASS (all cases in the file).

- [ ] **Step 5: Checkpoint**

Run: `npx vitest run tests/mdh-pipeline-comments.test.js`
Expected: PASS. Do not commit.

---

## Task 2: `pipelineComments.js` — toggle, mutation, normalize, beautify, line ranges

**Files:**
- Modify: `src/mdh/pipelineComments.js`
- Test: `tests/mdh-pipeline-comments.test.js` (append)

- [ ] **Step 1: Write the failing tests (append to the file)**

```js
// append to tests/mdh-pipeline-comments.test.js
import {
  setStageDisabled,
  applyMutationToText,
  normalizeEffectivePipelineText,
  beautifyText,
  stageLineRanges,
} from '../src/mdh/pipelineComments.js';
import { applySortToPipeline, applySkipToPipeline } from '../src/mdh/pipelineOps.js';
import JSON5 from 'json5';

describe('setStageDisabled', () => {
  it('disables an active stage in place (becomes a comment block)', () => {
    const text = '[\n  { "$match": { "x": 1 } },\n  { "$sort": { "a": -1 } },\n  { "$limit": 50 }\n]';
    const out = setStageDisabled(text, 1, true);
    expect(JSON5.parse(out)).toEqual([{ $match: { x: 1 } }, { $limit: 50 }]);
    expect(out).toContain('/* @disabled-stage');
    const re = parseEntries(out);
    expect(re.entries[1].disabled).toBe(true);
    expect(re.entries[1].stage).toEqual({ $sort: { a: -1 } });
  });

  it('re-enables a disabled stage', () => {
    const text = '[\n  { "$match": { "x": 1 } },\n  /* @disabled-stage\n  { "$sort": { "a": -1 } } */\n  { "$limit": 50 }\n]';
    const out = setStageDisabled(text, 1, false);
    expect(JSON5.parse(out)).toEqual([{ $match: { x: 1 } }, { $sort: { a: -1 } }, { $limit: 50 }]);
  });

  it('is a no-op for an out-of-range index or unparseable text', () => {
    const text = '[ { "$match": {} } ]';
    expect(setStageDisabled(text, 9, true)).toBe(text);
    expect(setStageDisabled('[ {', 0, true)).toBe('[ {');
  });
});

describe('applyMutationToText', () => {
  it('uses the fast path when nothing is disabled (byte-identical to JSON.stringify)', () => {
    const text = '[\n  { "$match": {} },\n  { "$skip": 0 },\n  { "$limit": 50 }\n]';
    const out = applyMutationToText(text, (p) => applySortToPipeline(p, { amount: -1 }));
    expect(out).toBe(JSON.stringify(
      [{ $match: {} }, { $sort: { amount: -1 } }, { $skip: 0 }, { $limit: 50 }],
      null, 2,
    ));
  });

  it('preserves a disabled stage through a sort mutation', () => {
    const text = '[\n  { "$match": { "x": 1 } },\n  /* @disabled-stage\n  { "$project": { "a": 1 } } */\n  { "$skip": 0 },\n  { "$limit": 50 }\n]';
    const out = applyMutationToText(text, (p) => applySortToPipeline(p, { amount: -1 }));
    // active pipeline gains $sort; the disabled $project is still present and disabled.
    expect(JSON5.parse(out)).toEqual([
      { $match: { x: 1 } },
      { $sort: { amount: -1 } },
      { $skip: 0 },
      { $limit: 50 },
    ]);
    const re = parseEntries(out);
    const disabled = re.entries.filter((e) => e.disabled);
    expect(disabled).toHaveLength(1);
    expect(disabled[0].stage).toEqual({ $project: { a: 1 } });
  });

  it('preserves a disabled stage through a pagination mutation', () => {
    const text = '[\n  { "$match": {} },\n  /* @disabled-stage\n  { "$sort": { "a": -1 } } */\n  { "$skip": 0 },\n  { "$limit": 50 }\n]';
    const out = applyMutationToText(text, (p) => applySkipToPipeline(p, 100));
    expect(JSON5.parse(out)).toEqual([{ $match: {} }, { $skip: 100 }, { $limit: 50 }]);
    expect(parseEntries(out).entries.filter((e) => e.disabled)).toHaveLength(1);
  });

  it('returns null when the text cannot be parsed', () => {
    expect(applyMutationToText('[ {', () => {})).toBeNull();
  });
});

describe('normalizeEffectivePipelineText', () => {
  it('turns an empty pipeline into [{ $match: {} }]', () => {
    expect(normalizeEffectivePipelineText('[]')).toBe(JSON.stringify([{ $match: {} }]));
  });
  it('leaves a non-empty pipeline untouched', () => {
    expect(normalizeEffectivePipelineText('[{"$limit":5}]')).toBe('[{"$limit":5}]');
  });
  it('leaves unparseable text untouched', () => {
    expect(normalizeEffectivePipelineText('[ {')).toBe('[ {');
  });
});

describe('beautifyText', () => {
  it('re-serializes while preserving disabled blocks', () => {
    const text = '[{"$match":{}},/* @disabled-stage {"$sort":{"a":-1}} */{"$limit":5}]';
    const out = beautifyText(text);
    expect(JSON5.parse(out)).toEqual([{ $match: {} }, { $limit: 5 }]);
    expect(parseEntries(out).entries.filter((e) => e.disabled)).toHaveLength(1);
  });
  it('returns null for invalid input', () => {
    expect(beautifyText('[ {')).toBeNull();
  });
});

describe('stageLineRanges', () => {
  it('returns 1-based line spans + entryIndex + disabled flag per top-level stage', () => {
    const text = '[\n  { "$match": {} },\n  /* @disabled-stage\n  { "$sort": { "a": -1 } } */\n  { "$limit": 50 }\n]';
    const ranges = stageLineRanges(text);
    expect(ranges).toEqual([
      { entryIndex: 0, disabled: false, lineStart: 2, lineEnd: 2 },
      { entryIndex: 1, disabled: true, lineStart: 3, lineEnd: 4 },
      { entryIndex: 2, disabled: false, lineStart: 5, lineEnd: 5 },
    ]);
  });
  it('returns [] for invalid text', () => {
    expect(stageLineRanges('[ {')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/mdh-pipeline-comments.test.js`
Expected: FAIL — `setStageDisabled is not a function` (and the other new exports undefined).

- [ ] **Step 3: Append the implementation to `src/mdh/pipelineComments.js`**

```js
// append to src/mdh/pipelineComments.js

function shallowCopyObj(s) {
  return s && typeof s === 'object' && !Array.isArray(s) ? { ...s } : s;
}

// Flip one entry's disabled flag (index into the full entries list). No-op on
// bad index or unparseable text (returns the input unchanged).
export function setStageDisabled(text, entryIndex, disabled) {
  const { entries, ok } = parseEntries(text);
  if (!ok || entryIndex < 0 || entryIndex >= entries.length) return text;
  if (entries[entryIndex].disabled === disabled) return text;
  entries[entryIndex] = { ...entries[entryIndex], disabled };
  return serializeEntries(entries);
}

const PLACEHOLDER = '__disabledStagePlaceholder__';

// Apply a pipelineOps mutator to the editor text. Fast path (byte-identical to
// today) when nothing is disabled. Otherwise disabled stages ride along as inert
// placeholder objects the mutators ignore, so their positions are preserved.
// Returns the new text, or null when the text can't be parsed/mutated.
export function applyMutationToText(text, mutator) {
  if (!hasDisabledStages(text)) {
    let parsed;
    try { parsed = JSON5.parse(text); } catch { return null; }
    if (!Array.isArray(parsed)) return null;
    const next = parsed.map(shallowCopyObj);
    mutator(next);
    return JSON.stringify(next, null, 2);
  }
  const { entries, ok } = parseEntries(text);
  if (!ok) return null;
  const work = entries.map((e) => (e.disabled ? { [PLACEHOLDER]: true } : shallowCopyObj(e.stage)));
  mutator(work);
  const disabledStages = entries.filter((e) => e.disabled);
  let di = 0;
  const woven = work.map((item) =>
    (item && typeof item === 'object' && item[PLACEHOLDER])
      ? { disabled: true, stage: disabledStages[di]?.stage ?? null, raw: disabledStages[di++]?.raw }
      : { disabled: false, stage: item });
  return serializeEntries(woven);
}

// Effective pipeline guard: all stages disabled -> JSON5.parse yields [] -> run
// all records instead of sending a bare []. Operates on already-substituted text.
export function normalizeEffectivePipelineText(substitutedText) {
  try {
    const parsed = JSON5.parse(substitutedText);
    if (Array.isArray(parsed) && parsed.length === 0) return JSON.stringify([{ $match: {} }]);
  } catch { /* fall through — let the caller handle invalid text */ }
  return substitutedText;
}

// Entries-aware beautify: re-serialize, preserving disabled blocks. null if invalid.
export function beautifyText(text) {
  const { entries, ok } = parseEntries(text);
  if (!ok) return null;
  return serializeEntries(entries);
}

// 1-based line spans for each top-level stage, for the editor gutter.
export function stageLineRanges(text) {
  const { entries, ok } = parseEntries(text);
  if (!ok) return [];
  const items = scanLayout(text);
  if (items.length !== entries.length) return [];
  const lineAt = (off) => {
    let ln = 1;
    for (let k = 0; k < off && k < text.length; k++) if (text[k] === '\n') ln += 1;
    return ln;
  };
  return items.map((it, idx) => ({
    entryIndex: idx,
    disabled: it.kind === 'disabled',
    lineStart: lineAt(it.start),
    lineEnd: lineAt(it.end - 1),
  }));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/mdh-pipeline-comments.test.js`
Expected: PASS (all Task 1 + Task 2 cases).

- [ ] **Step 5: Checkpoint**

Run: `npx vitest run tests/mdh-pipeline-comments.test.js`
Expected: PASS. Do not commit.

---

## Task 3: `PipelineDebug.jsx` — entries, greyed disabled rows, per-row toggle

**Files:**
- Modify: `src/mdh/components/PipelineDebug.jsx`
- Modify: `tests/mdh-pipeline-debug.test.js`

- [ ] **Step 1: Update the existing test harness to pass entries, add disabled-row tests**

In `tests/mdh-pipeline-debug.test.js`, change the import line and the `mount` helper, the one
direct `render`, and append two new tests.

Replace the import block top (after `vi.mock`):

```js
import * as api from '../src/mdh/api.js';
import PipelineDebug from '../src/mdh/components/PipelineDebug.jsx';
import Modal from '../src/mdh/components/Modal.jsx';
import { selectedCollection, modalContent } from '../src/mdh/store.js';
import { stagesToEntries } from '../src/mdh/pipelineComments.js';
```

Replace `mount`:

```js
function mount(props) {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  document.body.appendChild(root);
  const entries = props.entries ?? stagesToEntries(props.pipeline);
  render(h(PipelineDebug, { entries, onToggleStage: props.onToggleStage ?? (() => {}) }), root);
  return root;
}
```

Replace the direct render inside the "clicking the 0th row…" test:

```js
render(h('div', null,
  h(PipelineDebug, { entries: stagesToEntries(pipeline), onToggleStage: () => {} }),
  h(Modal, null),
), root);
```

Append:

```js
describe('PipelineDebug — disabled stages', () => {
  it('renders a disabled row greyed, with no count request for it', async () => {
    const entries = [
      { disabled: false, stage: { $match: { x: 1 } } },
      { disabled: true, stage: { $sort: { a: -1 } } },
      { disabled: false, stage: { $limit: 50 } },
    ];
    api.aggregate.mockResolvedValue({ result: [{ n: 5 }] });

    const root = mount({ entries });
    // 2 active stage prefixes + 1 input ($collStats). The disabled stage adds none.
    await waitFor(() => api.aggregate.mock.calls.length >= 3, 'active prefixes + input issued');

    const stageCalls = api.aggregate.mock.calls.filter(isStageCountCall);
    expect(stageCalls).toHaveLength(2); // NOT 3 — disabled stage is not counted
    // No prefix request contains $sort (the disabled stage).
    for (const [, pl] of stageCalls) {
      expect(JSON.stringify(pl)).not.toContain('$sort');
    }
    expect(root.querySelector('.pipeline-debug-disabled')).not.toBeNull();
  });

  it('clicking a row toggle calls onToggleStage with the entry index', async () => {
    const entries = [
      { disabled: false, stage: { $match: {} } },
      { disabled: false, stage: { $limit: 50 } },
    ];
    api.aggregate.mockResolvedValue({ result: [{ n: 1 }] });
    const calls = [];
    const root = mount({ entries, onToggleStage: (i) => calls.push(i) });
    await waitFor(() => root.querySelectorAll('.pipeline-stage-toggle').length === 2, 'toggles rendered');

    root.querySelectorAll('.pipeline-stage-toggle')[1].click();
    expect(calls).toEqual([1]);
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run tests/mdh-pipeline-debug.test.js`
Expected: FAIL — `.pipeline-debug-disabled` / `.pipeline-stage-toggle` not found, and the existing
tests fail because `PipelineDebug` still expects a `pipeline` prop.

- [ ] **Step 3: Rewrite `PipelineDebug.jsx` to consume entries**

Replace the component (keep `countCell`, `StageTooltip`, and `StageInspector` unchanged; replace
the default export and its render). Full replacement of the `export default function PipelineDebug`
through the end of that function:

```jsx
export default function PipelineDebug({ entries, onToggleStage }) {
  const [stageCounts, setStageCounts] = useState({});
  const [inputInfo, setInputInfo] = useState(null);
  const collection = selectedCollection.value;

  const list = Array.isArray(entries) ? entries : [];
  const activeStages = list.filter((e) => !e.disabled).map((e) => e.stage);
  const activeKey = JSON.stringify(activeStages);

  useEffect(() => {
    if (!collection || activeStages.length === 0) { setStageCounts({}); setInputInfo(null); return; }
    setStageCounts({});
    setInputInfo(null);

    const controller = new AbortController();
    activeStages.forEach((_, i) => {
      const prefix = activeStages.slice(0, i + 1);
      const t0 = performance.now();
      api.aggregate(collection, [...prefix, { $count: 'n' }], { signal: controller.signal })
        .then((res) => {
          if (controller.signal.aborted) return;
          const n = res?.result?.[0]?.n ?? 0;
          setStageCounts((prev) => ({ ...prev, [i]: { count: n, ms: Math.round(performance.now() - t0) } }));
        })
        .catch((err) => {
          if (err?.name === 'AbortError' || controller.signal.aborted) return;
          setStageCounts((prev) => ({
            ...prev,
            [i]: { error: { message: err?.message || String(err), status: err?.status }, ms: Math.round(performance.now() - t0) },
          }));
        });
    });

    const inputT0 = performance.now();
    api.aggregate(collection, [{ $collStats: { count: {} } }, { $limit: 1 }], { signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return;
        setInputInfo({ count: res?.result?.[0]?.count ?? 0, ms: Math.round(performance.now() - inputT0) });
      })
      .catch((err) => {
        if (err?.name === 'AbortError' || controller.signal.aborted) return;
        setInputInfo({ error: { message: err?.message || String(err), status: err?.status }, ms: Math.round(performance.now() - inputT0) });
      });

    return () => controller.abort();
  }, [collection, activeKey]);

  if (list.length === 0) return null;

  function inspectStage(prefix, displayNo, stageKey) {
    openModal(`Stage ${displayNo}: ${stageKey}`, () => <StageInspector collection={collection} prefix={prefix} stageIndex={displayNo - 1} stageKey={stageKey} />);
  }
  function inspectInput() {
    openModal('Input: all records', () => <StageInspector collection={collection} prefix={[]} stageIndex={-1} stageKey="input" isInput />);
  }

  const timingTitle = 'End-to-end latency for the prefix up to this stage (network + server + contention with parallel debug requests). Cumulative — not per-stage MongoDB executor time. Data Storage does not expose explain output.';
  const inputTimingTitle = 'End-to-end latency of the $collStats document count for the whole collection (network + server). This is a metadata count, so it is typically near-instant — not a measure of how long a full scan would take.';
  const inputCell = countCell(inputInfo);

  let activeIdx = -1;
  let displayNo = 0;

  return (
    <div class="pipeline-debug">
      <div class="placeholder-label">Aggregate Pipeline Debug</div>
      <div class="pipeline-debug-stage-wrap">
        <div class="pipeline-debug-row pipeline-debug-input-row" onClick={inspectInput} title="All documents in the collection — the input to stage 1. Click to preview the first few raw documents.">
          <span class="pipeline-debug-num">0.</span>
          <span class="pipeline-debug-stage">input</span>
          <span class="pipeline-debug-preview">all records (pipeline input)</span>
          <span class="pipeline-debug-arrow">{'→'}</span>
          <span class={inputCell.cls}>{inputCell.text}</span>
          {inputInfo?.ms != null && (<span class="pipeline-debug-time" title={inputTimingTitle}>{inputInfo.ms}ms</span>)}
        </div>
        {inputInfo?.error && (
          <div class="pipeline-debug-error-detail" onClick={(e) => e.stopPropagation()}>
            <div class="pipeline-debug-error-msg">{inputInfo.error.message}</div>
            <div class="pipeline-debug-error-hint">Couldn{'’'}t read the collection{'’'}s documents.</div>
          </div>
        )}
      </div>
      {list.map((entry, entryIndex) => {
        const stage = entry.stage || {};
        const stageKey = Object.keys(stage)[0] || '?';
        const stageStr = JSON.stringify(stage);
        const preview = stageStr.length > 50 ? stageStr.slice(0, 50) + '…' : stageStr;
        const toggle = (
          <span
            class={'pipeline-stage-toggle' + (entry.disabled ? ' pipeline-stage-toggle-off' : '')}
            title={entry.disabled ? 'Enable stage' : 'Disable stage'}
            onClick={(e) => { e.stopPropagation(); onToggleStage && onToggleStage(entryIndex); }}
          >{entry.disabled ? '⊘' : '◉'}</span>
        );

        if (entry.disabled) {
          return (
            <div class="pipeline-debug-stage-wrap">
              <div class="pipeline-debug-row pipeline-debug-disabled">
                {toggle}
                <span class="pipeline-debug-num">{'–'}</span>
                <span class="pipeline-debug-stage">{stageKey}</span>
                <span class="pipeline-debug-preview">{preview}</span>
                <span class="pipeline-debug-disabled-badge">disabled</span>
              </div>
            </div>
          );
        }

        activeIdx += 1;
        displayNo += 1;
        const myActiveIdx = activeIdx;
        const myDisplayNo = displayNo;
        const info = stageCounts[myActiveIdx];
        const { text: countText, cls: countCls } = countCell(info);
        const prefix = activeStages.slice(0, myActiveIdx + 1);

        return (
          <div class="pipeline-debug-stage-wrap">
            <StageTooltip stage={stage}>
              <div class="pipeline-debug-row" onClick={() => inspectStage(prefix, myDisplayNo, stageKey)}>
                {toggle}
                <span class="pipeline-debug-num">{myDisplayNo}.</span>
                <span class="pipeline-debug-stage">{stageKey}</span>
                <span class="pipeline-debug-preview">{preview}</span>
                <span class="pipeline-debug-arrow">{'→'}</span>
                <span class={countCls}>{countText}</span>
                {info?.ms != null && (<span class="pipeline-debug-time" title={timingTitle}>{info.ms}ms</span>)}
              </div>
            </StageTooltip>
            {info?.error && (
              <div class="pipeline-debug-error-detail" onClick={(e) => e.stopPropagation()}>
                <div class="pipeline-debug-error-msg">{info.error.message}</div>
                <div class="pipeline-debug-error-hint">Edit this stage in the pipeline editor above. Errors only show here when a stage fails — they are not the same as a stage that legitimately matches zero documents.</div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/mdh-pipeline-debug.test.js`
Expected: PASS (existing tests via the wrapped `mount`, plus the two new disabled-stage tests).

- [ ] **Step 5: Checkpoint**

Run: `npx vitest run tests/mdh-pipeline-debug.test.js tests/mdh-pipeline-comments.test.js`
Expected: PASS. Do not commit.

---

## Task 4: `pipelineGutter.js` + `JsonEditor.jsx` — editor gutter toggle

**Files:**
- Create: `src/mdh/pipelineGutter.js`
- Modify: `src/mdh/components/JsonEditor.jsx`
- Test: `tests/mdh-pipeline-gutter.test.js`

- [ ] **Step 1: Write the failing test (smoke test of the live gutter)**

```js
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { h, render } from 'preact';
import JsonEditor from '../src/mdh/components/JsonEditor.jsx';

function mount() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return root;
}

describe('JsonEditor aggregate gutter', () => {
  it('renders a stage-toggle marker per top-level stage and fires onToggleStage on click', async () => {
    const root = mount();
    const calls = [];
    const value = '[\n  { "$match": {} },\n  { "$limit": 50 }\n]';
    render(h(JsonEditor, { mode: 'aggregate', value, onToggleStage: (i) => calls.push(i) }), root);

    await vi.waitFor(() => expect(root.querySelectorAll('.pipeline-stage-toggle').length).toBe(2));
    root.querySelectorAll('.pipeline-stage-toggle')[1].dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true }),
    );
    expect(calls).toEqual([1]);
  });

  it('does not add stage toggles outside aggregate mode', async () => {
    const root = mount();
    render(h(JsonEditor, { mode: 'query', value: '[ { "$match": {} } ]', onToggleStage: () => {} }), root);
    // Give the mount effect a beat; no aggregate gutter should appear.
    await vi.waitFor(() => expect(root.querySelector('.cm-editor')).not.toBeNull());
    expect(root.querySelectorAll('.pipeline-stage-toggle').length).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/mdh-pipeline-gutter.test.js`
Expected: FAIL — no `.pipeline-stage-toggle` elements (gutter not wired yet).

- [ ] **Step 3: Create `src/mdh/pipelineGutter.js`**

```js
// src/mdh/pipelineGutter.js
import { gutter, GutterMarker, EditorView, Decoration } from '@codemirror/view';
import { StateField, RangeSetBuilder } from '@codemirror/state';
import { stageLineRanges } from './pipelineComments.js';

// Recomputed stage line ranges, shared by the gutter and the greying decoration.
const stageRangesField = StateField.define({
  create(state) { return stageLineRanges(state.doc.toString()); },
  update(value, tr) { return tr.docChanged ? stageLineRanges(tr.newDoc.toString()) : value; },
});

class ToggleMarker extends GutterMarker {
  constructor(disabled) { super(); this.disabled = disabled; }
  eq(other) { return other.disabled === this.disabled; }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'pipeline-stage-toggle' + (this.disabled ? ' pipeline-stage-toggle-off' : '');
    span.textContent = this.disabled ? '⊘' : '◉'; // ⊘ / ◉
    span.title = this.disabled ? 'Enable stage' : 'Disable stage';
    return span;
  }
}

function rangeForLine(view, lineFrom) {
  const ranges = view.state.field(stageRangesField, false) || [];
  const lineNo = view.state.doc.lineAt(lineFrom).number;
  return ranges.find((r) => r.lineStart === lineNo) || null;
}

const disabledLineDeco = Decoration.line({ class: 'pipeline-stage-disabled-line' });

const disabledDecoField = StateField.define({
  create(state) { return buildDeco(state); },
  update(value, tr) { return tr.docChanged ? buildDeco(tr.state) : value; },
  provide: (f) => EditorView.decorations.from(f),
});

function buildDeco(state) {
  const ranges = stageLineRanges(state.doc.toString());
  const builder = new RangeSetBuilder();
  for (const r of ranges) {
    if (!r.disabled) continue;
    for (let ln = r.lineStart; ln <= r.lineEnd && ln <= state.doc.lines; ln++) {
      const line = state.doc.line(ln);
      builder.add(line.from, line.from, disabledLineDeco);
    }
  }
  return builder.finish();
}

// CodeMirror extension array: a clickable per-stage toggle gutter + greying of
// disabled-stage lines. `onToggle(entryIndex)` fires on marker click.
export function stageToggleGutter(onToggle) {
  return [
    stageRangesField,
    disabledDecoField,
    gutter({
      class: 'cm-stage-gutter',
      lineMarker(view, line) {
        const r = rangeForLine(view, line.from);
        return r ? new ToggleMarker(r.disabled) : null;
      },
      lineMarkerChange: (update) => update.docChanged,
      domEventHandlers: {
        mousedown(view, line) {
          const r = rangeForLine(view, line.from);
          if (r) { onToggle(r.entryIndex); return true; }
          return false;
        },
      },
    }),
  ];
}
```

- [ ] **Step 4: Wire it into `JsonEditor.jsx`**

Add the import near the other CodeMirror imports:

```js
import { stageToggleGutter } from '../pipelineGutter.js';
```

Add `onToggleStage` to the props destructure and a ref for it (mirroring `onChangeRef`):

```js
export default function JsonEditor({ value = '', onChange, onValidChange, onToggleStage, mode = 'default', fields, compact = false, readOnly = false, onSubmit, editorRef, minHeight = '200px' }) {
  const containerRef = useRef(null);
  const viewRef = useRef(null);
  const onChangeRef = useRef(onChange);
  const onValidChangeRef = useRef(onValidChange);
  const onSubmitRef = useRef(onSubmit);
  const onToggleStageRef = useRef(onToggleStage);
  onChangeRef.current = onChange;
  onValidChangeRef.current = onValidChange;
  onSubmitRef.current = onSubmit;
  onToggleStageRef.current = onToggleStage;
```

In the `extensions` array, after `autocompletion(...)`, add the gutter for aggregate mode:

```js
      autocompletion({ override: [mongoCompletions(completionSets, fieldsFn)] }),
      ...(mode === 'aggregate'
        ? [stageToggleGutter((idx) => { if (onToggleStageRef.current) onToggleStageRef.current(idx); })]
        : []),
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/mdh-pipeline-gutter.test.js`
Expected: PASS. If jsdom flakes on CodeMirror measure cycles, re-run; `tests/setup.js` already
polyfills `getClientRects`. (If the live marker proves unrenderable under jsdom, fall back to
asserting `stageToggleGutter` builds a non-empty extension array and rely on `stageLineRanges`
unit tests for the mapping — but try the live test first.)

- [ ] **Step 6: Checkpoint**

Run: `npx vitest run tests/mdh-pipeline-gutter.test.js tests/mdh-json-editor.test.js`
Expected: PASS (existing JsonEditor tests unaffected — they use `readOnly`/default mode). Do not commit.

---

## Task 5: `QueryHistory.jsx` — disable-aware dedup

**Files:**
- Modify: `src/mdh/components/QueryHistory.jsx`
- Test: `tests/mdh-query-history.test.js` (append)

- [ ] **Step 1: Write the failing test (append)**

```js
// append to tests/mdh-query-history.test.js
describe('QueryHistory dedup is disable-aware', () => {
  it('treats a pipeline and its disabled-stage variant as distinct saved queries', async () => {
    const data = stubStorage();
    orgId.value = 1; domain.value = 'https://x.rossum.app';

    const full = '[\n  { "$match": {} },\n  { "$sort": { "a": -1 } }\n]';
    const variant = '[\n  { "$match": {} },\n  /* @disabled-stage\n  { "$sort": { "a": -1 } } */\n]';

    await saveQuery('vendors', full, 'full', {});
    await saveQuery('vendors', variant, 'variant', {});

    expect(data['savedQueries::org:1']).toHaveLength(2);
    expect(await isSaved('vendors', full)).toBe(true);
    expect(await isSaved('vendors', variant)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/mdh-query-history.test.js`
Expected: FAIL — only 1 saved query (the two collide because `JSON5.parse` drops the comment).

- [ ] **Step 3: Make `dedupKey` disable-aware**

In `src/mdh/components/QueryHistory.jsx`, add the import:

```js
import { parseEntries } from '../pipelineComments.js';
```

Replace `dedupKey`:

```js
function dedupKey(collection, pipeline) {
  let normalized = pipeline;
  try {
    const { entries, ok } = parseEntries(pipeline);
    if (ok) normalized = JSON.stringify(entries.map((e) => ({ d: e.disabled ? 1 : 0, s: e.stage })));
    else normalized = JSON.stringify(JSON5.parse(pipeline));
  } catch { /* keep raw */ }
  return collection + '::' + normalized;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/mdh-query-history.test.js`
Expected: PASS (new test + the existing scoping tests, which don't assert key format).

- [ ] **Step 5: Checkpoint**

Run: `npx vitest run tests/mdh-query-history.test.js`
Expected: PASS. Do not commit.

---

## Task 6: `PipelineEditor.jsx` — thread toggle + entries-aware Beautify

**Files:**
- Modify: `src/mdh/components/PipelineEditor.jsx`
- Test: `tests/mdh-pipeline-editor.test.js` (new — covers the Beautify behavior)

- [ ] **Step 1: Write the failing test**

```js
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { h, render } from 'preact';
import JSON5 from 'json5';

globalThis.chrome = {
  storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() } },
};
vi.mock('../src/mdh/components/JsonEditor.jsx', () => ({
  default: () => h('div', { 'data-testid': 'editor' }),
  extractFieldNames: () => [],
}));

import PipelineEditor from '../src/mdh/components/PipelineEditor.jsx';
import { selectedCollection } from '../src/mdh/store.js';

describe('PipelineEditor Beautify', () => {
  it('preserves a disabled stage when beautifying', async () => {
    selectedCollection.value = 'vendors';
    const root = document.createElement('div');
    document.body.appendChild(root);

    const editorRef = { current: {
      _v: '[{"$match":{}},/* @disabled-stage {"$sort":{"a":-1}} */{"$limit":5}]',
      getValue() { return this._v; },
      setValue(v) { this._v = v; },
    } };

    render(h(PipelineEditor, {
      editorRef, initialValue: '', onChange: () => {}, onValidChange: () => {},
      onLoadPipeline: () => {}, onReset: () => {},
    }), root);

    // Open the overflow menu and click Beautify.
    root.querySelector('.pipeline-overflow-btn').click();
    await vi.waitFor(() => expect([...root.querySelectorAll('.toolbar-menu-item')].some((b) => b.textContent === 'Beautify')).toBe(true));
    [...root.querySelectorAll('.toolbar-menu-item')].find((b) => b.textContent === 'Beautify').click();

    const out = editorRef.current.getValue();
    expect(JSON5.parse(out)).toEqual([{ $match: {} }, { $limit: 5 }]);
    expect(out).toContain('/* @disabled-stage');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/mdh-pipeline-editor.test.js`
Expected: FAIL — current `beautify` strips the comment (`JSON5.parse`→`JSON.stringify`), so `out`
does not contain `/* @disabled-stage`.

- [ ] **Step 3: Update `PipelineEditor.jsx`**

Add the import:

```js
import { beautifyText } from '../pipelineComments.js';
```

Replace `beautify`:

```js
  function beautify() {
    if (!editorRef.current) return;
    const out = beautifyText(editorRef.current.getValue());
    if (out != null) editorRef.current.setValue(out);
  }
```

Add `onToggleStage` to the props destructure and pass it to `JsonEditor`:

```js
export default function PipelineEditor({ editorRef, initialValue, onChange, onValidChange, onLoadPipeline, onReset, onToggleStage }) {
```

In the `<JsonEditor … />` props (the aggregate editor near the bottom), add `onToggleStage={onToggleStage}`:

```jsx
        <JsonEditor
          value={initialValue}
          mode="aggregate"
          fields={fieldsFn}
          editorRef={editorRef}
          onChange={onChange}
          onToggleStage={onToggleStage}
          onValidChange={() => { onValidChange(); updateSaveBtn(); }}
        />
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/mdh-pipeline-editor.test.js`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run: `npx vitest run tests/mdh-pipeline-editor.test.js`
Expected: PASS. Do not commit.

---

## Task 7: `DataPanel.jsx` — wire everything together

**Files:**
- Modify: `src/mdh/components/DataPanel.jsx`
- Test: `tests/mdh-datapanel-disable.test.js` (new)

- [ ] **Step 1: Write the failing integration test (mock-editor harness from `mdh-datapanel-variables`)**

```js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';
import JSON5 from 'json5';

const mock = vi.hoisted(() => ({ text: '', onChange: null, onValidChange: null, onToggleStage: null }));

globalThis.chrome = {
  storage: { local: { get: (k, cb) => { if (cb) { cb({}); return; } return Promise.resolve({}); }, set: () => Promise.resolve(), remove: () => Promise.resolve() } },
  runtime: { onMessage: { addListener: () => {} } },
};

vi.mock('../src/mdh/api.js');

vi.mock('../src/mdh/components/PipelineEditor.jsx', () => ({
  default: ({ editorRef, onChange, onValidChange, onToggleStage }) => {
    mock.onChange = onChange; mock.onValidChange = onValidChange; mock.onToggleStage = onToggleStage;
    if (editorRef) {
      editorRef.current = {
        getValue: () => mock.text,
        setValue: (v) => { mock.text = v; },
        isValid: () => { try { JSON5.parse(mock.text); return true; } catch { return false; } },
        getParsed: () => JSON5.parse(mock.text),
        focus: () => {}, refresh: () => {},
      };
    }
    return h('div', { 'data-testid': 'editor' });
  },
}));
vi.mock('../src/mdh/components/RecordList.jsx', () => ({ default: () => h('div', { 'data-testid': 'recordlist' }) }));
vi.mock('../src/mdh/components/PipelineDebug.jsx', () => ({ default: () => h('div', { 'data-testid': 'debug' }) }));

import * as api from '../src/mdh/api.js';
import DataPanel from '../src/mdh/components/DataPanel.jsx';
import { selectedCollection, records } from '../src/mdh/store.js';

async function tick() { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); }

beforeEach(() => {
  vi.clearAllMocks();
  api.aggregate.mockResolvedValue({ result: [{ n: 0 }] });
  if (api.listCollections) api.listCollections.mockResolvedValue({ result: [] });
  selectedCollection.value = 'vendors';
  records.value = [];
  mock.text = '';
});

describe('DataPanel — disable-stage wiring', () => {
  it('toggling a stage from the gutter callback comments it out in the editor', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    render(h(DataPanel, null), root);
    await tick();

    mock.text = '[\n  { "$match": {} },\n  { "$sort": { "a": -1 } },\n  { "$limit": 50 }\n]';
    mock.onToggleStage(1); // disable the $sort
    await tick();

    expect(mock.text).toContain('/* @disabled-stage');
    expect(JSON5.parse(mock.text)).toEqual([{ $match: {} }, { $limit: 50 }]);
  });

  it('runs [{ $match: {} }] when every stage is disabled', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    render(h(DataPanel, null), root);
    await tick();
    api.aggregate.mockClear();

    mock.text = '[ /* @disabled-stage\n{ "$match": { "x": 1 } } */ ]';
    mock.onValidChange(); // simulate a valid edit -> runQuery
    await tick();

    // The query aggregation (the call whose pipeline is NOT a $count/$collStats probe)
    // must be [{ $match: {} }], never [].
    const queryCalls = api.aggregate.mock.calls.filter(([, pl]) =>
      Array.isArray(pl) && !pl.some((s) => s.$count) && !pl.some((s) => s.$collStats));
    expect(queryCalls.length).toBeGreaterThan(0);
    for (const [, pl] of queryCalls) {
      expect(pl).toEqual([{ $match: {} }]);
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/mdh-datapanel-disable.test.js`
Expected: FAIL — `mock.onToggleStage is not a function` (DataPanel doesn't pass it yet); the
all-disabled case sends `[]` not `[{ $match: {} }]`.

- [ ] **Step 3: Edit `DataPanel.jsx`**

Add the import (next to the `pipelineOps` import):

```js
import { applyMutationToText, normalizeEffectivePipelineText, setStageDisabled, parseEntries } from '../pipelineComments.js';
```

Replace `mutatePipelineText`:

```js
  function mutatePipelineText(mutator) {
    if (!editorRef.current) return;
    const next = applyMutationToText(editorRef.current.getValue(), mutator);
    if (next == null) return;
    pipeline.suppressSync.value = true;
    editorRef.current.setValue(next);
    setTimeout(() => { pipeline.suppressSync.value = false; }, 600);
  }
```

Replace the `query.runQuery(...)` call inside `runQuery` so the substitution result is
empty-normalized:

```js
  async function runQuery() {
    if (!collection || !editorRef.current) return;
    const rawText = editorRef.current.getValue();
    await pipeline.ensureFieldTypes(collection, pipeline.referencedFields(rawText));
    const result = await query.runQuery(
      collection,
      rawText,
      (t) => normalizeEffectivePipelineText(pipeline.substituteWithTypes(t)),
    );
    if (result) {
      addToHistory(collection, rawText, { ...pipeline.placeholderValues.value }, { ...pipeline.placeholderTypes.value });
    }
  }
```

Add the toggle handler (near `handleSort`/`handleFilter`):

```js
  function handleToggleStage(entryIndex) {
    if (!editorRef.current) return;
    const text = editorRef.current.getValue();
    const { entries, ok } = parseEntries(text);
    if (!ok || entryIndex < 0 || entryIndex >= entries.length) return;
    const next = setStageDisabled(text, entryIndex, !entries[entryIndex].disabled);
    if (next === text) return;
    if (selectionMode.value) selectionPipelineDirty.value = true;
    pipeline.suppressSync.value = true;
    editorRef.current.setValue(next);
    setTimeout(() => { pipeline.suppressSync.value = false; runQuery(); }, 100);
  }
```

Compute debug entries (substituted) and pass them + the handler to the children. Replace the
`<PipelineEditor … />` and `<PipelineDebug … />` usages in the returned JSX:

```jsx
        <PipelineEditor
          editorRef={editorRef}
          initialValue={buildInitialPipeline()}
          onChange={handleEditorChange}
          onValidChange={handleValidChange}
          onLoadPipeline={handleLoadPipeline}
          onReset={handleReset}
          onToggleStage={handleToggleStage}
        />
        <PlaceholderInputs
          names={placeholderNames}
          values={pipeline.placeholderValues.value}
          types={pipeline.placeholderTypes.value}
          onSetValue={handleSetPlaceholder}
          onSetType={handleSetPlaceholderType}
          onRunQuery={runQuery}
          resolvedTypeFor={(name) => pipeline.resolvedTypeForName(name, editorState.fieldMap || {}, editorState.parsed != null)}
        />
        <PipelineDebug
          entries={parseEntries(pipeline.substituteWithTypes(editorState.text)).entries}
          onToggleStage={handleToggleStage}
        />
```

Add the `PipelineDebug` import of `parseEntries` is already covered by the combined import above.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/mdh-datapanel-disable.test.js`
Expected: PASS.

- [ ] **Step 5: Run the related DataPanel suites to confirm no regression**

Run: `npx vitest run tests/mdh-datapanel-variables.test.js tests/mdh-flow.test.js tests/mdh-datapanel-disable.test.js`
Expected: PASS.

- [ ] **Step 6: Checkpoint**

Run: `npx vitest run tests/mdh-datapanel-disable.test.js`
Expected: PASS. Do not commit.

---

## Task 8: `console.css` — styles

**Files:**
- Modify: `src/console/console.css`

- [ ] **Step 1: Append styles**

Append to `src/console/console.css` (the build copies it to `dist/console/console.css`). Uses
existing custom properties `--accent`, `--text-secondary`, `--border` (all verified present):

```css
/* Disable-stage feature: Debug-list toggles, disabled rows, editor gutter */
.pipeline-stage-toggle {
  cursor: pointer;
  user-select: none;
  color: var(--accent);
  margin-right: 6px;
  font-size: 12px;
  line-height: 1;
}
.pipeline-stage-toggle:hover { opacity: 0.75; }
.pipeline-stage-toggle-off { color: var(--text-secondary); }

.pipeline-debug-disabled { opacity: 0.55; }
.pipeline-debug-disabled .pipeline-debug-stage,
.pipeline-debug-disabled .pipeline-debug-preview {
  text-decoration: line-through;
}
.pipeline-debug-disabled-badge {
  margin-left: auto;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
}

.cm-stage-gutter {
  min-width: 16px;
  text-align: center;
}
.cm-stage-gutter .pipeline-stage-toggle { margin-right: 0; }
.pipeline-stage-disabled-line { opacity: 0.55; font-style: italic; }
```

- [ ] **Step 2: Verify the build still produces the CSS**

Run: `npm run build`
Expected: build completes; `dist/console/console.css` contains `.pipeline-stage-toggle`.
Verify: `grep -c "pipeline-stage-toggle" dist/console/console.css` → `>= 1`.

- [ ] **Step 3: Checkpoint**

Run: `npm run build`
Expected: clean build. Do not commit.

---

## Task 9: Full verification

- [ ] **Step 1: Run the whole test suite**

Run: `npm test`
Expected: all tests green. If any pre-existing test flakes (CodeMirror measure cycle), re-run once;
if it persists, fix with a condition-based `waitFor` (never a larger fixed sleep), per the project's
flaky-timeout guidance.

- [ ] **Step 2: Production build**

Run: `npm run build`
Expected: clean build into `dist/`.

- [ ] **Step 3: Confirm no CSP-violating codegen crept in (sanity)**

Run: `grep -c "new Function" dist/console/console.js || true`
Expected: `0` (the gutter uses no dynamic codegen; this just guards the Console page's CSP).

- [ ] **Step 4: Manual smoke (optional, recommended)**

Load `dist/` as an unpacked extension, open the Console → Dataset Management, pick a collection,
and in the Aggregate Pipeline editor: click a gutter marker to disable a stage (it becomes a
`/* @disabled-stage … */` block, greys out, query re-runs without it); toggle it from the Pipeline
Debug list; sort a column and confirm the disabled stage survives; reload the tab and confirm it
persists; disable every stage and confirm records still load (all-records fallback).

---

## Self-review (completed against the spec)

- **§1 representation / §4 format** → Tasks 1–2 (`serializeEntries` emits `/* @disabled-stage … */`).
- **§4.1 module API** → Tasks 1–2 (`parseEntries`, `serializeEntries`, `setStageDisabled`,
  `hasDisabledStages`, `stagesToEntries`, `applyMutationToText`, `normalizeEffectivePipelineText`,
  `beautifyText`, `stageLineRanges`).
- **§4.2 comment-preserving rebuild** → Task 2 (`applyMutationToText` inert-placeholder technique)
  + Task 7 (`mutatePipelineText`). Reuses `pipelineOps` unchanged.
- **§4.3 all-disabled → `[{ $match: {} }]`** → Task 2 (`normalizeEffectivePipelineText`) + Task 7.
- **§4.4 Debug list toggle** → Task 3.
- **§4.5 editor gutter** → Task 4.
- **§4.6 persistence (free) + disable-aware dedup** → Task 5 (dedup); persistence needs no code.
- **§6 Beautify entries-aware** → Task 6.
- **§6 invalid disabled block (forgiving)** → Task 1 (`parseEntries` keeps `stage:null` + `raw`).
- **Backward compat (no disabled → fast path byte-identical)** → Task 2 test asserts byte identity.
- **Styling** → Task 8.

No placeholders remain; type/signature names are consistent across tasks
(`{ disabled, stage, raw }` entries, `entryIndex`, `onToggleStage`, the eight module exports).
