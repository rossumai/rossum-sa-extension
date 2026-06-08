# "Insert from CSV file" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Insert from CSV file" feature to the Dataset Management (MDH) app that parses a CSV client-side into JSON documents and inserts them into the selected Data Storage collection, with a configurable parser and a live preview.

**Architecture:** A new pure, dependency-free CSV module (`src/mdh/csv.js`) converts CSV text → JSON document objects. A new wizard (`CsvImportWizard.jsx`) adds a Configure step (dialect options + live preview) and reuses the existing JSON-insert machinery unchanged: chunked `insert_many` (`runChunkedInsert`/`runChunkedOverwrite` in `importFile.js`), the modal system, and shared CONFIRM/IMPORTING/DONE stages (extracted into `ImportStages.jsx`).

**Tech Stack:** Preact + `@preact/signals`, esbuild (IIFE, `h` pragma), Vitest (jsdom), native `TextDecoder`/`File.arrayBuffer`. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-06-08-mdh-csv-import-design.md`

**Commits:** This repo commits manually — **do NOT run `git commit`** during execution. End each task by running the relevant tests (and `npm run build` where noted). Stay on `master`; no branches/worktrees.

**Test conventions (from the repo):**
- `npm test` runs the whole suite (`vitest run`); single file: `npx vitest run tests/<file>.test.js`.
- Pure-logic tests: plain imports, no environment directive needed.
- Component tests: first line `// @vitest-environment jsdom`, `import { h, render } from 'preact'`, mount into a `document.createElement('div')`, query with `data-testid`, drive inputs via `el.dispatchEvent(new Event('input', { bubbles: true }))` / `el.click()`.
- JSX unicode: use `{'…'}` expression form, never raw `\uXXXX` in text/attributes (oxc renders the literal backslash). This is already enforced across the codebase.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/mdh/csv.js` | **new** | Pure CSV core: `tokenizeCsv`, `rowsToDocs`, `inferValue`, `dedupeHeaders`, `decodeBytes`, `parseCsv`. No DOM. |
| `src/mdh/components/ImportStages.jsx` | **new** | Shared wizard stages extracted from `InsertFileWizard`: `StageConfirm`, `StageImporting`, `StageDone`. |
| `src/mdh/components/CsvImportWizard.jsx` | **new** | 5-stage CSV wizard + exported `CsvPreview`. |
| `src/mdh/components/InsertFileWizard.jsx` | modify | Import the 3 shared stages instead of defining them inline. |
| `src/mdh/components/DataOperations.jsx` | modify | Route `insert-csv-file` → `CsvImportWizard`. |
| `src/mdh/components/RecordList.jsx` | modify | Generalize `SplitButton` to N menu items; add "Insert from CSV file". |
| `src/mdh/components/DataPanel.jsx` | modify | `handleToolbarAction` gains `insert-csv-file`. |
| `console.css` | modify | `.csv-*` styles for the Configure controls + preview table. |
| `tests/mdh-csv.test.js` | **new** | Unit tests for `src/mdh/csv.js`. |
| `tests/mdh-import-stages.test.js` | **new** | Render smoke tests for the extracted stages. |
| `tests/mdh-csv-wizard.test.js` | **new** | Render tests for `CsvImportWizard` / `CsvPreview`. |

`importFile.js`, `api.js`, `store.js`, `Modal.jsx` are **reused unchanged**.

---

## Task 1: CSV tokenizer (`tokenizeCsv`)

**Files:**
- Create: `src/mdh/csv.js`
- Test: `tests/mdh-csv.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/mdh-csv.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { tokenizeCsv } from '../src/mdh/csv.js';

