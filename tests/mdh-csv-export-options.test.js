// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';
import { modalContent } from '../src/mdh/store.js';
import CsvExportOptions from '../src/mdh/components/CsvExportOptions.jsx';

function mount(node) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(node, root);
  return root;
}
beforeEach(() => { document.body.innerHTML = ''; modalContent.value = { title: 'x', render: () => null }; });

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('CsvExportOptions', () => {
  it('renders delimiter / header / BOM with defaults and downloads the chosen options', () => {
    const onDownload = vi.fn();
    const root = mount(h(CsvExportOptions, { onDownload }));
    expect(root.querySelector('[data-testid="csv-export-download"]')).toBeTruthy();
    root.querySelector('[data-testid="csv-export-download"]').click();
    expect(onDownload).toHaveBeenCalledWith({ delimiter: ',', header: true, bom: true });
  });

  it('reflects changed options', async () => {
    const onDownload = vi.fn();
    const root = mount(h(CsvExportOptions, { onDownload }));
    root.querySelector('[data-testid="csv-export-delim-semicolon"]').click();
    await flush();
    root.querySelector('[data-testid="csv-export-header"]').click();   // header -> false
    await flush();
    root.querySelector('[data-testid="csv-export-download"]').click();
    expect(onDownload).toHaveBeenCalledWith({ delimiter: ';', header: false, bom: true });
  });
});
