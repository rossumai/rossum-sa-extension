// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h, render } from 'preact';
import InsertFileWizard from '../src/mdh/components/InsertFileWizard.jsx';

function mount(node) { const root = document.createElement('div'); document.body.appendChild(root); render(node, root); return root; }
async function waitFor(fn, { timeout = 2000, interval = 10 } = {}) {
  const start = Date.now();
  for (;;) { let v; try { v = fn(); } catch { v = null; } if (v) return v; if (Date.now() - start > timeout) throw new Error('waitFor timed out'); await new Promise((r) => setTimeout(r, interval)); }
}
function file(str, name = 'data.json') { const f = new File([str], name, { type: 'application/json' }); f.text = async () => str; return f; }
function load(root, f) {
  const input = root.querySelector('input[type="file"]');
  Object.defineProperty(input, 'files', { value: [f], configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('InsertFileWizard — JSON + JSONL', () => {
  it('still imports a JSON array (unchanged)', async () => {
    const root = mount(h(InsertFileWizard, { onSuccess: () => {} }));
    load(root, file('[{"_id":"1","a":1},{"_id":"2","a":2}]'));
    await waitFor(() => root.querySelector('.import-mode-group')); // reached CONFIRM
    expect(root.querySelector('[data-testid="import-warnings"]')).toBeNull();
  });
  it('still imports a single JSON object', async () => {
    const root = mount(h(InsertFileWizard, { onSuccess: () => {} }));
    load(root, file('{"_id":"1","a":1}'));
    await waitFor(() => root.querySelector('.import-mode-group'));
  });
  it('now imports an NDJSON file (was a parse error before)', async () => {
    const root = mount(h(InsertFileWizard, { onSuccess: () => {} }));
    load(root, file('{"_id":"1","a":1}\n{"_id":"2","a":2}\n{"_id":"3","a":3}', 'data.jsonl'));
    await waitFor(() => root.querySelector('.import-mode-group'));
  });
  it('shows skipped-line warnings on confirm and still proceeds', async () => {
    const root = mount(h(InsertFileWizard, { onSuccess: () => {} }));
    load(root, file('{"_id":"1","a":1}\ngarbage\n{"_id":"2","a":2}', 'data.jsonl'));
    await waitFor(() => root.querySelector('.import-mode-group'));
    const warn = root.querySelector('[data-testid="import-warnings"]');
    expect(warn).toBeTruthy();
    expect(warn.textContent).toMatch(/Line 2/);
  });
  it('the JSONL entry (format="jsonl") accepts .jsonl/.ndjson; the JSON entry accepts .json', () => {
    const jsonl = mount(h(InsertFileWizard, { onSuccess: () => {}, format: 'jsonl' }));
    const jaccept = jsonl.querySelector('input[type="file"]').accept;
    expect(jaccept).toContain('.jsonl');
    expect(jaccept).toContain('.ndjson');
    const json = mount(h(InsertFileWizard, { onSuccess: () => {}, format: 'json' }));
    expect(json.querySelector('input[type="file"]').accept).toContain('.json');
  });
  it('errors on a file that is neither JSON nor JSON Lines', async () => {
    const root = mount(h(InsertFileWizard, { onSuccess: () => {} }));
    load(root, file('not json at all\nstill not'));
    await waitFor(() => root.querySelector('.input-hint'));
    expect(root.querySelector('.import-mode-group')).toBeNull(); // stayed on pick
  });
});
