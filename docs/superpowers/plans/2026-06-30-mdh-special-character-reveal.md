# MDH Special-Character Reveal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reveal invisible / non-standard-whitespace / control characters inline in MDH record-value displays, so a solution architect can see characters the browser otherwise hides.

**Architecture:** A pure, DOM-free `specialChars.js` classifies/tokenizes a string into normal-text runs and special-character tokens. A thin `<SpecialText>` Preact component renders tokens as compact, color-coded marker spans with a `U+XXXX NAME` tooltip; clean strings render byte-identical to today. Three render sites (JsonTree string primitive, JsonTree string array items, RecordTable simple string cell) swap to `<SpecialText>`. `displayValue.js`, `recordSummary.js`, copy, downloads, and the editors are untouched.

**Tech Stack:** Preact + JSX (`h`/`Fragment`, esbuild iife), Vitest (`vitest run`, jsdom for component tests), plain ES modules, `console.css` custom properties.

**Reference spec:** `docs/superpowers/specs/2026-06-30-mdh-special-character-reveal-design.md`

## Global Constraints

- **No git commits during this run.** Per the project workflow, work stays on `master` and the developer commits manually afterward. Each task therefore ends with a **verification** step (run the task's tests + full suite), **not** a commit. Do not create branches or worktrees.
- **Never leak customer names/data.** Use only synthetic values (`'Alice'`, `'a\u00a0b'`, etc.) in tests and examples.
- **Backward compatibility is mandatory.** A value with no special characters must render exactly as it does today. `displayValue.js`'s string contract must not change. The copy button must keep copying raw original bytes.
- **Character set:** reveal special characters but **never** the ordinary ASCII space `U+0020`.
- **Test convention:** tests are `.test.js`; component tests use `h(Component, props)` (no raw JSX in `.test.js`) and `// @vitest-environment jsdom`. Pure-module tests import from `../src/mdh/...`.
- **JSX unicode rule:** never put `\uXXXX` in JSX raw text/attributes; use a JS expression (`{'→'}`) or the literal glyph. (Relevant to the component's marker glyphs.)
- Test command: `npm test` (= `vitest run`). Single file: `npx vitest run tests/<file>`. Build check: `npm run build`.

---

### Task 1: `specialChars.js` — pure classifier + tokenizer

**Files:**
- Create: `src/mdh/specialChars.js`
- Test: `tests/mdh-special-chars.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `classifySpecial(codePoint: number) -> null | { category: 'space'|'zero-width'|'control'|'bidi', name: string, glyph: string }`
  - `cpLabel(codePoint: number) -> string` (e.g. `'U+00A0'`, `'U+0009'`)
  - `hasSpecial(str: any) -> boolean` (false for non-strings)
  - `tokenizeSpecial(str: string, opts?: { limit?: number }) -> { tokens: Array<{type:'text', value:string} | {type:'special', cp:number, char:string, category:string, name:string, glyph:string}>, truncated: boolean }`

- [ ] **Step 1: Write the failing test**

Create `tests/mdh-special-chars.test.js`:

```js
import { describe, it, expect } from 'vitest';
import {
  classifySpecial,
  cpLabel,
  hasSpecial,
  tokenizeSpecial,
} from '../src/mdh/specialChars.js';

describe('classifySpecial', () => {
  it('classifies a representative member of each category', () => {
    expect(classifySpecial(0x00a0)).toEqual({ category: 'space', name: 'NO-BREAK SPACE', glyph: '·' });
    expect(classifySpecial(0x200b)).toEqual({ category: 'zero-width', name: 'ZERO WIDTH SPACE', glyph: '▏' });
    expect(classifySpecial(0x0009)).toEqual({ category: 'control', name: 'TAB', glyph: '→' });
    expect(classifySpecial(0x200e)).toEqual({ category: 'bidi', name: 'LEFT-TO-RIGHT MARK', glyph: '⇄' });
  });

  it('does NOT classify ordinary space, letters, digits, or astral emoji', () => {
    expect(classifySpecial(0x20)).toBeNull();          // ordinary space
    expect(classifySpecial('A'.codePointAt(0))).toBeNull();
    expect(classifySpecial('7'.codePointAt(0))).toBeNull();
    expect(classifySpecial('\u{1F600}'.codePointAt(0))).toBeNull(); // U+1F600
  });

  it('gives a generic name/glyph to un-named control chars', () => {
    const info = classifySpecial(0x0007); // BEL
    expect(info.category).toBe('control');
    expect(info.name).toBe('CONTROL U+0007');
    expect(info.glyph).toBe('▢');
  });
});

describe('cpLabel', () => {
  it('formats uppercase hex, min 4 digits', () => {
    expect(cpLabel(0x00a0)).toBe('U+00A0');
    expect(cpLabel(0x0009)).toBe('U+0009');
    expect(cpLabel(0x1f600)).toBe('U+1F600');
  });
});

describe('hasSpecial', () => {
  it('detects presence and absence', () => {
    expect(hasSpecial('Acme\u00a0Corp')).toBe(true);
    expect(hasSpecial('Acme Corp')).toBe(false); // ordinary spaces only
    expect(hasSpecial('')).toBe(false);
  });
  it('returns false for non-strings', () => {
    expect(hasSpecial(42)).toBe(false);
    expect(hasSpecial(null)).toBe(false);
    expect(hasSpecial({})).toBe(false);
  });
});

describe('tokenizeSpecial', () => {
  it('coalesces normal runs and emits one special token', () => {
    const { tokens, truncated } = tokenizeSpecial('ab\u00a0cd');
    expect(truncated).toBe(false);
    expect(tokens).toEqual([
      { type: 'text', value: 'ab' },
      { type: 'special', cp: 0x00a0, char: '\u00a0', category: 'space', name: 'NO-BREAK SPACE', glyph: '·' },
      { type: 'text', value: 'cd' },
    ]);
  });

  it('handles a value that is all special characters', () => {
    const { tokens } = tokenizeSpecial('\u00a0\u200b');
    expect(tokens.map((t) => t.type)).toEqual(['special', 'special']);
    expect(tokens.map((t) => t.category)).toEqual(['space', 'zero-width']);
  });

  it('truncates by source-character count and sets truncated', () => {
    const long = 'x'.repeat(25);
    const { tokens, truncated } = tokenizeSpecial(long, { limit: 20 });
    expect(truncated).toBe(true);
    expect(tokens).toEqual([{ type: 'text', value: 'x'.repeat(20) }]);
  });

  it('does not truncate when length equals the limit', () => {
    const { truncated } = tokenizeSpecial('y'.repeat(20), { limit: 20 });
    expect(truncated).toBe(false);
  });

  it('iterates by code point so astral characters are not split', () => {
    const { tokens } = tokenizeSpecial('a\u{1F600}b');
    expect(tokens).toEqual([{ type: 'text', value: 'a\u{1F600}b' }]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mdh-special-chars.test.js`
Expected: FAIL — cannot resolve `../src/mdh/specialChars.js` (module does not exist).

- [ ] **Step 3: Write the implementation**

Create `src/mdh/specialChars.js`:

```js
// src/mdh/specialChars.js
// Pure, DOM-free classification of "special" characters in record values:
// invisible characters, non-standard whitespace, and control characters —
// everything EXCEPT the ordinary ASCII space (U+0020). Consumed by
// components/SpecialText.jsx to reveal characters the browser would otherwise
// hide. Kept as a plain .js module (like displayValue.js) so it can be
// unit-tested without a JSX loader.

const SPACE_CPS = new Set([
  0x00a0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a,
  0x202f, 0x205f, 0x3000,
]);

const ZERO_WIDTH_CPS = new Set([
  0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad, 0x180e,
]);

const BIDI_CPS = new Set([
  0x200e, 0x200f,
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
  0x2066, 0x2067, 0x2068, 0x2069,
]);

const NAMES = {
  0x00a0: 'NO-BREAK SPACE', 0x1680: 'OGHAM SPACE MARK',
  0x2000: 'EN QUAD', 0x2001: 'EM QUAD', 0x2002: 'EN SPACE', 0x2003: 'EM SPACE',
  0x2004: 'THREE-PER-EM SPACE', 0x2005: 'FOUR-PER-EM SPACE',
  0x2006: 'SIX-PER-EM SPACE', 0x2007: 'FIGURE SPACE',
  0x2008: 'PUNCTUATION SPACE', 0x2009: 'THIN SPACE', 0x200a: 'HAIR SPACE',
  0x202f: 'NARROW NO-BREAK SPACE', 0x205f: 'MEDIUM MATHEMATICAL SPACE',
  0x3000: 'IDEOGRAPHIC SPACE',
  0x200b: 'ZERO WIDTH SPACE', 0x200c: 'ZERO WIDTH NON-JOINER',
  0x200d: 'ZERO WIDTH JOINER', 0x2060: 'WORD JOINER',
  0xfeff: 'ZERO WIDTH NO-BREAK SPACE', 0x00ad: 'SOFT HYPHEN',
  0x180e: 'MONGOLIAN VOWEL SEPARATOR',
  0x0009: 'TAB', 0x000a: 'LINE FEED', 0x000b: 'LINE TABULATION',
  0x000c: 'FORM FEED', 0x000d: 'CARRIAGE RETURN', 0x0085: 'NEXT LINE',
  0x007f: 'DELETE', 0x2028: 'LINE SEPARATOR', 0x2029: 'PARAGRAPH SEPARATOR',
  0x200e: 'LEFT-TO-RIGHT MARK', 0x200f: 'RIGHT-TO-LEFT MARK',
  0x202a: 'LEFT-TO-RIGHT EMBEDDING', 0x202b: 'RIGHT-TO-LEFT EMBEDDING',
  0x202c: 'POP DIRECTIONAL FORMATTING', 0x202d: 'LEFT-TO-RIGHT OVERRIDE',
  0x202e: 'RIGHT-TO-LEFT OVERRIDE',
  0x2066: 'LEFT-TO-RIGHT ISOLATE', 0x2067: 'RIGHT-TO-LEFT ISOLATE',
  0x2068: 'FIRST STRONG ISOLATE', 0x2069: 'POP DIRECTIONAL ISOLATE',
};

const CONTROL_GLYPHS = { 0x0009: '→', 0x000a: '↵', 0x000d: '␍' };

export function cpLabel(cp) {
  return 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
}

function isControl(cp) {
  return cp <= 0x1f || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)
    || cp === 0x2028 || cp === 0x2029;
}

export function classifySpecial(cp) {
  if (cp === 0x20) return null; // ordinary space is never special
  if (SPACE_CPS.has(cp)) return { category: 'space', name: NAMES[cp] || 'SPACE', glyph: '·' };
  if (ZERO_WIDTH_CPS.has(cp)) return { category: 'zero-width', name: NAMES[cp] || 'ZERO WIDTH', glyph: '▏' };
  if (BIDI_CPS.has(cp)) return { category: 'bidi', name: NAMES[cp] || 'BIDI CONTROL', glyph: '⇄' };
  if (isControl(cp)) return { category: 'control', name: NAMES[cp] || ('CONTROL ' + cpLabel(cp)), glyph: CONTROL_GLYPHS[cp] || '▢' };
  return null;
}

export function hasSpecial(str) {
  if (typeof str !== 'string') return false;
  for (const ch of str) {
    if (classifySpecial(ch.codePointAt(0))) return true;
  }
  return false;
}

export function tokenizeSpecial(str, { limit } = {}) {
  const tokens = [];
  let buf = '';
  let count = 0;
  let truncated = false;
  const flush = () => { if (buf) { tokens.push({ type: 'text', value: buf }); buf = ''; } };
  for (const ch of str) {
    if (limit != null && count >= limit) { truncated = true; break; }
    const cp = ch.codePointAt(0);
    const info = classifySpecial(cp);
    if (info) {
      flush();
      tokens.push({ type: 'special', cp, char: ch, category: info.category, name: info.name, glyph: info.glyph });
    } else {
      buf += ch;
    }
    count += 1;
  }
  flush();
  return { tokens, truncated };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/mdh-special-chars.test.js`
Expected: PASS (all `describe` blocks green).

- [ ] **Step 5: Verify (no commit)**

Run: `npm test`
Expected: full suite green (no regressions). Do **not** commit.

---

### Task 2: `SpecialText.jsx` — token renderer

**Files:**
- Create: `src/mdh/components/SpecialText.jsx`
- Test: `tests/mdh-special-text.test.js`

**Interfaces:**
- Consumes: `hasSpecial`, `tokenizeSpecial`, `cpLabel` from `../specialChars.js` (Task 1).
- Produces: default export `SpecialText({ value, quote=false, limit })`. Renders:
  - non-string `value` → returns `value` unchanged.
  - clean string → plain text, optionally quote-wrapped and/or `...`-truncated, byte-identical to `displayValue`'s string output.
  - string with specials → text runs as plain children + `<span class="mdh-special mdh-special-<category>" title="U+XXXX NAME">glyph</span>` per special char; `...` appended when truncated.

- [ ] **Step 1: Write the failing test**

Create `tests/mdh-special-text.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { h, render } from 'preact';
import SpecialText from '../src/mdh/components/SpecialText.jsx';

function mount(props) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(SpecialText, props), root);
  return root;
}

afterEach(() => { document.body.innerHTML = ''; });

describe('SpecialText', () => {
  it('renders a clean string as plain text with no marker spans', () => {
    const root = mount({ value: 'Acme Corp' }); // ordinary spaces only
    expect(root.querySelectorAll('.mdh-special').length).toBe(0);
    expect(root.textContent).toBe('Acme Corp');
  });

  it('wraps in quotes when quote is set', () => {
    const root = mount({ value: 'Acme Corp', quote: true });
    expect(root.textContent).toBe('"Acme Corp"');
  });

  it('truncates a long clean string exactly like displayValue', () => {
    const root = mount({ value: 'x'.repeat(25), quote: true, limit: 20 });
    expect(root.textContent).toBe('"' + 'x'.repeat(20) + '..."');
    expect(root.querySelectorAll('.mdh-special').length).toBe(0);
  });

  it('renders a special character as a category-classed span with a U+ tooltip', () => {
    const root = mount({ value: 'a\u00a0b' });
    const span = root.querySelector('.mdh-special');
    expect(span).not.toBeNull();
    expect(span.classList.contains('mdh-special-space')).toBe(true);
    expect(span.getAttribute('title')).toBe('U+00A0 NO-BREAK SPACE');
    expect(span.textContent).toBe('·');
    // surrounding text preserved
    expect(root.textContent).toBe('a·b');
  });

  it('classifies multiple categories in one value', () => {
    const root = mount({ value: 'a\u00a0b\u200bc\td' });
    expect(root.querySelector('.mdh-special-space')).not.toBeNull();
    expect(root.querySelector('.mdh-special-zero-width')).not.toBeNull();
    expect(root.querySelector('.mdh-special-control')).not.toBeNull();
  });

  it('appends ... when a special-containing value is truncated', () => {
    const root = mount({ value: 'a\u00a0' + 'b'.repeat(30), quote: true, limit: 20 });
    expect(root.textContent.endsWith('..."')).toBe(true);
  });

  it('returns non-string values unchanged', () => {
    const root = mount({ value: 42 });
    expect(root.textContent).toBe('42');
    expect(root.querySelectorAll('.mdh-special').length).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mdh-special-text.test.js`
Expected: FAIL — cannot resolve `../src/mdh/components/SpecialText.jsx`.

- [ ] **Step 3: Write the implementation**

Create `src/mdh/components/SpecialText.jsx`:

```jsx
import { h, Fragment } from 'preact';
import { hasSpecial, tokenizeSpecial, cpLabel } from '../specialChars.js';

// Renders a record-value string, revealing special / invisible characters as
// compact color-coded markers (see specialChars.js). A clean string renders
// byte-identical to plain text. `quote` wraps the value in literal double
// quotes; `limit` truncates by source-character count, appending "..." — both
// matching displayValue's existing table behavior.
export default function SpecialText({ value, quote = false, limit }) {
  if (typeof value !== 'string') return value;
  const q = quote ? '"' : '';

  if (!hasSpecial(value)) {
    const s = (limit != null && value.length > limit) ? value.slice(0, limit) + '...' : value;
    return <Fragment>{q}{s}{q}</Fragment>;
  }

  const { tokens, truncated } = tokenizeSpecial(value, limit != null ? { limit } : {});
  return (
    <Fragment>
      {q}
      {tokens.map((t, i) => (
        t.type === 'text'
          ? t.value
          : <span key={i} class={'mdh-special mdh-special-' + t.category} title={cpLabel(t.cp) + ' ' + t.name}>{t.glyph}</span>
      ))}
      {truncated ? '...' : ''}
      {q}
    </Fragment>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/mdh-special-text.test.js`
Expected: PASS.

- [ ] **Step 5: Verify (no commit)**

Run: `npm test`
Expected: full suite green. Do **not** commit.

---

### Task 3: CSS markers in `console.css`

**Files:**
- Modify: `src/console/console.css` (add a `--mdh-special-bidi` custom property in `:root` and in the dark-mode block, plus the `.mdh-special*` rules)

**Interfaces:**
- Consumes: class names produced by Task 2 (`.mdh-special`, `.mdh-special-space`, `.mdh-special-zero-width`, `.mdh-special-control`, `.mdh-special-bidi`) and existing custom properties `--warning`, `--danger`, `--accent`.
- Produces: visual styling only (no JS contract).

- [ ] **Step 1: Add the bidi color custom property (light + dark)**

In `src/console/console.css`, inside the `:root { … }` block (near the existing `--warning`/`--danger` declarations, around line 17), add:

```css
  --mdh-special-bidi: #7c3aed;
```

Inside the dark-mode override block `@media (prefers-color-scheme: dark) { :root { … } }` (near line 62), add:

```css
    --mdh-special-bidi: #a78bfa;
```

- [ ] **Step 2: Add the marker rules**

Append to `src/console/console.css` (end of file is fine; grouped together):

```css
/* Special / invisible character markers in record values (specialChars.js). */
.mdh-special {
  display: inline-block;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  padding: 0 2px;
  margin: 0 1px;
  border-radius: 3px;
  font-size: 0.92em;
  line-height: 1;
  cursor: help;
  /* tint derived from the category color set via `color` below, matching the
     existing .json-tree-badge pattern */
  background: color-mix(in srgb, currentColor 16%, transparent);
}
.mdh-special-space      { color: var(--warning); }
.mdh-special-zero-width { color: var(--danger); }
.mdh-special-control    { color: var(--accent); }
.mdh-special-bidi       { color: var(--mdh-special-bidi); }
```

- [ ] **Step 3: Verify the build (no commit)**

Run: `npm run build`
Expected: build succeeds, no CSS errors. (CSS is visual; correctness of the spans is already covered by Task 2's tests.) Do **not** commit.

---

### Task 4: Wire `JsonTree.jsx` (expanded string primitive + string array items)

**Files:**
- Modify: `src/mdh/components/JsonTree.jsx` (import; primitive string render ~lines 215-242; array primitive item render ~lines 201-207)
- Test: `tests/mdh-json-tree-special.test.js`

**Interfaces:**
- Consumes: default `SpecialText` from `./SpecialText.jsx` (Task 2).
- Produces: no new exports; JsonTree now reveals special chars in string values and string array items.

- [ ] **Step 1: Write the failing test**

Create `tests/mdh-json-tree-special.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { h, render } from 'preact';
import JsonTree from '../src/mdh/components/JsonTree.jsx';

function mount(data, extra = {}) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(JsonTree, {
    data,
    sortState: {}, filterState: {}, onSort() {}, onFilter() {},
    ...extra,
  }), root);
  return root;
}

afterEach(() => { document.body.innerHTML = ''; });

describe('JsonTree special-character reveal', () => {
  it('reveals a special char in a string value', () => {
    const root = mount({ name: 'a\u00a0b' });
    const span = root.querySelector('.mdh-special.mdh-special-space');
    expect(span).not.toBeNull();
    expect(span.getAttribute('title')).toBe('U+00A0 NO-BREAK SPACE');
  });

  it('reveals a special char in a string array item', () => {
    const root = mount({ tags: ['x\u200bz'] });
    expect(root.querySelector('.mdh-special.mdh-special-zero-width')).not.toBeNull();
  });

  it('also reveals in read-only mode', () => {
    const root = mount({ name: 'a\u00a0b' }, { readOnly: true });
    expect(root.querySelector('.mdh-special.mdh-special-space')).not.toBeNull();
  });

  it('leaves a clean string untouched', () => {
    const root = mount({ name: 'Alice' });
    expect(root.querySelectorAll('.mdh-special').length).toBe(0);
    expect(root.textContent).toContain('"Alice"');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mdh-json-tree-special.test.js`
Expected: FAIL — no `.mdh-special` spans (JsonTree still renders raw strings).

- [ ] **Step 3: Add the import**

In `src/mdh/components/JsonTree.jsx`, after the existing imports (after line 4), add:

```jsx
import SpecialText from './SpecialText.jsx';
```

- [ ] **Step 4: Reveal special chars in string array items**

In `src/mdh/components/JsonTree.jsx`, the primitive array-item branch currently reads (around lines 201-207):

```jsx
              return (
                <div class="json-tree-row">
                  <span class="json-tree-array-index">[{ai}]</span>
                  <span class="json-tree-value">{JSON.stringify(item)}</span>
                  <CopyButton getText={() => copyTextFor(item)} kind="value" />
                </div>
              );
```

Replace the value `<span>` so string items go through `SpecialText` (non-strings keep `JSON.stringify`):

```jsx
              return (
                <div class="json-tree-row">
                  <span class="json-tree-array-index">[{ai}]</span>
                  <span class="json-tree-value">
                    {typeof item === 'string'
                      ? <SpecialText value={item} quote />
                      : JSON.stringify(item)}
                  </span>
                  <CopyButton getText={() => copyTextFor(item)} kind="value" />
                </div>
              );
```

- [ ] **Step 5: Reveal special chars in the expanded string primitive**

In `src/mdh/components/JsonTree.jsx`, the trailing primitive branch currently reads (around lines 224-239):

```jsx
  const display = value === null ? 'null' : typeof value === 'string' ? `"${value}"` : String(value);
  const copyText = copyTextFor(value);

  return (
    <div class="json-tree-row">
      {keyEl}
      <span class="json-tree-sep">: </span>
      {readOnly
        ? <span class={'json-tree-value' + colorCls}>{display}</span>
        : (
          <button
            class={valCls}
            title={filtered ? `Filtering by ${fullPath} — click to remove filter (${ALT_KEY}+click to copy)` : `Click to filter: ${fullPath} = ${JSON.stringify(value)} — ${ALT_KEY}+click to copy`}
            onClick={(e) => handleValueClick(e, copyText)}
          >{display}</button>
        )}
      <CopyButton getText={() => copyText} kind="value" />
    </div>
  );
```

Replace it with a version that renders strings via `SpecialText` (non-strings keep the existing `display` string):

```jsx
  const isString = typeof value === 'string';
  const display = value === null ? 'null' : isString ? null : String(value);
  const valueContent = isString ? <SpecialText value={value} quote /> : display;
  const copyText = copyTextFor(value);

  return (
    <div class="json-tree-row">
      {keyEl}
      <span class="json-tree-sep">: </span>
      {readOnly
        ? <span class={'json-tree-value' + colorCls}>{valueContent}</span>
        : (
          <button
            class={valCls}
            title={filtered ? `Filtering by ${fullPath} — click to remove filter (${ALT_KEY}+click to copy)` : `Click to filter: ${fullPath} = ${JSON.stringify(value)} — ${ALT_KEY}+click to copy`}
            onClick={(e) => handleValueClick(e, copyText)}
          >{valueContent}</button>
        )}
      <CopyButton getText={() => copyText} kind="value" />
    </div>
  );
```

- [ ] **Step 6: Run the new test + existing JsonTree consumers**

Run: `npx vitest run tests/mdh-json-tree-special.test.js tests/mdh-record-card.test.js`
Expected: PASS (new reveal test passes; RecordCard test unaffected — its data is clean).

- [ ] **Step 7: Verify (no commit)**

Run: `npm test`
Expected: full suite green. Do **not** commit.

---

### Task 5: Wire `RecordTable.jsx` (simple string cell)

**Files:**
- Modify: `src/mdh/components/RecordTable.jsx` (import; simple-cell render ~lines 146-155)
- Test: `tests/mdh-record-table.test.js` (extend)

**Interfaces:**
- Consumes: default `SpecialText` from `./SpecialText.jsx` (Task 2). Keeps existing `displayValue` import for non-string cells and the complex-value badge.
- Produces: no new exports; simple string cells reveal special chars (truncated at 20, quoted), preserving prior behavior for non-strings and clean strings.

- [ ] **Step 1: Write the failing test**

Append to `tests/mdh-record-table.test.js` inside the existing `describe('RecordTable', …)` block (the file already defines `renderTable`):

```js
  it('reveals a special character in a string cell', () => {
    const root = renderTable({
      records: [{ _id: '1', name: 'a\u00a0b' }],
      columns: ['_id', 'name'],
    });
    const span = root.querySelector('.mdh-special.mdh-special-space');
    expect(span).not.toBeNull();
    expect(span.getAttribute('title')).toBe('U+00A0 NO-BREAK SPACE');
  });

  it('leaves a clean string cell untouched and still truncates long values', () => {
    const root = renderTable({
      records: [{ _id: '1', name: 'z'.repeat(25) }],
      columns: ['_id', 'name'],
    });
    expect(root.querySelectorAll('.mdh-special').length).toBe(0);
    expect(root.textContent).toContain('z'.repeat(20) + '...');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mdh-record-table.test.js`
Expected: FAIL on "reveals a special character in a string cell" — no `.mdh-special` span yet. (The truncation test already passes via `displayValue`.)

- [ ] **Step 3: Add the import**

In `src/mdh/components/RecordTable.jsx`, after the existing imports (after line 6), add:

```jsx
import SpecialText from './SpecialText.jsx';
```

- [ ] **Step 4: Route string cells through `SpecialText`**

In `src/mdh/components/RecordTable.jsx`, the simple-cell return currently reads (around lines 146-155):

```jsx
    return (
      <td key={col} class="record-table-cell-clickable"
        onClick={() => onFilter(col, value)}
        title={filtered ? `Filtering by ${col} — click to remove` : `Click to filter by ${col}`}>
        <div class="record-table-cell-inner">
          <span class={'record-table-value' + (filtered ? ' json-tree-value-filtered' : '')}>{displayValue(value)}</span>
          <CopyButton getText={() => copyTextFor(value)} kind="value" />
        </div>
      </td>
    );
```

Replace the value `<span>`'s child so strings go through `SpecialText` (non-strings keep `displayValue`):

```jsx
    return (
      <td key={col} class="record-table-cell-clickable"
        onClick={() => onFilter(col, value)}
        title={filtered ? `Filtering by ${col} — click to remove` : `Click to filter by ${col}`}>
        <div class="record-table-cell-inner">
          <span class={'record-table-value' + (filtered ? ' json-tree-value-filtered' : '')}>
            {typeof value === 'string'
              ? <SpecialText value={value} quote limit={20} />
              : displayValue(value)}
          </span>
          <CopyButton getText={() => copyTextFor(value)} kind="value" />
        </div>
      </td>
    );
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/mdh-record-table.test.js`
Expected: PASS (both new tests + all existing RecordTable tests).

- [ ] **Step 6: Final verification (no commit)**

Run: `npm test`
Expected: full suite green.

Run: `npm run build`
Expected: build succeeds (esbuild bundles the new component into `console.js`).

Do **not** commit — leave the working tree for the developer to review and commit manually.

---

## Self-Review

**1. Spec coverage**

| Spec requirement | Task |
| --- | --- |
| Character set (4 categories, curated codepoints, exclude U+0020) | Task 1 (`SPACE_CPS`/`ZERO_WIDTH_CPS`/`BIDI_CPS`/`isControl`, explicit `0x20 → null`) |
| `classifySpecial` / `hasSpecial` / `tokenizeSpecial` / `cpLabel` | Task 1 |
| Code-point-safe iteration, `limit` truncation by source chars | Task 1 (`for…of`, `count`/`truncated`) |
| `<SpecialText value quote? limit?>`, clean = byte-identical | Task 2 |
| Marker spans with `mdh-special mdh-special-<category>` + `U+XXXX NAME` title | Task 2 + Task 3 (CSS) |
| Surfaces: JsonTree expanded string + array string items | Task 4 |
| Surfaces: RecordTable simple string cell (quote + limit 20) | Task 5 |
| Transitive coverage of RecordCard + read-only Stages cards | Task 4 (JsonTree is shared; read-only test included) |
| CSS, light + dark, reuse semantic vars | Task 3 |
| Backward compat: `displayValue`/`recordSummary`/copy/downloads untouched | No task modifies them; Tasks 4/5 only swap the visible child; clean-string + truncation tests assert parity |
| Copy stays raw | Tasks 4/5 keep `copyTextFor` in `CopyButton` unchanged |
| Out of scope (keys, preview, toggle, U+FFFD, editors, Stats) | Not implemented (correct) |
| Testing: pure tests + h()-based component tests | Tasks 1, 2, 4, 5 |

No gaps.

**2. Placeholder scan:** No `TBD`/`TODO`/"handle edge cases"/"similar to". Every code step shows full code; every command shows expected output.

**3. Type consistency:** `classifySpecial`/`hasSpecial`/`tokenizeSpecial`/`cpLabel` signatures match across Task 1 (definition), Task 2 (consumption), and the tests. Token shape (`{type:'text',value}` / `{type:'special',cp,char,category,name,glyph}`) is identical in Task 1's implementation, Task 1's tests, and Task 2's renderer. Category strings (`space`/`zero-width`/`control`/`bidi`) match between `classifySpecial`, the CSS class names (Task 3), and the wiring tests (Tasks 4/5). `SpecialText` prop names (`value`/`quote`/`limit`) are consistent across Tasks 2, 4, 5.

**Note on commits:** the standard plan template's per-task `git commit` step is intentionally replaced with a verification step per the Global Constraints (no commits during this run).
