// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';
import { modalContent } from '../src/mdh/store.js';
import CsvExportOptions from '../src/mdh/components/CsvExportOptions.jsx';

function mount(node) { const root = document.createElement('div'); document.body.appendChild(root); render(node, root); return root; }
beforeEach(() => { document.body.innerHTML = ''; modalContent.value = { title: 'x', render: () => null }; });
const flush = () => new Promise((r) => setTimeout(r, 0));
async function waitFor(fn, timeout = 1000) {
  const start = Date.now();
  for (;;) { let v; try { v = fn(); } catch { v = null; } if (v) return v; if (Date.now() - start > timeout) throw new Error('waitFor timed out'); await new Promise((r) => setTimeout(r, 5)); }
}

const SAMPLE = {
  columns: ['_id', 'active', 'name'],
  sample: [
    { _id: 'V001', active: true, name: 'ACME s.r.o.' },
    { _id: 'V002', active: false, name: 'Globex' },
  ],
};

describe('CsvExportOptions', () => {
  it('renders a CSV-text preview (header + rows) and has no BOM control', async () => {
    const root = mount(h(CsvExportOptions, { loadPreview: async () => SAMPLE, onDownload: vi.fn() }));
    await waitFor(() => root.querySelector('.csv-export-preview-text'));
    const text = root.querySelector('.csv-export-preview-text').textContent;
    expect(text).toContain('_id,active,name');        // header row
    expect(text).toContain('V001,true,ACME s.r.o.');  // first data row
    expect(root.querySelector('[data-testid="csv-export-bom"]')).toBeNull(); // BOM control removed
  });

  it('re-renders the preview when the delimiter changes', async () => {
    const root = mount(h(CsvExportOptions, { loadPreview: async () => SAMPLE, onDownload: vi.fn() }));
    await waitFor(() => root.querySelector('.csv-export-preview-text'));
    root.querySelector('[data-testid="csv-export-delim-semicolon"]').click();
    await flush();
    expect(root.querySelector('.csv-export-preview-text').textContent).toContain('_id;active;name');
  });

  it('Download passes delimiter, header, and the discovered columns', async () => {
    const onDownload = vi.fn();
    const root = mount(h(CsvExportOptions, { loadPreview: async () => SAMPLE, onDownload }));
    await waitFor(() => root.querySelector('.csv-export-preview-text'));
    root.querySelector('[data-testid="csv-export-download"]').click();
    expect(onDownload).toHaveBeenCalledWith({ delimiter: ',', header: true, columns: ['_id', 'active', 'name'] });
  });

  it('on preview failure shows a note and Download passes columns: null', async () => {
    const onDownload = vi.fn();
    const root = mount(h(CsvExportOptions, { loadPreview: async () => { throw new Error('boom'); }, onDownload }));
    await waitFor(() => root.querySelector('.csv-export-preview').textContent.includes('unavailable') || null);
    expect(root.querySelector('.csv-export-preview-note')).toBeTruthy();
    expect(root.querySelector('.csv-export-preview').textContent).toContain('unavailable');
    root.querySelector('[data-testid="csv-export-download"]').click();
    expect(onDownload).toHaveBeenCalledWith({ delimiter: ',', header: true, columns: null });
  });
});
