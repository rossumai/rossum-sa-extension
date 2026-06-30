// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h, render } from 'preact';
import FileDropArea, {
  allowedExtensions,
  formatExpected,
  extensionMatches,
} from '../src/mdh/components/FileDropArea.jsx';
import Modal, { openModal, closeModal } from '../src/mdh/components/Modal.jsx';
import CsvImportWizard from '../src/mdh/components/CsvImportWizard.jsx';
import InsertFileWizard from '../src/mdh/components/InsertFileWizard.jsx';
import { FileInput } from '../src/mdh/components/DataOperations.jsx';

function mount(node) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(node, root);
  return root;
}

// jsdom's Event has no dataTransfer, so we attach one. `cancelable: true`
// lets preventDefault register on event.defaultPrevented.
function dragEvent(type, { files = [], types = ['Files'] } = {}) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', {
    value: { files, types, dropEffect: 'none' },
    configurable: true,
  });
  return ev;
}

async function waitFor(fn, { timeout = 1000, interval = 10 } = {}) {
  const start = Date.now();
  for (;;) {
    let v;
    try { v = fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`waitFor timed out`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

describe('FileDropArea helpers', () => {
  it('allowedExtensions keeps only the dotted tokens, lowercased', () => {
    expect(allowedExtensions('.csv,text/csv')).toEqual(['.csv']);
    expect(allowedExtensions('.jsonl,.ndjson,application/x-ndjson'))
      .toEqual(['.jsonl', '.ndjson']);
    expect(allowedExtensions('.XML,text/xml')).toEqual(['.xml']);
  });

  it('formatExpected reads naturally for 1, 2, and 3+ extensions', () => {
    expect(formatExpected(['.json'])).toBe('Expected a .json file');
    expect(formatExpected(['.jsonl', '.ndjson']))
      .toBe('Expected a .jsonl or .ndjson file');
    expect(formatExpected(['.a', '.b', '.c']))
      .toBe('Expected a .a, .b, or .c file');
  });

  it('extensionMatches is case-insensitive and permissive when no exts', () => {
    expect(extensionMatches('Data.CSV', ['.csv'])).toBe(true);
    expect(extensionMatches('data.txt', ['.csv'])).toBe(false);
    expect(extensionMatches('whatever', [])).toBe(true);
  });
});

describe('FileDropArea component', () => {
  it('drops a matching file → onFile, and prevents the browser default', () => {
    let got = null;
    const root = mount(h(FileDropArea, {
      accept: '.csv,text/csv', onFile: (f) => { got = f; }, onReject: () => {},
    }, h('div', { class: 'file-input-label' }, 'Click to select a CSV file')));
    const area = root.querySelector('.file-input-area');
    const file = new File(['a,b\n1,2'], 'data.csv', { type: 'text/csv' });
    const ev = dragEvent('drop', { files: [file] });
    area.dispatchEvent(ev);
    expect(got).toBe(file);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('drops a wrong-extension file → onReject, not onFile', () => {
    let got = null; let rejected = null;
    const root = mount(h(FileDropArea, {
      accept: '.csv,text/csv', onFile: (f) => { got = f; }, onReject: (m) => { rejected = m; },
    }, h('div', null, 'pick')));
    const area = root.querySelector('.file-input-area');
    const file = new File(['x'], 'notes.txt', { type: 'text/plain' });
    area.dispatchEvent(dragEvent('drop', { files: [file] }));
    expect(got).toBeNull();
    expect(rejected).toBe('Expected a .csv file');
  });

  it('highlights on dragenter (Files) and clears on dragleave', async () => {
    const root = mount(h(FileDropArea, { accept: '.csv', onFile: () => {} }, h('div', null, 'pick')));
    const area = root.querySelector('.file-input-area');
    area.dispatchEvent(dragEvent('dragenter', { files: [] }));
    await waitFor(() => area.classList.contains('drag-over'));
    area.dispatchEvent(dragEvent('dragleave'));
    await waitFor(() => !area.classList.contains('drag-over'));
    expect(area.classList.contains('drag-over')).toBe(false);
  });

  it('ignores a drag that carries no files (e.g. dragging page content)', async () => {
    const root = mount(h(FileDropArea, { accept: '.csv', onFile: () => {} }, h('div', null, 'pick')));
    const area = root.querySelector('.file-input-area');
    area.dispatchEvent(dragEvent('dragenter', { types: ['text/plain'] }));
    await new Promise((r) => setTimeout(r, 40));
    expect(area.classList.contains('drag-over')).toBe(false);
  });

  it('click path forwards the file WITHOUT extension validation (back-compat)', () => {
    let got = null;
    const root = mount(h(FileDropArea, { accept: '.csv,text/csv', onFile: (f) => { got = f; } }, h('div', null, 'pick')));
    const input = root.querySelector('input[type="file"]');
    const file = new File(['x'], 'forced.txt', { type: 'text/plain' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(got).toBe(file); // accepted despite .txt — click path is unchanged
  });

  it('forwards inputTestid, and omits data-testid when not given', () => {
    const a = mount(h(FileDropArea, { accept: '.csv', onFile: () => {}, inputTestid: 'demo-input' }, h('div', null, 'p')));
    expect(a.querySelector('[data-testid="demo-input"]')).toBeTruthy();
    const b = mount(h(FileDropArea, { accept: '.csv', onFile: () => {} }, h('div', null, 'p')));
    expect(b.querySelector('input[type="file"]').hasAttribute('data-testid')).toBe(false);
  });
});

describe('Modal overlay mis-drop guard', () => {
  it('swallows a file drop on the overlay so the browser never opens the file', () => {
    openModal('Drag test', () => h('div', { class: 'inner' }, 'body'));
    const root = mount(h(Modal, null));
    const overlay = root.querySelector('.modal-overlay');
    expect(overlay).toBeTruthy();
    const ev = dragEvent('drop', { files: [], types: ['Files'] });
    overlay.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    closeModal();
  });
});

describe('Import wizards accept dropped files', () => {
  it('CSV wizard: dropping a .csv advances past the pick stage', async () => {
    const root = mount(h(CsvImportWizard, { onSuccess: () => {} }));
    const area = root.querySelector('.file-input-area');
    const file = new File(['name,age\nAlice,30'], 'people.csv', { type: 'text/csv' });
    area.dispatchEvent(dragEvent('drop', { files: [file] }));
    // Configure stage shows the CSV options panel once the file is read.
    await waitFor(() => root.querySelector('[data-testid="csv-options"]'));
    expect(root.querySelector('[data-testid="csv-options"]')).toBeTruthy();
  });

  it('JSON wizard: dropping a wrong-type file shows a friendly rejection', async () => {
    const root = mount(h(InsertFileWizard, { onSuccess: () => {}, format: 'json' }));
    const area = root.querySelector('.file-input-area');
    const file = new File(['<svg/>'], 'logo.png', { type: 'image/png' });
    area.dispatchEvent(dragEvent('drop', { files: [file] }));
    await waitFor(() => root.querySelector('.input-hint'));
    expect(root.querySelector('.input-hint').textContent).toContain('Expected a .json file');
  });
});

describe('Update/Replace FileInput drop support', () => {
  it('drops a .json file → onParsed gets the documents', async () => {
    let docs = null;
    const root = mount(h(FileInput, { onParsed: (d) => { docs = d; } }));
    const area = root.querySelector('.file-input-area');
    const file = new File(['[{"a":1},{"a":2}]'], 'rows.json', { type: 'application/json' });
    area.dispatchEvent(dragEvent('drop', { files: [file] }));
    await waitFor(() => docs !== null);
    expect(docs).toHaveLength(2);
    expect(root.textContent).toContain('2 documents');
  });

  it('drops a wrong-type file → friendly error, onParsed not called with docs', async () => {
    let docs = null;
    const root = mount(h(FileInput, { onParsed: (d) => { docs = d; } }));
    const area = root.querySelector('.file-input-area');
    const file = new File(['x'], 'data.csv', { type: 'text/csv' });
    area.dispatchEvent(dragEvent('drop', { files: [file] }));
    await waitFor(() => root.querySelector('.input-hint'));
    expect(root.querySelector('.input-hint').textContent).toContain('Expected a .json file');
    expect(docs).toBeNull();
  });
});
