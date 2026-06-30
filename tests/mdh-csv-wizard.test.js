// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h, render } from 'preact';
import CsvImportWizard, { CsvPreview, Segmented, Toggle } from '../src/mdh/components/CsvImportWizard.jsx';

function mount(node) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(node, root);
  return root;
}

describe('CsvPreview', () => {
  it('renders typed cells: number unquoted, string as plain text (no surrounding quotes)', () => {
    const parsed = { columns: ['name', 'age'], docs: [{ name: 'Alice', age: 30 }], warnings: [], error: null };
    const root = mount(h(CsvPreview, { parsed }));
    expect(root.querySelector('.csv-cell-number').textContent).toBe('30');
    expect(root.querySelector('.csv-cell-string').textContent).toBe('Alice');
  });

  it('renders an empty string as a muted (empty) marker, not a blank cell', () => {
    const parsed = { columns: ['note'], docs: [{ note: '' }], warnings: [], error: null };
    const root = mount(h(CsvPreview, { parsed }));
    const cell = root.querySelector('.csv-cell-empty');
    expect(cell).toBeTruthy();
    expect(cell.textContent).toBe('(empty)');
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

// Condition-based wait (avoids flaky fixed sleeps; the file read is async).
async function waitFor(fn, { timeout = 1500, interval = 10 } = {}) {
  const start = Date.now();
  for (;;) {
    let v;
    try { v = fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`waitFor timed out after ${timeout}ms`);
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

    // Default opts: every value is a string, shown as plain text (no surrounding quotes).
    await waitFor(() => root.querySelector('[data-testid="csv-preview"]'));
    expect(root.querySelector('.csv-cell-number')).toBeNull();
    expect(root.textContent).not.toContain('"30"');
    expect([...root.querySelectorAll('.csv-cell-string')].map((s) => s.textContent)).toContain('30');

    // Toggle "Infer types": age becomes a number.
    root.querySelector('[data-testid="csv-infer"]').click();
    await waitFor(() => root.querySelector('.csv-cell-number'));
    expect(root.querySelector('.csv-cell-number').textContent).toBe('30');

    // Next is enabled for a clean parse.
    expect(root.querySelector('[data-testid="csv-next"]').disabled).toBe(false);
  });
});

describe('Segmented', () => {
  it('marks the active option and reports clicks', () => {
    const picked = [];
    const opts = [
      { value: 'a', label: 'A', testid: 'seg-a' },
      { value: 'b', label: 'B', testid: 'seg-b' },
    ];
    const root = mount(h(Segmented, { value: 'a', options: opts, onChange: (v) => picked.push(v) }));
    const a = root.querySelector('[data-testid="seg-a"]');
    const b = root.querySelector('[data-testid="seg-b"]');
    expect(a.classList.contains('on')).toBe(true);
    expect(b.classList.contains('on')).toBe(false);
    b.click();
    expect(picked).toEqual(['b']);
  });
});

describe('Toggle', () => {
  it('renders a switch and flips on click', () => {
    let val = false;
    const root = mount(h(Toggle, { checked: false, onChange: (v) => { val = v; }, testid: 'tg' }));
    const btn = root.querySelector('[data-testid="tg"]');
    expect(btn.getAttribute('role')).toBe('switch');
    expect(btn.getAttribute('aria-checked')).toBe('false');
    btn.click();
    expect(val).toBe(true);
  });
});

describe('CsvImportWizard — toolbar & advanced', () => {
  async function loadFile(root, text, name = 't.csv') {
    const input = root.querySelector('[data-testid="csv-file-input"]');
    const file = new File([text], name, { type: 'text/csv' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => root.querySelector('[data-testid="csv-preview"]'));
  }

  it('keeps the Advanced options collapsed until the disclosure is clicked', async () => {
    const root = mount(h(CsvImportWizard, { onSuccess: () => {} }));
    await loadFile(root, 'name,age\nAlice,30');
    // Empty-cell control lives in Advanced — absent while collapsed.
    expect(root.querySelector('[data-testid="csv-empty"]')).toBeNull();
    root.querySelector('[data-testid="csv-advanced-toggle"]').click();
    await waitFor(() => root.querySelector('[data-testid="csv-empty"]'));
    expect(root.querySelector('[data-testid="csv-empty"]')).toBeTruthy();
  });

  it('changes the parse when a different delimiter pill is clicked', async () => {
    const root = mount(h(CsvImportWizard, { onSuccess: () => {} }));
    // Semicolon-delimited; with the default comma delimiter this is one column.
    await loadFile(root, 'a;b;c\n1;2;3');
    expect(root.querySelectorAll('.csv-preview-table th').length).toBe(1);
    root.querySelector('[data-testid="csv-delim-semicolon"]').click();
    await waitFor(() => root.querySelectorAll('.csv-preview-table th').length === 3);
    expect(root.querySelectorAll('.csv-preview-table th').length).toBe(3);
  });

  it('offers only comma / semicolon / tab delimiters (no pipe, no custom)', async () => {
    const root = mount(h(CsvImportWizard, { onSuccess: () => {} }));
    await loadFile(root, 'a,b\n1,2');
    expect(root.querySelector('[data-testid="csv-delim-comma"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="csv-delim-semicolon"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="csv-delim-tab"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="csv-delim-pipe"]')).toBeNull();
    expect(root.querySelector('[data-testid="csv-delim-custom"]')).toBeNull();
    expect(root.querySelector('[data-testid="csv-delim-input"]')).toBeNull();
  });
});

describe('CsvImportWizard — meta bar', () => {
  it('shows the row count and a formatted file size', async () => {
    const root = mount(h(CsvImportWizard, { onSuccess: () => {} }));
    const input = root.querySelector('[data-testid="csv-file-input"]');
    const file = new File(['name,age\nAlice,30\nBob,25'], 'people.csv', { type: 'text/csv' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => root.querySelector('[data-testid="csv-meta"]'));
    const meta = root.querySelector('[data-testid="csv-meta"]').textContent;
    expect(meta).toContain('people.csv');
    expect(meta).toMatch(/\b2\b/);          // 2 data rows
    expect(meta).toMatch(/\d+\s?(B|KB)/);   // a formatted size token
  });
});

describe('CsvPreview — legend', () => {
  it('renders a type legend in the caption', () => {
    const parsed = { columns: ['a'], docs: [{ a: '1' }], warnings: [], error: null };
    const root = mount(h(CsvPreview, { parsed }));
    expect(root.querySelector('.csv-preview-legend')).toBeTruthy();
  });
});

describe('CsvImportWizard — trimmed Advanced options', () => {
  async function openAdvanced(root) {
    const input = root.querySelector('[data-testid="csv-file-input"]');
    const file = new File(['a,b\n1,2'], 't.csv', { type: 'text/csv' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => root.querySelector('[data-testid="csv-preview"]'));
    root.querySelector('[data-testid="csv-advanced-toggle"]').click();
  }

  it('Advanced no longer offers Quote / Escape / Double-quote / Skip-empty-lines', async () => {
    const root = mount(h(CsvImportWizard, { onSuccess: () => {} }));
    await openAdvanced(root);
    const adv = root.querySelector('[data-testid="csv-advanced"]');
    expect(adv).toBeTruthy();
    expect(adv.textContent).not.toMatch(/Quote/);        // removes Quote AND Double-quote
    expect(adv.textContent).not.toMatch(/Escape/);
    expect(adv.textContent).not.toMatch(/Skip empty/);
    expect(root.querySelector('[data-testid="csv-doublequote"]')).toBeNull();
    expect(root.querySelector('[data-testid="csv-skipempty"]')).toBeNull();
  });

  it('Advanced keeps Encoding / Empty-cell / Trim', async () => {
    const root = mount(h(CsvImportWizard, { onSuccess: () => {} }));
    await openAdvanced(root);
    expect(root.querySelector('[data-testid="csv-encoding"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="csv-empty"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="csv-trim"]')).toBeTruthy();
  });
});

import { CsvPreview as CsvPreviewForDates } from '../src/mdh/components/CsvImportWizard.jsx';

describe('CsvPreview renders EJSON object values (e.g. Excel date cells)', () => {
  it('shows an EJSON {$date} as its ISO string, not a blank cell', () => {
    const root = document.createElement('div');
    render(h(CsvPreviewForDates, { parsed: { columns: ['joined'], docs: [{ joined: { $date: '2024-01-01T00:00:00.000Z' } }], warnings: [] } }), root);
    expect(root.querySelector('tbody td').textContent).toContain('2024-01-01T00:00:00.000Z');
  });
  it('shows an EJSON {$oid} as its hex string', () => {
    const root = document.createElement('div');
    render(h(CsvPreviewForDates, { parsed: { columns: ['_id'], docs: [{ _id: { $oid: 'abc123' } }], warnings: [] } }), root);
    expect(root.querySelector('tbody td').textContent).toBe('abc123');
  });
});