describe('tokenizeCsv', () => {
  it('parses plain rows', () => {
    expect(tokenizeCsv('a,b\nc,d').rows).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('keeps the delimiter inside a quoted field', () => {
    expect(tokenizeCsv('"a,b",c').rows).toEqual([['a,b', 'c']]);
  });

  it('keeps a newline inside a quoted field', () => {
    expect(tokenizeCsv('"a\nb",c').rows).toEqual([['a\nb', 'c']]);
  });

  it('collapses doubled quotes when doubleQuote is on', () => {
    expect(tokenizeCsv('"a""b"').rows).toEqual([['a"b']]);
  });

  it('uses escapeChar when set (doubleQuote off)', () => {
    // raw text: "a\"b"  -> field a"b
    const r = tokenizeCsv('"a\\"b"', { escapeChar: '\\', doubleQuote: false });
    expect(r.rows).toEqual([['a"b']]);
  });

  it('honours custom delimiters', () => {
    expect(tokenizeCsv('a;b', { delimiter: ';' }).rows).toEqual([['a', 'b']]);
    expect(tokenizeCsv('a\tb', { delimiter: '\t' }).rows).toEqual([['a', 'b']]);
    expect(tokenizeCsv('a|b', { delimiter: '|' }).rows).toEqual([['a', 'b']]);
  });

  it('handles CRLF, LF, and lone CR terminators', () => {
    expect(tokenizeCsv('a,b\r\nc,d').rows).toEqual([['a', 'b'], ['c', 'd']]);
    expect(tokenizeCsv('a,b\rc,d').rows).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('drops blank lines when skipEmptyLines is on, keeps them when off', () => {
    expect(tokenizeCsv('a,b\n\nc,d').rows).toEqual([['a', 'b'], ['c', 'd']]);
    expect(tokenizeCsv('a,b\n\nc,d', { skipEmptyLines: false }).rows)
      .toEqual([['a', 'b'], [''], ['c', 'd']]);
  });

  it('keeps a row of empty quoted fields (not a blank line)', () => {
    expect(tokenizeCsv('""').rows).toEqual([['']]);
    expect(tokenizeCsv('"",""').rows).toEqual([['', '']]);
  });

  it('returns empty rows for empty input', () => {
    expect(tokenizeCsv('').rows).toEqual([]);
  });

  it('reports an error for an unterminated quoted field', () => {
    const r = tokenizeCsv('"abc');
    expect(r.error).toBeTruthy();
    expect(r.error.message).toMatch(/unterminated/i);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/mdh-csv.test.js`
Expected: FAIL — `tokenizeCsv is not a function` / module not found.

- [ ] **Step 3: Implement `tokenizeCsv`**

Create `src/mdh/csv.js`:

```js
// Pure, dependency-free CSV → JSON conversion for the Dataset Management app.
//
// There is no server-side CSV endpoint on the Data Storage API (confirmed),
// so the CSV is parsed in the browser and the resulting documents flow into
// the same chunked insert_many path the JSON importer uses. The tokenizer is
// dialect-configurable (delimiter / quote / escape / double-quote) so the
// importer can expose those exact options to the user.

// Tokenize CSV text into rows of string cells.
//
// dialect:
//   delimiter      (default ',')   field separator, outside quotes only
//   quoteChar      (default '"')    wraps fields containing delimiter/newlines
//   escapeChar     (default null)   inside quotes, emits the NEXT char literally
//   doubleQuote    (default true)   inside quotes, '""' -> one literal quote
//   skipEmptyLines (default true)   drop records that are a single empty, unquoted field
//
// Returns { rows: string[][], error: { message, line } | null }.
// Line terminators \r\n, \n, and lone \r are all auto-detected.
export function tokenizeCsv(text, dialect = {}) {
  const {
    delimiter = ',',
    quoteChar = '"',
    escapeChar = null,
    doubleQuote = true,
    skipEmptyLines = true,
  } = dialect;

  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  let sawQuote = false;     // any quote opened in the current row
  let quoteOpenLine = 1;    // line where the currently-open quote started
  let line = 1;             // 1-based line counter
  let error = null;

  const endField = () => { row.push(field); field = ''; };
  const endRow = () => {
    endField();
    const isBlank = row.length === 1 && row[0] === '' && !sawQuote;
    if (!(skipEmptyLines && isBlank)) rows.push(row);
    row = [];
    sawQuote = false;
  };

  const n = text.length;
  let p = 0;
  while (p < n) {
    const c = text[p];

    if (inQuotes) {
      if (escapeChar && c === escapeChar) {
        if (p + 1 < n) { field += text[p + 1]; p += 2; } else { field += c; p += 1; }
        continue;
      }
      if (c === quoteChar) {
        if (doubleQuote && text[p + 1] === quoteChar) { field += quoteChar; p += 2; continue; }
        inQuotes = false; p += 1; continue;
      }
      if (c === '\n') { field += c; line++; p += 1; continue; }
      field += c; p += 1; continue;
    }

    // outside quotes
    if (c === quoteChar && field === '') { inQuotes = true; sawQuote = true; quoteOpenLine = line; p += 1; continue; }
    if (c === delimiter) { endField(); p += 1; continue; }
    if (c === '\r') { endRow(); p += (text[p + 1] === '\n' ? 2 : 1); line++; continue; }
    if (c === '\n') { endRow(); p += 1; line++; continue; }
    field += c; p += 1;
  }

  if (inQuotes) error = { message: 'Unterminated quoted field', line: quoteOpenLine };

  // Flush a trailing record that had no closing terminator.
  if (field !== '' || row.length > 0 || inQuotes) endRow();

  return { rows, error };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/mdh-csv.test.js`
Expected: PASS (all `tokenizeCsv` tests green).

- [ ] **Step 5: Verify the whole suite is still green**

Run: `npm test`
Expected: PASS, no regressions.

---

## Task 2: Row → document conversion (`inferValue`, `dedupeHeaders`, `rowsToDocs`)

**Files:**
- Modify: `src/mdh/csv.js`
- Test: `tests/mdh-csv.test.js`

- [ ] **Step 1: Add the failing tests**

Append to `tests/mdh-csv.test.js`:

```js
import { inferValue, dedupeHeaders, rowsToDocs } from '../src/mdh/csv.js';

describe('inferValue', () => {
  it('detects booleans case-insensitively', () => {
    expect(inferValue('true')).toBe(true);
    expect(inferValue('TRUE')).toBe(true);
    expect(inferValue('false')).toBe(false);
  });
  it('detects integers and decimals', () => {
    expect(inferValue('42')).toBe(42);
    expect(inferValue('-7')).toBe(-7);
    expect(inferValue('0')).toBe(0);
    expect(inferValue('3.14')).toBe(3.14);
    expect(inferValue('0.5')).toBe(0.5);
  });
  it('keeps leading-zero and non-numeric strings as strings', () => {
    expect(inferValue('01234')).toBe('01234');
    expect(inferValue('00')).toBe('00');
    expect(inferValue('1e5')).toBe('1e5');
    expect(inferValue('12abc')).toBe('12abc');
    expect(inferValue('+5')).toBe('+5');
  });
});

describe('dedupeHeaders', () => {
  it('uniquifies duplicates and fills blanks with column_N', () => {
    expect(dedupeHeaders(['a', '', 'a'])).toEqual(['a', 'column_2', 'a_2']);
    expect(dedupeHeaders(['x', '  '])).toEqual(['x', 'column_2']);
  });
});

describe('rowsToDocs', () => {
  it('maps a header row to keys (strings by default)', () => {
    const r = rowsToDocs([['name', 'age'], ['Alice', '30']], { hasHeader: true });
    expect(r.columns).toEqual(['name', 'age']);
    expect(r.docs).toEqual([{ name: 'Alice', age: '30' }]);
  });
  it('infers types when inferTypes is on', () => {
    const r = rowsToDocs([['name', 'age'], ['Alice', '30']], { hasHeader: true, inferTypes: true });
    expect(r.docs).toEqual([{ name: 'Alice', age: 30 }]);
  });
  it('generates column_N names when there is no header', () => {
    const r = rowsToDocs([['a', 'b']], { hasHeader: false });
    expect(r.columns).toEqual(['column_1', 'column_2']);
    expect(r.docs).toEqual([{ column_1: 'a', column_2: 'b' }]);
  });
  it('resolves duplicate header names', () => {
    const r = rowsToDocs([['x', 'x'], ['1', '2']], { hasHeader: true });
    expect(r.docs).toEqual([{ x: '1', x_2: '2' }]);
  });
  it('handles empty cells per emptyMode', () => {
    const rows = [['a', 'b'], ['1', '']];
    expect(rowsToDocs(rows, { emptyMode: 'empty' }).docs).toEqual([{ a: '1', b: '' }]);
    expect(rowsToDocs(rows, { emptyMode: 'null' }).docs).toEqual([{ a: '1', b: null }]);
    expect(rowsToDocs(rows, { emptyMode: 'omit' }).docs).toEqual([{ a: '1' }]);
  });
  it('trims values when trim is on', () => {
    const r = rowsToDocs([['a'], [' x ']], { hasHeader: true, trim: true });
    expect(r.docs).toEqual([{ a: 'x' }]);
  });
  it('passes an _id column through unchanged', () => {
    const r = rowsToDocs([['_id', 'name'], ['V1', 'Acme']], { hasHeader: true });
    expect(r.docs).toEqual([{ _id: 'V1', name: 'Acme' }]);
  });
  it('warns about ragged rows and pads short ones', () => {
    const r = rowsToDocs([['a', 'b'], ['1']], { hasHeader: true, emptyMode: 'empty' });
    expect(r.docs).toEqual([{ a: '1', b: '' }]);
    expect(r.warnings.join(' ')).toMatch(/column count/i);
  });
  it('returns empty docs for no rows', () => {
    expect(rowsToDocs([]).docs).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mdh-csv.test.js`
Expected: FAIL — `inferValue` / `dedupeHeaders` / `rowsToDocs` are not functions.

- [ ] **Step 3: Implement the three functions**

Append to `src/mdh/csv.js`:

```js
// Conservative scalar inference for a single cell. Returns the original string
// unless it cleanly looks like an integer, decimal, or boolean. Leading-zero
// strings, scientific notation, signs, and anything with stray characters stay
// strings — so IDs / ZIPs / phone numbers are never silently corrupted.
export function inferValue(s) {
  if (typeof s !== 'string') return s;
  const low = s.toLowerCase();
  if (low === 'true') return true;
  if (low === 'false') return false;
  if (/^-?\d+$/.test(s)) {
    if (/^-?0\d/.test(s)) return s;          // leading zero -> keep as string
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : s;  // too big -> avoid precision loss
  }
  if (/^-?(\d+\.\d*|\.\d+)$/.test(s)) {
    if (/^-?0\d/.test(s)) return s;          // e.g. 01.5 -> keep as string
    const n = Number(s);
    return Number.isFinite(n) ? n : s;
  }
  return s;
}

// Resolve a list of header names into unique, non-empty keys.
// Blank/whitespace names become column_<1-based-index>; later duplicates get a
// _2, _3, ... suffix. Value-trimming is the caller's job (see rowsToDocs).
export function dedupeHeaders(names) {
  const used = new Set();
  return names.map((raw, i) => {
    let name = raw == null ? '' : String(raw);
    if (name.trim() === '') name = `column_${i + 1}`;
    let candidate = name;
    let k = 2;
    while (used.has(candidate)) candidate = `${name}_${k++}`;
    used.add(candidate);
    return candidate;
  });
}

// Convert tokenized rows into document objects.
//
// opts:
//   hasHeader   (default true)     row 0 supplies field names
//   inferTypes  (default false)    apply inferValue to each non-empty cell
//   emptyMode   (default 'empty')  '' -> 'empty' (""), 'null' (null), or 'omit' (no key)
//   trim        (default false)    strip surrounding whitespace from each value
//
// Header names are always trimmed (object keys with stray whitespace are a
// footgun); the `trim` option governs data cells only.
// Returns { docs, columns, warnings }.
export function rowsToDocs(rows, opts = {}) {
  const { hasHeader = true, inferTypes = false, emptyMode = 'empty', trim = false } = opts;
  const warnings = [];
  if (!rows || rows.length === 0) return { docs: [], columns: [], warnings };

  const maxLen = rows.reduce((m, r) => Math.max(m, r.length), 0);

  let columns;
  let dataRows;
  if (hasHeader) {
    const header = rows[0].map((c) => String(c == null ? '' : c).trim());
    while (header.length < maxLen) header.push('');     // name extra data columns
    columns = dedupeHeaders(header);
    if (rows[0].length < maxLen) {
      warnings.push(`${maxLen - rows[0].length} column(s) beyond the header were auto-named column_N.`);
    }
    dataRows = rows.slice(1);
  } else {
    columns = [];
    for (let i = 0; i < maxLen; i++) columns.push(`column_${i + 1}`);
    dataRows = rows;
  }

  let ragged = 0;
  const docs = dataRows.map((row) => {
    if (row.length !== columns.length) ragged++;
    const doc = {};
    for (let i = 0; i < columns.length; i++) {
      const raw = i < row.length ? row[i] : '';
      const v = trim ? raw.trim() : raw;
      if (v === '') {
        if (emptyMode === 'omit') continue;
        doc[columns[i]] = emptyMode === 'null' ? null : '';
        continue;
      }
      doc[columns[i]] = inferTypes ? inferValue(v) : v;
    }
    return doc;
  });

  if (ragged > 0) {
    warnings.push(`${ragged} row(s) have a different column count than the header.`);
  }
  return { docs, columns, warnings };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/mdh-csv.test.js`
Expected: PASS (all `inferValue` / `dedupeHeaders` / `rowsToDocs` tests green).

- [ ] **Step 5: Verify the whole suite**

Run: `npm test`
Expected: PASS.

---

## Task 3: Decode + one-call parse (`decodeBytes`, `parseCsv`)

**Files:**
- Modify: `src/mdh/csv.js`
- Test: `tests/mdh-csv.test.js`

- [ ] **Step 1: Add the failing tests**

Append to `tests/mdh-csv.test.js`:

```js
import { decodeBytes, parseCsv } from '../src/mdh/csv.js';

describe('decodeBytes', () => {
  it('decodes utf-8 by default', () => {
    const bytes = new TextEncoder().encode('héllo');
    expect(decodeBytes(bytes.buffer)).toBe('héllo');
  });
  it('decodes windows-1252', () => {
    expect(decodeBytes(new Uint8Array([0x68, 0xE9]), 'windows-1252')).toBe('hé');
  });
  it('falls back to utf-8 for an unknown encoding label', () => {
    expect(decodeBytes(new Uint8Array([0x41]), 'bogus-enc-xyz')).toBe('A');
  });
});

describe('parseCsv', () => {
  it('decodes, tokenizes, and converts in one call', () => {
    const text = new TextEncoder().encode('a,b\n1,2');
    const r = parseCsv(text.buffer, { hasHeader: true });
    expect(r).toEqual({ docs: [{ a: '1', b: '2' }], columns: ['a', 'b'], warnings: [], error: null });
  });
  it('accepts a string buffer directly', () => {
    expect(parseCsv('a,b\n1,2', { hasHeader: true }).docs).toEqual([{ a: '1', b: '2' }]);
  });
  it('surfaces a tokenizer error', () => {
    expect(parseCsv('"oops', {}).error).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mdh-csv.test.js`
Expected: FAIL — `decodeBytes` / `parseCsv` are not functions.

- [ ] **Step 3: Implement**

Append to `src/mdh/csv.js`:

```js
// Decode raw bytes (ArrayBuffer or TypedArray) to text. Unknown encoding
// labels fall back to utf-8 rather than throwing, so the UI can offer encodings
// without risk of a hard failure.
export function decodeBytes(buffer, encoding = 'utf-8') {
  try {
    return new TextDecoder(encoding).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

// Full pipeline used by the wizard: decode -> tokenize -> convert.
// `buffer` may be an ArrayBuffer/TypedArray (decoded with options.encoding) or
// a string (used as-is — handy for tests). On a tokenizer error, returns
// whatever rows were recovered (for preview) plus the error so the caller can
// block the import.
export function parseCsv(buffer, options = {}) {
  const text = typeof buffer === 'string' ? buffer : decodeBytes(buffer, options.encoding);
  const { rows, error } = tokenizeCsv(text, options);
  const { docs, columns, warnings } = rowsToDocs(rows, options);
  return { docs, columns, warnings, error };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/mdh-csv.test.js`
Expected: PASS (full file green).

- [ ] **Step 5: Verify the whole suite**

Run: `npm test`
Expected: PASS.

---

## Task 4: Extract shared wizard stages into `ImportStages.jsx`

This is a pure refactor: move `StageConfirm`, `StageImporting`, `StageDone` (and their private helpers `FileSummary`, `formatBytes`, `formatIdSample`) out of `InsertFileWizard.jsx` into a new module, then import them back. No behavior change for the JSON wizard.

**Files:**
- Create: `src/mdh/components/ImportStages.jsx`
- Modify: `src/mdh/components/InsertFileWizard.jsx`
- Test: `tests/mdh-import-stages.test.js`

- [ ] **Step 1: Create `ImportStages.jsx`**

Create `src/mdh/components/ImportStages.jsx` with the three stages + helpers, moved verbatim from `InsertFileWizard.jsx` (lines 29–46 helpers, 179–323 stages) and exported:

```jsx
import { h, Fragment } from 'preact';
import { selectedCollection } from '../store.js';

// Shared CONFIRM / IMPORTING / DONE stages used by both the JSON and CSV
// import wizards. The PICK stage stays per-wizard (each accepts a different
// file type). These components are presentation-only and take all data via
// props; the wizards own state and the actual insert flow.

function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatIdSample(ids, max = 3) {
  const out = [];
  for (let i = 0; i < ids.length && i < max; i++) {
    const v = ids[i];
    if (v && typeof v === 'object' && '$oid' in v) out.push(String(v.$oid));
    else if (typeof v === 'string') out.push(v.length > 12 ? v.slice(0, 12) + '…' : v);
    else out.push(String(v));
  }
  if (ids.length > max) out.push(`+${ids.length - max} more`);
  return out.join(', ');
}

function FileSummary({ fileMeta, stats }) {
  if (!fileMeta || !stats) return null;
  const parts = [];
  parts.push(`${stats.total.toLocaleString()} document${stats.total === 1 ? '' : 's'}`);
  if (fileMeta.size) parts.push(formatBytes(fileMeta.size));
  if (stats.withId === stats.total && stats.total > 0) parts.push('all have _id');
  else if (stats.withId === 0) parts.push('no explicit _id');
  else parts.push(`${stats.withId.toLocaleString()} with _id, ${stats.withoutId.toLocaleString()} without`);
  return (
    <div class="modal-count-info">
      <div style="font-family:var(--font-mono);font-size:11px;color:var(--text-secondary)">{fileMeta.name}</div>
      <div>{parts.join(' · ')}</div>
    </div>
  );
}

export function StageConfirm({ fileMeta, stats, mode, setMode, errorMsg, onImport, onCancel }) {
  const hasInFileDupes = stats.inFileDupeCount > 0;
  const hasIds = stats.withId > 0;
  const willInsert = stats.uniqueIdCount + stats.withoutId;

  return (
    <Fragment>
      <FileSummary fileMeta={fileMeta} stats={stats} />

      {hasInFileDupes && (
        <div class="import-conflict-info">
          <strong>{stats.inFileDupeCount.toLocaleString()}</strong> duplicate <code>_id</code>{stats.inFileDupeCount === 1 ? '' : 's'} within the file will be collapsed to one occurrence.
          {stats.inFileDupeIdSample.length > 0 && <div class="import-id-sample">e.g. {formatIdSample(stats.inFileDupeIdSample)}</div>}
        </div>
      )}

      {hasIds && (
        <div>
          <div class="modal-field-label">If a document's <code>_id</code> already exists in <code>{selectedCollection.value}</code>:</div>
          <div class="import-mode-group">
            <label class={`import-mode-option ${mode === 'insert' ? 'selected' : ''}`}>
              <input type="radio" name="import-mode" value="insert" checked={mode === 'insert'} onChange={() => setMode('insert')} />
              <span>
                <span class="import-mode-title">Insert (fail on duplicate)</span>
                <span class="import-mode-desc">Send the file as-is. Batches with conflicting <code>_id</code>s will be reported as failures in the summary.</span>
              </span>
            </label>
            <label class={`import-mode-option ${mode === 'overwrite' ? 'selected' : ''}`}>
              <input type="radio" name="import-mode" value="overwrite" checked={mode === 'overwrite'} onChange={() => setMode('overwrite')} />
              <span>
                <span class="import-mode-title">Overwrite</span>
                <span class="import-mode-desc">Delete any documents whose <code>_id</code> matches the file (no-op for <code>_id</code>s that don't exist), then insert all {willInsert.toLocaleString()} from the file. Idempotent re-import.</span>
              </span>
            </label>
          </div>
        </div>
      )}

      {errorMsg && <div class="input-hint" style="color:var(--danger)">{errorMsg}</div>}

      <div class="modal-actions">
        <button class="btn btn-secondary" onClick={onCancel}>Cancel</button>
        <button
          class={`btn ${mode === 'overwrite' ? 'btn-danger' : 'btn-success'}`}
          onClick={onImport}
          disabled={willInsert === 0}
        >
          {mode === 'overwrite'
            ? `Overwrite ${willInsert.toLocaleString()} document${willInsert === 1 ? '' : 's'}`
            : `Insert ${willInsert.toLocaleString()} document${willInsert === 1 ? '' : 's'}`}
        </button>
      </div>
    </Fragment>
  );
}

export function StageImporting({ progress, mode, onCancel }) {
  const { processed = 0, total = 0, inserted = 0, failedBatches = 0, phase } = progress;
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const label = mode === 'overwrite' && phase === 'delete'
    ? 'Deleting any matching documents'
    : 'Inserting documents';
  return (
    <Fragment>
      <div class="modal-message">{label}…</div>
      <div class="import-progress">
        <div class="import-progress-track">
          <div class="import-progress-fill" style={`width:${pct}%`}></div>
        </div>
        <div class="import-progress-counts">
          <span>{processed.toLocaleString()} / {total.toLocaleString()}</span>
          <span>{pct}%</span>
        </div>
      </div>
      <div class="import-progress-meta">
        {phase !== 'delete' && <span>{inserted.toLocaleString()} inserted</span>}
        {failedBatches > 0 && <span style="color:var(--danger)">{failedBatches} batch{failedBatches === 1 ? '' : 'es'} failed</span>}
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" onClick={onCancel}>Cancel</button>
      </div>
    </Fragment>
  );
}

export function StageDone({ result, mode, fileMeta, onClose }) {
  const { inserted = 0, deleted = 0, failedBatches = [], inFileDropped = 0, cancelled, kind } = result;
  const overall = failedBatches.length === 0 && !cancelled;

  return (
    <Fragment>
      <div class={`import-result-header ${overall ? 'success' : 'partial'}`}>
        <span class="import-result-icon">{overall ? '✓' : cancelled ? '○' : '⚠'}</span>
        <span>
          {cancelled ? 'Cancelled' : overall ? 'Import complete' : 'Import partially complete'}
          {fileMeta?.name && <span class="import-result-filename"> · {fileMeta.name}</span>}
        </span>
      </div>

      <ul class="import-result-list">
        {kind === 'overwrite' && deleted > 0 && <li>Deleted <strong>{deleted.toLocaleString()}</strong> existing record{deleted === 1 ? '' : 's'}</li>}
        {inserted > 0 && <li>Inserted <strong>{inserted.toLocaleString()}</strong> document{inserted === 1 ? '' : 's'}</li>}
        {inFileDropped > 0 && <li><strong>{inFileDropped.toLocaleString()}</strong> in-file duplicate{inFileDropped === 1 ? '' : 's'} were collapsed</li>}
        {failedBatches.length > 0 && (
          <li style="color:var(--danger)">
            <strong>{failedBatches.length}</strong> batch{failedBatches.length === 1 ? '' : 'es'} failed
            <ul class="import-failure-list">
              {failedBatches.slice(0, 5).map((b) => (
                <li>
                  Records {b.startIdx.toLocaleString()}–{b.endIdx.toLocaleString()} ({b.count.toLocaleString()} docs): <code>{b.message}</code>
                </li>
              ))}
              {failedBatches.length > 5 && <li>{'… and '}{failedBatches.length - 5}{' more'}</li>}
            </ul>
            {failedBatches.some((b) => /batch op errors/i.test(b.message)) && (
              <div class="import-result-hint">
                <code>batch op errors occurred</code> typically means at least one document in the batch had a duplicate <code>_id</code> or violated a collection validator. Re-run with Overwrite mode to replace existing records.
              </div>
            )}
          </li>
        )}
      </ul>

      <div class="modal-actions">
        <button class="btn btn-primary" onClick={onClose}>Close</button>
      </div>
    </Fragment>
  );
}
```

- [ ] **Step 2: Update `InsertFileWizard.jsx` to import the shared stages**

In `src/mdh/components/InsertFileWizard.jsx`:

Replace the import block (lines 1–10) with — note `Fragment` is still needed by `StagePick`:

```jsx
import { h, Fragment } from 'preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import { selectedCollection } from '../store.js';
import { closeModal } from './Modal.jsx';
import {
  analyzeDocs,
  dedupeById,
  runChunkedInsert,
  runChunkedOverwrite,
} from '../importFile.js';
import { StageConfirm, StageImporting, StageDone } from './ImportStages.jsx';
```

Then **delete** these now-moved definitions from the file:
- `formatBytes` (lines 29–34)
- `formatIdSample` (lines 36–46)
- `function StageConfirm(...)` (lines 179–233)
- `function StageImporting(...)` (lines 235–262)
- `function StageDone(...)` (lines 264–307)
- `function FileSummary(...)` (lines 309–323)

Keep `StagePick` (lines 157–177), the `STAGE` const, the default-export component, `handleFile`, and `startImport` exactly as they are. The `selectedCollection` import is still used by `startImport`.

- [ ] **Step 3: Write the stage smoke tests**

Create `tests/mdh-import-stages.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h, render } from 'preact';
import { StageImporting, StageDone } from '../src/mdh/components/ImportStages.jsx';

function mount(node) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(node, root);
  return root;
}

describe('ImportStages', () => {
  it('StageImporting shows progress percentage and inserted count', () => {
    const root = mount(h(StageImporting, {
      progress: { processed: 50, total: 100, inserted: 50, failedBatches: 0, phase: 'insert' },
      mode: 'insert', onCancel: () => {},
    }));
    expect(root.textContent).toContain('50%');
    expect(root.textContent).toContain('50 inserted');
  });

  it('StageDone shows the inserted total and filename', () => {
    const root = mount(h(StageDone, {
      result: { inserted: 12, deleted: 0, failedBatches: [], inFileDropped: 0, cancelled: false, kind: 'insert' },
      mode: 'insert', fileMeta: { name: 'vendors.csv' }, onClose: () => {},
    }));
    expect(root.textContent).toContain('Import complete');
    expect(root.textContent).toContain('vendors.csv');
    expect(root.textContent).toContain('12');
  });
});
```

- [ ] **Step 4: Run the new tests + the existing import test**

Run: `npx vitest run tests/mdh-import-stages.test.js tests/mdh-import-file.test.js`
Expected: PASS — stages render; importFile logic unaffected.

- [ ] **Step 5: Verify build + whole suite**

Run: `npm run build && npm test`
Expected: build emits `dist/` with no errors; full suite PASS (the JSON wizard still works — the refactor is import-only).

---

## Task 5: `CsvImportWizard` skeleton + `CsvPreview`

Builds the container and all five stages, wired to `parseCsv`. The Configure stage shows the live preview and a Next button (the option **controls** are added in Task 6 — the option state and re-parse already live here). End result: selecting a CSV file with the default dialect inserts it into the selected collection.

**Files:**
- Create: `src/mdh/components/CsvImportWizard.jsx`
- Test: `tests/mdh-csv-wizard.test.js`

- [ ] **Step 1: Write `CsvImportWizard.jsx`**

Create `src/mdh/components/CsvImportWizard.jsx`:

```jsx
import { h, Fragment } from 'preact';
import { useState, useRef, useEffect, useMemo } from 'preact/hooks';
import { selectedCollection } from '../store.js';
import { closeModal } from './Modal.jsx';
import { analyzeDocs, dedupeById, runChunkedInsert, runChunkedOverwrite } from '../importFile.js';
import { StageConfirm, StageImporting, StageDone } from './ImportStages.jsx';
import { parseCsv } from '../csv.js';

// Multi-stage "Insert from CSV file" flow:
//
//   pick → configure → confirm → importing → done
//
// CSV has no types, so the Configure stage exposes dialect + conversion options
// and shows a live preview of the resulting JSON. Once parsed into row objects,
// the confirm/importing/done stages and the insert itself are identical to the
// JSON importer (shared StageConfirm/StageImporting/StageDone + runChunkedInsert).

const STAGE = { PICK: 'pick', CONFIGURE: 'configure', CONFIRM: 'confirm', IMPORTING: 'importing', DONE: 'done' };

const DEFAULT_OPTS = {
  delimiter: ',',
  quoteChar: '"',
  escapeChar: '',
  doubleQuote: true,
  encoding: 'utf-8',
  hasHeader: true,
  inferTypes: false,
  emptyMode: 'empty',
  skipEmptyLines: true,
  trim: false,
};

export default function CsvImportWizard({ onSuccess }) {
  const [stage, setStage] = useState(STAGE.PICK);
  const [fileMeta, setFileMeta] = useState(null);
  const [buffer, setBuffer] = useState(null);
  const [opts, setOpts] = useState(DEFAULT_OPTS);
  const [mode, setMode] = useState('insert');
  const [stats, setStats] = useState(null);
  const [importProgress, setImportProgress] = useState(null);
  const [importResult, setImportResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);

  const abortRef = useRef(null);
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  // parseCsv needs escapeChar:null when the field is blank ('' means "none").
  const parsed = useMemo(() => {
    if (!buffer) return null;
    return parseCsv(buffer, { ...opts, escapeChar: opts.escapeChar || null });
  }, [buffer, opts]);

  const setOpt = (key, value) => setOpts((o) => ({ ...o, [key]: value }));

  function handleFile(file) {
    setErrorMsg(null);
    setFileMeta({ name: file.name, size: file.size });
    file.arrayBuffer().then((buf) => {
      setBuffer(buf);
      setStage(STAGE.CONFIGURE);
    }).catch((err) => {
      setErrorMsg(`Couldn't read file: ${err.message}`);
    });
  }

  function handleNext() {
    if (!parsed || parsed.error || parsed.docs.length === 0) return;
    setStats(analyzeDocs(parsed.docs));
    setErrorMsg(null);
    setStage(STAGE.CONFIRM);
  }

  async function startImport() {
    if (!parsed) return;
    setErrorMsg(null);
    const { kept, dropped: inFileDropped } = dedupeById(parsed.docs);

    setStage(STAGE.IMPORTING);
    const controller = new AbortController();
    abortRef.current = controller;
    setImportProgress({ phase: 'insert', processed: 0, total: kept.length, inserted: 0, failedBatches: 0 });

    try {
      let result;
      if (mode === 'overwrite' && stats.uniqueIdCount > 0) {
        result = await runChunkedOverwrite(selectedCollection.value, kept, {
          signal: controller.signal,
          onProgress: (p) => setImportProgress({ ...p, total: kept.length }),
        });
        result.kind = 'overwrite';
      } else {
        result = await runChunkedInsert(selectedCollection.value, kept, {
          signal: controller.signal,
          onProgress: setImportProgress,
        });
        result.kind = 'insert';
      }
      result.inFileDropped = inFileDropped;
      setImportResult(result);
      if (result.inserted > 0 || result.deleted > 0) onSuccess?.();
      setStage(STAGE.DONE);
    } catch (err) {
      setErrorMsg(`Import failed: ${err.message}`);
      setStage(STAGE.CONFIRM);
    } finally {
      abortRef.current = null;
    }
  }

  return (
    <div class="modal-body import-wizard">
      {stage === STAGE.PICK && <CsvStagePick onFile={handleFile} errorMsg={errorMsg} onCancel={closeModal} />}

      {stage === STAGE.CONFIGURE && (
        <CsvStageConfigure
          fileMeta={fileMeta}
          opts={opts}
          setOpt={setOpt}
          parsed={parsed}
          onNext={handleNext}
          onCancel={closeModal}
        />
      )}

      {stage === STAGE.CONFIRM && stats && (
        <StageConfirm
          fileMeta={fileMeta}
          stats={stats}
          mode={mode}
          setMode={setMode}
          errorMsg={errorMsg}
          onImport={startImport}
          onCancel={closeModal}
        />
      )}

      {stage === STAGE.IMPORTING && importProgress && (
        <StageImporting progress={importProgress} mode={mode} onCancel={() => abortRef.current?.abort()} />
      )}

      {stage === STAGE.DONE && importResult && (
        <StageDone result={importResult} mode={mode} fileMeta={fileMeta} onClose={closeModal} />
      )}
    </div>
  );
}

function CsvStagePick({ onFile, errorMsg, onCancel }) {
  const inputRef = useRef(null);
  function pick(e) {
    const f = e.target.files?.[0];
    if (f) onFile(f);
  }
  return (
    <Fragment>
      <div class="modal-field-label">Select a CSV file to insert:</div>
      <input ref={inputRef} type="file" accept=".csv,text/csv" style="display:none" onChange={pick} data-testid="csv-file-input" />
      <div class="file-input-area" onClick={() => inputRef.current?.click()}>
        <div class="file-input-label">Click to select a CSV file</div>
        <div class="file-input-info" style="margin-top:4px">Each row becomes one document in the selected collection</div>
      </div>
      {errorMsg && <div class="input-hint" style="color:var(--danger)">{errorMsg}</div>}
      <div class="modal-actions">
        <button class="btn btn-secondary" onClick={onCancel}>Cancel</button>
      </div>
    </Fragment>
  );
}

// Configure stage. Task 6 fills in the <CsvOptions> controls; for now it shows
// the live preview (default dialect) and a Next button gated on a clean parse.
function CsvStageConfigure({ fileMeta, opts, setOpt, parsed, onNext, onCancel }) {
  const canNext = parsed && !parsed.error && parsed.docs.length > 0;
  return (
    <Fragment>
      <div class="modal-count-info">
        <div style="font-family:var(--font-mono);font-size:11px;color:var(--text-secondary)">{fileMeta?.name}</div>
      </div>

      {/* CSV-OPTIONS-SLOT: Task 6 inserts <CsvOptions opts={opts} setOpt={setOpt} /> here. */}

      <CsvPreview parsed={parsed} />

      <div class="modal-actions">
        <button class="btn btn-secondary" onClick={onCancel}>Cancel</button>
        <button class="btn btn-primary" onClick={onNext} disabled={!canNext} data-testid="csv-next">Next {'→'}</button>
      </div>
    </Fragment>
  );
}

export function CsvPreview({ parsed, limit = 10 }) {
  if (!parsed) return null;
  const { columns = [], docs = [], warnings = [], error } = parsed;
  if (error) {
    return (
      <div class="csv-error" data-testid="csv-error">
        Parse error{error.line ? ` (line ${error.line})` : ''}: {error.message}
      </div>
    );
  }
  const shown = docs.slice(0, limit);
  return (
    <div class="csv-preview" data-testid="csv-preview">
      <div class="csv-preview-caption">
        Preview (first {Math.min(limit, docs.length)} of {docs.length.toLocaleString()} row{docs.length === 1 ? '' : 's'} {'·'} {columns.length} column{columns.length === 1 ? '' : 's'})
      </div>
      {docs.length === 0 ? (
        <div class="csv-preview-empty">No data rows found.</div>
      ) : (
        <div class="csv-preview-scroll">
          <table class="csv-preview-table">
            <thead><tr>{columns.map((c) => <th>{c}</th>)}</tr></thead>
            <tbody>
              {shown.map((doc) => (
                <tr>
                  {columns.map((c) => (
                    <td><PreviewValue value={doc[c]} present={Object.prototype.hasOwnProperty.call(doc, c)} /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {warnings.map((w) => <div class="csv-warning" data-testid="csv-warning">{'⚠'} {w}</div>)}
    </div>
  );
}

function PreviewValue({ value, present }) {
  if (!present) return <span class="csv-cell-missing" title="field omitted">{'—'}</span>;
  if (value === null) return <span class="csv-cell-null">null</span>;
  if (typeof value === 'number') return <span class="csv-cell-number">{String(value)}</span>;
  if (typeof value === 'boolean') return <span class="csv-cell-bool">{String(value)}</span>;
  return <span class="csv-cell-string">"{value}"</span>;
}
```

- [ ] **Step 2: Write the failing tests**

Create `tests/mdh-csv-wizard.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h, render } from 'preact';
import CsvImportWizard, { CsvPreview } from '../src/mdh/components/CsvImportWizard.jsx';

function mount(node) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(node, root);
  return root;
}

describe('CsvPreview', () => {
  it('renders typed cells: number unquoted, string quoted', () => {
    const parsed = { columns: ['name', 'age'], docs: [{ name: 'Alice', age: 30 }], warnings: [], error: null };
    const root = mount(h(CsvPreview, { parsed }));
    expect(root.querySelector('.csv-cell-number').textContent).toBe('30');
    expect(root.querySelector('.csv-cell-string').textContent).toBe('"Alice"');
  });

  it('renders null and omitted (missing) cells distinctly', () => {
    const parsed = { columns: ['a', 'b'], docs: [{ a: null }], warnings: [], error: null };
    const root = mount(h(CsvPreview, { parsed }));
    expect(root.querySelector('.csv-cell-null').textContent).toBe('null');
    expect(root.querySelector('.csv-cell-missing')).toBeTruthy(); // b is omitted
  });

  it('shows a parse error instead of a table', () => {
    const parsed = { columns: [], docs: [], warnings: [], error: { message: 'Unterminated quoted field', line: 3 } };
    const root = mount(h(CsvPreview, { parsed }));
    expect(root.querySelector('[data-testid="csv-error"]').textContent).toMatch(/line 3/);
    expect(root.querySelector('.csv-preview-table')).toBeNull();
  });

  it('renders warnings', () => {
    const parsed = { columns: ['a'], docs: [{ a: '1' }], warnings: ['2 row(s) have a different column count than the header.'], error: null };
    const root = mount(h(CsvPreview, { parsed }));
    expect(root.querySelector('[data-testid="csv-warning"]').textContent).toMatch(/column count/);
  });
});

describe('CsvImportWizard', () => {
  it('starts on the pick stage', () => {
    const root = mount(h(CsvImportWizard, { onSuccess: () => {} }));
    expect(root.textContent).toContain('Click to select a CSV file');
    expect(root.querySelector('[data-testid="csv-file-input"]').accept).toBe('.csv,text/csv');
  });
});
```

- [ ] **Step 3: Run to verify pass**

Run: `npx vitest run tests/mdh-csv-wizard.test.js`
Expected: PASS (the wizard module exists and compiles; preview rendering is correct).

> If Step 3 fails to *compile* before this point, that's the expected red state — write the component (Step 1) first, then the tests pass. (TDD note: Step 1 and Step 2 produce the red→green together because the module is brand new.)

- [ ] **Step 4: Verify build + whole suite**

Run: `npm run build && npm test`
Expected: build OK; full suite PASS.

---

## Task 6: Configure-stage option controls

Adds the dialect + conversion controls to the Configure stage. They mutate the existing `opts` state via `setOpt`, which re-runs the `useMemo(parseCsv)` and updates the preview live.

**Files:**
- Modify: `src/mdh/components/CsvImportWizard.jsx`
- Test: `tests/mdh-csv-wizard.test.js`

- [ ] **Step 1: Add the `CsvOptions` component**

In `src/mdh/components/CsvImportWizard.jsx`, add this component (e.g. above `CsvPreview`):

```jsx
const DELIMITER_PRESETS = [
  { value: ',', label: 'Comma  ,' },
  { value: ';', label: 'Semicolon  ;' },
  { value: '\t', label: 'Tab' },
  { value: '|', label: 'Pipe  |' },
];

function CsvOptions({ opts, setOpt }) {
  const presetValues = DELIMITER_PRESETS.map((p) => p.value);
  const delimiterIsCustom = !presetValues.includes(opts.delimiter);
  return (
    <div class="csv-config" data-testid="csv-options">
      <div class="csv-opt-group">
        <div class="csv-opt-group-title">Parsing</div>

        <label class="csv-opt">
          <span class="csv-opt-label">Field delimiter</span>
          <select
            data-testid="csv-delimiter"
            value={delimiterIsCustom ? '__custom__' : opts.delimiter}
            onChange={(e) => setOpt('delimiter', e.target.value === '__custom__' ? '' : e.target.value)}
          >
            {DELIMITER_PRESETS.map((p) => <option value={p.value}>{p.label}</option>)}
            <option value="__custom__">Custom…</option>
          </select>
          {delimiterIsCustom && (
            <input type="text" maxLength={1} class="csv-opt-char" value={opts.delimiter}
              onInput={(e) => setOpt('delimiter', e.target.value)} placeholder="char" />
          )}
        </label>
        <div class="csv-opt-hint">Character between fields.</div>

        <label class="csv-opt">
          <span class="csv-opt-label">Quote character</span>
          <input type="text" maxLength={1} class="csv-opt-char" value={opts.quoteChar}
            onInput={(e) => setOpt('quoteChar', e.target.value || '"')} />
        </label>
        <div class="csv-opt-hint">Wraps fields containing the delimiter, quotes, or line breaks.</div>

        <label class="csv-opt">
          <span class="csv-opt-label">Escape character</span>
          <input type="text" maxLength={1} class="csv-opt-char" value={opts.escapeChar}
            onInput={(e) => setOpt('escapeChar', e.target.value)} placeholder="(none)" />
        </label>
        <div class="csv-opt-hint">If set (e.g. \), the next character inside a quoted field is taken literally.</div>

        <label class="csv-opt csv-opt-check">
          <input type="checkbox" checked={opts.doubleQuote} onChange={(e) => setOpt('doubleQuote', e.target.checked)} />
          <span class="csv-opt-label">Double-quote</span>
        </label>
        <div class="csv-opt-hint">A doubled quote (<code>""</code>) inside a quoted field means one literal quote (RFC 4180).</div>

        <label class="csv-opt">
          <span class="csv-opt-label">Encoding</span>
          <select data-testid="csv-encoding" value={opts.encoding} onChange={(e) => setOpt('encoding', e.target.value)}>
            <option value="utf-8">UTF-8</option>
            <option value="windows-1252">Windows-1252</option>
            <option value="iso-8859-1">ISO-8859-1 (Latin-1)</option>
            <option value="utf-16le">UTF-16 LE</option>
          </select>
        </label>
        <div class="csv-opt-hint">Pick a legacy encoding if accented characters look garbled.</div>
      </div>

      <div class="csv-opt-group">
        <div class="csv-opt-group-title">Convert to JSON</div>

        <label class="csv-opt csv-opt-check">
          <input type="checkbox" data-testid="csv-header" checked={opts.hasHeader} onChange={(e) => setOpt('hasHeader', e.target.checked)} />
          <span class="csv-opt-label">First row is a header</span>
        </label>
        <div class="csv-opt-hint">Use row 1 as field names. Off → fields named column_1, column_2, …</div>

        <label class="csv-opt csv-opt-check">
          <input type="checkbox" data-testid="csv-infer" checked={opts.inferTypes} onChange={(e) => setOpt('inferTypes', e.target.checked)} />
          <span class="csv-opt-label">Infer types</span>
        </label>
        <div class="csv-opt-hint">Off → every value is a string (keeps leading zeros / IDs). On → detect numbers and true/false.</div>

        <label class="csv-opt">
          <span class="csv-opt-label">Empty cell {'→'}</span>
          <select data-testid="csv-empty" value={opts.emptyMode} onChange={(e) => setOpt('emptyMode', e.target.value)}>
            <option value="empty">Empty string ""</option>
            <option value="null">null</option>
            <option value="omit">Omit field</option>
          </select>
        </label>
        <div class="csv-opt-hint">What an empty cell becomes in the document.</div>

        <label class="csv-opt csv-opt-check">
          <input type="checkbox" checked={opts.skipEmptyLines} onChange={(e) => setOpt('skipEmptyLines', e.target.checked)} />
          <span class="csv-opt-label">Skip empty lines</span>
        </label>
        <div class="csv-opt-hint">Ignore blank lines in the file.</div>

        <label class="csv-opt csv-opt-check">
          <input type="checkbox" checked={opts.trim} onChange={(e) => setOpt('trim', e.target.checked)} />
          <span class="csv-opt-label">Trim values</span>
        </label>
        <div class="csv-opt-hint">Strip leading/trailing whitespace around each value.</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Mount `CsvOptions` in the Configure stage**

In `CsvStageConfigure`, replace the comment slot:

```jsx
      {/* CSV-OPTIONS-SLOT: Task 6 inserts <CsvOptions opts={opts} setOpt={setOpt} /> here. */}
```

with:

```jsx
      <CsvOptions opts={opts} setOpt={setOpt} />
```

- [ ] **Step 3: Add the failing interaction test**

Append to `tests/mdh-csv-wizard.test.js`:

```js
// Condition-based wait (avoids flaky fixed sleeps; the file read is async).
async function waitFor(fn, { timeout = 1500, interval = 10 } = {}) {
  const start = Date.now();
  for (;;) {
    let v;
    try { v = fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - start > timeout) return fn();
    await new Promise((r) => setTimeout(r, interval));
  }
}

describe('CsvImportWizard — configure', () => {
  it('reads a file, previews it, and re-parses when "Infer types" toggles', async () => {
    const root = mount(h(CsvImportWizard, { onSuccess: () => {} }));
    const input = root.querySelector('[data-testid="csv-file-input"]');
    const file = new File(['name,age\nAlice,30\nBob,25'], 'people.csv', { type: 'text/csv' });
    // jsdom lets us define the read-only `files` list for the test.
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));

    // Default opts: strings. age renders as a quoted string.
    await waitFor(() => root.querySelector('[data-testid="csv-preview"]'));
    expect(root.querySelector('.csv-cell-number')).toBeNull();
    expect(root.textContent).toContain('"30"');

    // Toggle "Infer types": age becomes a number.
    root.querySelector('[data-testid="csv-infer"]').click();
    await waitFor(() => root.querySelector('.csv-cell-number'));
    expect(root.querySelector('.csv-cell-number').textContent).toBe('30');

    // Next is enabled for a clean parse.
    expect(root.querySelector('[data-testid="csv-next"]').disabled).toBe(false);
  });
});
```

- [ ] **Step 4: Run the wizard tests**

Run: `npx vitest run tests/mdh-csv-wizard.test.js`
Expected: PASS — preview renders after the async read; toggling Infer types re-parses and the number cell appears.

- [ ] **Step 5: Verify build + whole suite**

Run: `npm run build && npm test`
Expected: build OK; full suite PASS.

---

## Task 7: Wire the feature into the toolbar

**Files:**
- Modify: `src/mdh/components/RecordList.jsx`
- Modify: `src/mdh/components/DataPanel.jsx`
- Modify: `src/mdh/components/DataOperations.jsx`
- Test: `tests/mdh-csv-wizard.test.js`

- [ ] **Step 1: Generalize `SplitButton` to N menu items**

In `src/mdh/components/RecordList.jsx`, replace the `SplitButton` definition (lines 194–219) with:

```jsx
function SplitButton({ label, cls, onMain, menuItems = [] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    function onMouseDown(e) {
      if (rootRef.current?.contains(e.target)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  return (
    <div ref={rootRef} class="split-btn">
      <button class={`btn btn-sm ${cls}`} onClick={onMain}>{label}</button>
      <button class={`btn btn-sm split-btn-drop ${cls}`} onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>{'▾'}</button>
      {open && (
        <div class="toolbar-more-menu">
          {menuItems.map((item) => (
            <button class="toolbar-menu-item" onClick={() => { setOpen(false); item.onClick(); }}>{item.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Update the Insert split-button caller**

In `src/mdh/components/RecordList.jsx`, replace line 260:

```jsx
        <SplitButton label="Insert" cls="btn-success" onMain={() => onRefresh('insert')} onFile={() => onRefresh('insert-file')} />
```

with:

```jsx
        <SplitButton
          label="Insert"
          cls="btn-success"
          onMain={() => onRefresh('insert')}
          menuItems={[
            { label: 'Insert from JSON file', onClick: () => onRefresh('insert-file') },
            { label: 'Insert from CSV file', onClick: () => onRefresh('insert-csv-file') },
          ]}
        />
```

- [ ] **Step 3: Handle the new action in `DataPanel`**

In `src/mdh/components/DataPanel.jsx`, in `handleToolbarAction` (lines 382–392), add a branch after the `insert-file` one:

```jsx
    } else if (action === 'insert-file') {
      openDataOperations('insert-file', invalidateAndRun, currentFields);
    } else if (action === 'insert-csv-file') {
      openDataOperations('insert-csv-file', invalidateAndRun, currentFields);
    }
```

- [ ] **Step 4: Route the mode in `DataOperations`**

In `src/mdh/components/DataOperations.jsx`:

Add the import after line 6 (`import InsertFileWizard ...`):

```jsx
import CsvImportWizard from './CsvImportWizard.jsx';
```

Replace `openDataOperations` (lines 62–77) with:

```jsx
export function openDataOperations(mode, onSuccess, fieldsFn) {
  // Bulk update/delete by filter live in BulkUpdate/BulkDelete; this dispatcher
  // now only handles insert (inline + file) and the file-driven update/replace
  // reconciliation flows.
  const isFile = mode.endsWith('-file');
  const op = mode.replace('-file', '');
  const title = op === 'insert-csv'
    ? 'Insert from CSV file'
    : op.charAt(0).toUpperCase() + op.slice(1) + (isFile ? ' from File' : '');

  openModal(title, () => {
    if (op === 'insert-csv') return <CsvImportWizard onSuccess={onSuccess} />;
    if (op === 'insert' && isFile) return <InsertFileWizard onSuccess={onSuccess} />;
    if (op === 'insert') return <InsertPanel isFile={false} onSuccess={onSuccess} fieldsFn={fieldsFn} />;
    if (op === 'update' && isFile) return <UpdatePanel onSuccess={onSuccess} fieldsFn={fieldsFn} />;
    if (op === 'replace' && isFile) return <ReplacePanel onSuccess={onSuccess} fieldsFn={fieldsFn} />;
    return null;
  });
}
```

- [ ] **Step 5: Test the split-button menu wiring**

Append to `tests/mdh-csv-wizard.test.js` a test that mounts the toolbar split button indirectly is heavy; instead assert the menu contract via a focused render of `RecordList`'s exported toolbar is not exported. Use a lightweight DOM check on `DataOperations` routing instead:

Create `tests/mdh-csv-routing.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { openDataOperations } from '../src/mdh/components/DataOperations.jsx';
import { modalContent } from '../src/mdh/store.js';

beforeEach(() => { modalContent.value = null; });

describe('openDataOperations CSV routing', () => {
  it('opens a modal titled "Insert from CSV file" for insert-csv-file', () => {
    openDataOperations('insert-csv-file', () => {}, () => []);
    expect(modalContent.value).toBeTruthy();
    expect(modalContent.value.title).toBe('Insert from CSV file');
    // render() the modal body to confirm it mounts the CSV wizard (pick stage).
    const node = modalContent.value.render();
    expect(node).toBeTruthy();
  });

  it('still opens the JSON wizard for insert-file', () => {
    openDataOperations('insert-file', () => {}, () => []);
    expect(modalContent.value.title).toBe('Insert from File');
  });
});
```

> Note: confirm `modalContent` is exported from `src/mdh/store.js` (it is — see `store.js`). If `openModal` pulls from a different signal, import that instead.

- [ ] **Step 6: Run the routing test + whole suite + build**

Run: `npx vitest run tests/mdh-csv-routing.test.js && npm run build && npm test`
Expected: routing test PASS; build OK; full suite PASS.

---

## Task 8: Configure-stage + preview styles

**Files:**
- Modify: `console.css`

- [ ] **Step 1: Find the console stylesheet and the import-wizard section**

Run: `grep -rn '\.import-wizard\|\.file-input-area\|\.import-progress' console.css src 2>/dev/null | head` to locate `console.css` (it lives at the repo root or under `src/console/`; the build copies it to `dist/console/`). Open it and find the existing import-wizard styles to place the new rules nearby.

- [ ] **Step 2: Append the `.csv-*` rules**

Add to `console.css` (using the existing CSS custom properties — `--accent`, `--danger`, `--warning`, `--surface`, `--border`, `--text-secondary`, `--font-mono` — for dark-mode parity):

```css
/* CSV import — Configure stage */
.csv-config { display: flex; gap: 16px; margin: 10px 0; }
.csv-opt-group { flex: 1; min-width: 0; }
.csv-opt-group-title {
  font-size: 11px; font-weight: 600; text-transform: uppercase;
  letter-spacing: .04em; color: var(--text-secondary); margin-bottom: 6px;
}
.csv-opt { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.csv-opt-check { cursor: pointer; }
.csv-opt-label { font-size: 13px; }
.csv-opt select, .csv-opt .csv-opt-char { margin-left: auto; }
.csv-opt-char { width: 44px; text-align: center; font-family: var(--font-mono); }
.csv-opt-hint { font-size: 11px; color: var(--text-secondary); margin: 2px 0 0 0; }

/* CSV import — live preview */
.csv-preview { margin-top: 12px; }
.csv-preview-caption { font-size: 11px; color: var(--text-secondary); margin-bottom: 4px; }
.csv-preview-empty { font-size: 13px; color: var(--text-secondary); padding: 8px 0; }
.csv-preview-scroll { max-height: 240px; overflow: auto; border: 1px solid var(--border); border-radius: 6px; }
.csv-preview-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.csv-preview-table th, .csv-preview-table td {
  text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--border); white-space: nowrap;
}
.csv-preview-table th { position: sticky; top: 0; background: var(--surface); font-family: var(--font-mono); }
.csv-cell-string { color: var(--text-primary, inherit); }
.csv-cell-number { color: var(--accent); font-family: var(--font-mono); }
.csv-cell-bool   { color: var(--accent); font-family: var(--font-mono); }
.csv-cell-null   { color: var(--text-secondary); font-style: italic; }
.csv-cell-missing { color: var(--text-secondary); }
.csv-warning { font-size: 12px; color: var(--warning); margin-top: 6px; }
.csv-error   { font-size: 13px; color: var(--danger); margin: 10px 0; }
```

> If `console.css` does not define `--text-primary`, drop that fallback (it already has `inherit`). Match the actual variable names found in Step 1; the list above are the documented semantic variables.

- [ ] **Step 3: Build and confirm the CSS ships**

Run: `npm run build`
Expected: build OK. Confirm the rules are bundled:
Run: `grep -c 'csv-preview-table' dist/console/console.css`
Expected: `1` (or more) — the styles are copied into `dist/`.

---

## Task 9: Full verification + manual smoke test

**Files:** none (verification only)

- [ ] **Step 1: Full test suite green**

Run: `npm test`
Expected: all test files PASS (including the new `mdh-csv`, `mdh-import-stages`, `mdh-csv-wizard`, `mdh-csv-routing`). Capture the summary line (`Test Files N passed`).

- [ ] **Step 2: Clean build**

Run: `npm run build`
Expected: `dist/` rebuilt with no errors.

- [ ] **Step 3: CSP sanity — no `new Function`/`eval` introduced**

Run: `grep -c 'new Function\|eval(' dist/console/console.js`
Expected: unchanged from before this work (the CSV parser is hand-rolled; it must not introduce dynamic codegen). If the count rose, investigate.

- [ ] **Step 4: Manual smoke test in Chrome**

1. Load the unpacked extension from `dist/` (chrome://extensions → Load unpacked).
2. Open a Rossum page, click the extension's Data Storage / Dataset Management entry to open the Console with a real token.
3. Select a collection. Click the **Insert ▾** split button → **Insert from CSV file**.
4. Pick a CSV with: a header row, a numeric column, a column with a leading-zero value (e.g. `01234`), an empty cell, and a value containing the delimiter inside quotes.
5. In **Configure**, verify the live preview:
   - All values are quoted strings by default; the leading-zero value is preserved.
   - Toggle **Infer types** → numbers/booleans render unquoted; the leading-zero value stays a quoted string.
   - Switch **Empty cell** between `""` / `null` / omit and watch the preview cell change (`""` → `null` → `—`).
   - Change **Field delimiter** to a wrong value → the preview collapses to one column (confirms it re-parses); set it back.
6. Click **Next** → on **Confirm**, choose Insert (or Overwrite if the CSV has an `_id` column) → **Insert**.
7. Verify the progress bar runs and **Done** reports the inserted count, then the collection refreshes and shows the new rows.
8. Confirm **Insert from JSON file** still works unchanged (regression check on the refactor).

- [ ] **Step 5: Report results**

Summarize: test suite result, build result, and the manual smoke outcome (what CSV was used, row count inserted, and that JSON insert still works). Do not claim completion without the manual smoke evidence.

---

## Self-Review (completed during planning)

- **Spec coverage:** delimiter/quote/escape/double-quote/encoding (Task 6 controls + Task 1/3 parser) ✓; header/infer/empty/skip-empty/trim (Task 2/6) ✓; `_id` passthrough + Overwrite/dedup (reused `importFile.js`, Task 5) ✓; live preview with typed values + warnings + parse-error gating (Task 5 `CsvPreview`, Task 6) ✓; 5-stage flow reusing CONFIRM/IMPORTING/DONE (Task 4 + 5) ✓; toolbar entry (Task 7) ✓; styles (Task 8) ✓; tests for tokenizer/conversion/decode/parse/stages/preview/routing (Tasks 1–7) ✓.
- **Type consistency:** `parseCsv` returns `{ docs, columns, warnings, error }` everywhere it's consumed (`useMemo` in wizard, `CsvPreview` props, tests). Option keys (`delimiter`, `quoteChar`, `escapeChar`, `doubleQuote`, `encoding`, `hasHeader`, `inferTypes`, `emptyMode`, `skipEmptyLines`, `trim`) are identical across `DEFAULT_OPTS`, `CsvOptions`, and `parseCsv`. `escapeChar: ''` (UI) is normalized to `null` (parser) at the single `useMemo` call site. Stage prop shapes (`StageConfirm`/`StageImporting`/`StageDone`) match the JSON wizard's existing call sites verbatim.
- **Placeholders:** none — every code step is complete.
- **Non-goals respected:** no XLSX, no MDH Datasets API, no streaming, no column remap UI.
