// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h, render } from 'preact';
import XmlImportWizard from '../src/mdh/components/XmlImportWizard.jsx';

function mount(node) { const root = document.createElement('div'); document.body.appendChild(root); render(node, root); return root; }
async function waitFor(fn, { timeout = 2000, interval = 10 } = {}) {
  const start = Date.now();
  for (;;) { let v; try { v = fn(); } catch { v = null; } if (v) return v; if (Date.now() - start > timeout) throw new Error('waitFor timed out'); await new Promise((r) => setTimeout(r, interval)); }
}
function xmlFile(str) {
  const f = new File([str], 'data.xml', { type: 'application/xml' });
  f.text = async () => str; // jsdom File.text() may be absent
  return f;
}
const XML = `<Invoices><Invoice id="A1"><Vendor>ACME</Vendor></Invoice><Invoice id="A2"><Vendor>Globex</Vendor></Invoice></Invoices>`;

describe('XmlImportWizard', () => {
  it('starts on the pick stage with a beta tag and accepts .xml', () => {
    const root = mount(h(XmlImportWizard, { onSuccess: () => {} }));
    expect(root.textContent).toContain('Click to select an XML');
    expect(root.querySelector('.toolbar-menu-beta')).toBeTruthy();
    expect(root.querySelector('[data-testid="xml-file-input"]').accept).toContain('.xml');
  });

  it('reads a flat record-list and shows the preview with no (redundant) picker', async () => {
    const root = mount(h(XmlImportWizard, { onSuccess: () => {} }));
    const input = root.querySelector('[data-testid="xml-file-input"]');
    Object.defineProperty(input, 'files', { value: [xmlFile(XML)], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => root.querySelector('[data-testid="xml-preview"]'));
    const json = root.querySelector('[data-testid="xml-preview-json"]');     // the actual JSON, not a tree widget
    expect(json).toBeTruthy();
    expect(json.textContent).toContain('"Vendor": "ACME"');                  // formatted JSON of the parsed document
    expect(root.querySelector('[data-testid="xml-record"]')).toBeNull(); // single candidate → no picker
    expect(root.querySelector('[data-testid="xml-next"]').disabled).toBe(false);
    expect(root.querySelector('.toolbar-menu-beta')).toBeTruthy();
  });

  it('offers a working record-element picker only when the XML has >1 candidate', async () => {
    const MULTI = `<root><a><x>1</x></a><b><y>2</y></b><a><x>3</x></a></root>`;
    const root = mount(h(XmlImportWizard, { onSuccess: () => {} }));
    const input = root.querySelector('[data-testid="xml-file-input"]');
    Object.defineProperty(input, 'files', { value: [xmlFile(MULTI)], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const sel = await waitFor(() => root.querySelector('[data-testid="xml-record"]'));
    expect(sel.querySelectorAll('option').length).toBe(2);      // <a> (×2) and top-level (×3)
    // each option resolves to a different record count → switching actually changes the preview
    const labels = [...sel.querySelectorAll('option')].map((o) => o.textContent);
    expect(labels.some((l) => /×2/.test(l))).toBe(true);
    expect(labels.some((l) => /×3/.test(l))).toBe(true);
  });
});

import { modalContent } from '../src/mdh/store.js';
import XmlExportOptions from '../src/mdh/components/XmlExportOptions.jsx';
import DownloadSplitButton from '../src/mdh/components/DownloadSplitButton.jsx';
import { vi, beforeEach } from 'vitest';

describe('XmlExportOptions', () => {
  beforeEach(() => { document.body.innerHTML = ''; modalContent.value = { title: 'x', render: () => null }; });
  const SAMPLE = { sample: [{ _id: 'A1', Vendor: 'ACME' }] };
  it('renders a live XML preview and Download passes the element names', async () => {
    const onDownload = vi.fn();
    const root = mount(h(XmlExportOptions, { loadPreview: async () => SAMPLE, onDownload }));
    await waitFor(() => root.querySelector('.csv-export-preview-text'));
    const text = root.querySelector('.csv-export-preview-text').textContent;
    expect(text).toContain('<records>');
    expect(text).toContain('<record><_id>A1</_id><Vendor>ACME</Vendor></record>');
    expect(root.querySelector('.toolbar-menu-beta')).toBeTruthy();
    root.querySelector('[data-testid="xml-export-download"]').click();
    expect(onDownload).toHaveBeenCalledWith({ rootName: 'records', recordName: 'record' });
  });
});

describe('DownloadSplitButton — XML option', () => {
  it('offers an XML format alongside JSON and CSV', async () => {
    const onAllXml = vi.fn();
    const root = mount(h(DownloadSplitButton, { onAllJson(){}, onFilteredJson(){}, onAllCsv(){}, onFilteredCsv(){}, onAllXml, onFilteredXml(){} }));
    root.querySelector('button').click();                       // open menu
    await waitFor(() => root.querySelector('[data-testid="download-all"]'));
    root.querySelector('[data-testid="download-all"]').click(); // open flyout
    const xml = await waitFor(() => root.querySelector('[data-testid="download-all-xml"]'));
    expect(xml).toBeTruthy();
    xml.click();
    expect(onAllXml).toHaveBeenCalled();
  });
});
