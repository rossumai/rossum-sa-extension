// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';
import { modalContent } from '../src/mdh/store.js';
import XlsxExportOptions from '../src/mdh/components/XlsxExportOptions.jsx';

function mount(node) { const root = document.createElement('div'); document.body.appendChild(root); render(node, root); return root; }
beforeEach(() => { document.body.innerHTML = ''; modalContent.value = { title: 'x', render: () => null }; });
async function waitFor(fn, timeout = 1000) {
  const start = Date.now();
  for (;;) { let v; try { v = fn(); } catch { v = null; } if (v) return v; if (Date.now() - start > timeout) throw new Error('waitFor timed out'); await new Promise((r) => setTimeout(r, 5)); }
}

const SAMPLE = {
  columns: ['_id', 'active', 'name'],
  sample: [
    { _id: 'V001', active: true, name: 'Acme' },
    { _id: 'V002', active: false, name: 'Globe' },
  ],
};

describe('XlsxExportOptions', () => {
  it('renders a grid preview (columns + sample rows)', async () => {
    const root = mount(h(XlsxExportOptions, { loadPreview: async () => SAMPLE, onDownload: vi.fn() }));
    await waitFor(() => root.querySelector('.csv-preview-table'));
    const headers = [...root.querySelectorAll('thead th')].map((th) => th.textContent);
    expect(headers).toEqual(['_id', 'active', 'name']);
    expect(root.textContent).toContain('V001');
  });

  it('reflects the header-row toggle in the preview', async () => {
    const root = mount(h(XlsxExportOptions, { loadPreview: async () => SAMPLE, onDownload: vi.fn() }));
    await waitFor(() => root.querySelector('.csv-preview-table'));
    // header ON (default) → field-name header row shown
    expect(root.querySelector('.csv-preview-table thead')).not.toBeNull();
    expect([...root.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(['_id', 'active', 'name']);
    // toggle header OFF → field-name row disappears, data still shown
    root.querySelector('[data-testid="xlsx-export-header"]').click();
    await waitFor(() => root.querySelector('.csv-preview-table thead') === null);
    expect(root.textContent).toContain('V001');
  });

  it('hands the sheet name, header flag and discovered columns back on Download', async () => {
    const onDownload = vi.fn();
    const root = mount(h(XlsxExportOptions, { loadPreview: async () => SAMPLE, onDownload }));
    await waitFor(() => root.querySelector('.csv-preview-table')); // preview loaded → columns discovered
    const input = root.querySelector('[data-testid="xlsx-export-sheet"]');
    input.value = 'Vendors';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => root.querySelector('[data-testid="xlsx-export-sheet"]').value === 'Vendors'); // re-render committed
    root.querySelector('[data-testid="xlsx-export-download"]').click();
    expect(onDownload).toHaveBeenCalledWith({ sheetName: 'Vendors', header: true, columns: ['_id', 'active', 'name'] });
  });
});
