// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h, render } from 'preact';
import { readFileSync } from 'node:fs';
// Use node:url's URL/fileURLToPath, not jsdom's global URL — under the jsdom test
// environment the global URL resolves the relative path against the jsdom location
// (http://localhost:3000/) instead of import.meta.url's file:// URL, which would
// make fileURLToPath throw "The URL must be of scheme file".
import { fileURLToPath, URL as NodeURL } from 'node:url';
import XlsxImportWizard from '../src/mdh/components/XlsxImportWizard.jsx';

function mount(node) { const root = document.createElement('div'); document.body.appendChild(root); render(node, root); return root; }
async function waitFor(fn, { timeout = 2000, interval = 10 } = {}) {
  const start = Date.now();
  for (;;) { let v; try { v = fn(); } catch { v = null; } if (v) return v; if (Date.now() - start > timeout) throw new Error('waitFor timed out'); await new Promise((r) => setTimeout(r, interval)); }
}
function fixtureFile() {
  const p = fileURLToPath(new NodeURL('./fixtures/sample.xlsx', import.meta.url));
  const bytes = readFileSync(p);
  const file = new File([bytes], 'sample.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  // jsdom's File.arrayBuffer may be absent; guarantee it returns the fixture bytes.
  file.arrayBuffer = async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return file;
}

describe('XlsxImportWizard', () => {
  it('starts on the pick stage with a beta tag and accepts .xlsx', () => {
    const root = mount(h(XlsxImportWizard, { onSuccess: () => {} }));
    expect(root.textContent).toContain('Click to select an Excel');
    expect(root.querySelector('.toolbar-menu-beta')).toBeTruthy();           // beta marking
    expect(root.querySelector('[data-testid="xlsx-file-input"]').accept).toBe('.xlsx');
  });

  it('reads a file, shows the async preview, and offers a sheet picker', async () => {
    const root = mount(h(XlsxImportWizard, { onSuccess: () => {} }));
    const input = root.querySelector('[data-testid="xlsx-file-input"]');
    Object.defineProperty(input, 'files', { value: [fixtureFile()], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));

    await waitFor(() => root.querySelector('[data-testid="csv-preview"]'));   // shared preview renders
    expect(root.textContent).toContain('Alice');
    expect(root.querySelector('[data-testid="xlsx-sheet"]')).toBeTruthy();    // >1 sheet → picker
    expect(root.querySelector('[data-testid="xlsx-next"]').disabled).toBe(false);
    expect(root.querySelector('.toolbar-menu-beta')).toBeTruthy();            // beta tag in configure too
  });
});

import { h as hh } from 'preact';

describe('toolbar menu beta badge', () => {
  it('renders a beta badge only for items flagged beta', () => {
    // Mirror the renderer used in RecordList's split-button menu.
    const Item = ({ item }) => hh('button', { class: 'toolbar-menu-item' },
      item.label, item.beta ? hh('span', { class: 'toolbar-menu-beta' }, 'beta') : null);
    const root = document.createElement('div');
    render(hh('div', null,
      hh(Item, { item: { label: 'From CSV file' } }),
      hh(Item, { item: { label: 'From Excel file', beta: true } })), root);
    const badges = root.querySelectorAll('.toolbar-menu-beta');
    expect(badges.length).toBe(1);
    expect(badges[0].textContent).toBe('beta');
    expect(root.textContent).toContain('From Excel file');
  });
});

describe('XlsxImportWizard parity options', () => {
  it('exposes an empty-string option, a Trim toggle, and drops the serial-number hint', async () => {
    const root = mount(h(XlsxImportWizard, { onSuccess: () => {} }));
    const input = root.querySelector('[data-testid="xlsx-file-input"]');
    Object.defineProperty(input, 'files', { value: [fixtureFile()], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));

    await waitFor(() => root.querySelector('[data-testid="csv-preview"]'));   // CONFIGURE stage

    const empty = root.querySelector('[data-testid="xlsx-empty"]');
    expect(empty).toBeTruthy();
    expect(empty.textContent).toContain('""');                                // empty-string option
    expect(root.querySelector('[data-testid="xlsx-trim"]')).toBeTruthy();     // Trim toggle
    expect(root.textContent.toLowerCase()).not.toContain('serial number');    // stale hint removed
  });
});
