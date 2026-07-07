// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../src/mdh/api.js', () => ({ aggregate: vi.fn() }));
vi.mock('../src/mdh/components/Modal.jsx', () => ({ closeModal: vi.fn() }));
import { h, render } from 'preact';
import ExportWizard from '../src/mdh/components/ExportWizard.jsx';
import * as api from '../src/mdh/api.js';
import { closeModal } from '../src/mdh/components/Modal.jsx';

function mount(props) { const el = document.createElement('div'); document.body.appendChild(el); render(h(ExportWizard, props), el); return el; }
async function waitFor(fn, ms = 2000) { const t0 = Date.now(); for (;;) { try { const v = fn(); if (v) return v; } catch {} if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 5)); } }

const FILTER = { stages: [{ $match: { region: 'EU' } }], available: true, trivial: false };
const NO_FILTER = { stages: null, available: false, reason: 'No filter is active — the pipeline is empty.' };
const base = { collection: 'vendors', filterState: NO_FILTER, totalCount: 3, recordsSample: [], onExport: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  // Default: sample fetch -> 2 docs; count/columns fetches resolved generically.
  api.aggregate.mockImplementation(async (_c, pipeline) => {
    const last = pipeline[pipeline.length - 1] || {};
    if ('$count' in last) return { result: [{ total: 7 }] };
    if (JSON.stringify(pipeline).includes('$group')) return { result: [{ keys: ['sku', 'price'] }] }; // column discovery
    return { result: [{ sku: 'A', price: 1 }, { sku: 'B', price: 2 }] };
  });
});

describe('ExportWizard', () => {
  it('preselects All records when no filter is active, and disables Current filter with the reason', async () => {
    const root = mount(base);
    const all = await waitFor(() => [...root.querySelectorAll('[data-testid="export-scope"] button')].find((b) => b.textContent.trim().startsWith('All records')));
    expect(all.getAttribute('aria-pressed')).toBe('true');
    const filtered = [...root.querySelectorAll('[data-testid="export-scope"] button')].find((b) => b.textContent.trim().startsWith('Current filter'));
    expect(filtered.disabled).toBe(true);
    expect(root.textContent).toMatch(/No filter is active/);
  });

  it('defaults to All records even when a filter is active (Current filter stays enabled, unselected)', async () => {
    const root = mount({ ...base, filterState: FILTER });
    const all = await waitFor(() => [...root.querySelectorAll('[data-testid="export-scope"] button')].find((b) => b.textContent.trim().startsWith('All records')));
    expect(all.getAttribute('aria-pressed')).toBe('true');
    const filtered = [...root.querySelectorAll('[data-testid="export-scope"] button')].find((b) => b.textContent.trim().startsWith('Current filter'));
    expect(filtered.getAttribute('aria-pressed')).toBe('false');
    expect(filtered.disabled).toBe(false);
  });

  it('shows both scope counts inside the segmented buttons', async () => {
    const root = mount({ ...base, filterState: FILTER }); // all=3 (totalCount), filtered=7 ($count mock)
    const all = await waitFor(() => {
      const b = [...root.querySelectorAll('[data-testid="export-scope"] button')].find((x) => x.textContent.trim().startsWith('All records'));
      return /All records · 3/.test(b?.textContent || '') ? b : null;
    });
    expect(all.textContent).toMatch(/All records · 3/);
    await waitFor(() => {
      const b = [...root.querySelectorAll('[data-testid="export-scope"] button')].find((x) => x.textContent.trim().startsWith('Current filter'));
      return /Current filter · 7/.test(b?.textContent || '') ? b : null;
    });
    // Unavailable filter: no count shown, plain label
    const noFilter = mount({ ...base });
    const nf = await waitFor(() => [...noFilter.querySelectorAll('[data-testid="export-scope"] button')].find((x) => x.textContent.trim().startsWith('Current filter')));
    expect(nf.textContent.trim()).toBe('Current filter');
  });

  it('the Download button restates count and format, per scope', async () => {
    const root = mount({ ...base, filterState: FILTER });
    await waitFor(() => /Download 3 records · JSON/.test(root.querySelector('[data-testid="export-download"]').textContent));
    [...root.querySelectorAll('[data-testid="export-scope"] button')].find((x) => x.textContent.trim().startsWith('Current filter')).click();
    await waitFor(() => /Download 7 records · JSON/.test(root.querySelector('[data-testid="export-download"]').textContent));
  });

  it('the what-will-happen list is scope-aware', async () => {
    const root = mount({ ...base, filterState: FILTER });
    (await waitFor(() => root.querySelector('[data-testid="export-count-toggle"]'))).click();
    const steps = await waitFor(() => root.querySelector('[data-testid="export-plan"]'));
    // All records (default): collection-wide lead line, plain _id ordering, no filter talk.
    expect(steps.textContent).toMatch(/Every record in the collection is exported/);
    expect(steps.textContent).toMatch(/pipeline editor is ignored/);
    expect(steps.textContent).toMatch(/stable order — by _id/);
    expect(steps.textContent).not.toMatch(/final sort/);
    // Current filter: result-set lead line + paging note + filter-sort ordering.
    [...root.querySelectorAll('[data-testid="export-scope"] button')].find((b) => b.textContent.trim().startsWith('Current filter')).click();
    await waitFor(() => /Only records matching the current pipeline/.test(root.querySelector('[data-testid="export-plan"]').textContent));
    const t = root.querySelector('[data-testid="export-plan"]').textContent;
    expect(t).toMatch(/whole result set is exported — not just the visible page/);
    expect(t).toMatch(/your filter’s final sort if it has one, otherwise by _id/);
    expect(t).not.toMatch(/pipeline editor is ignored/);
  });

  it('shows the exact count and filename in the count line (all-records uses totalCount)', async () => {
    const root = mount(base);
    await waitFor(() => /Exports 3 records to vendors\.json/.test(root.querySelector('[data-testid="export-count"]').textContent));
  });

  it('warns inline above 10,000 documents — no popup', async () => {
    const root = mount({ ...base, totalCount: 25000 });
    const line = await waitFor(() => root.querySelector('[data-testid="export-count"]'));
    await waitFor(() => /Large export — may take a while\./.test(line.textContent));
    expect(root.querySelector('[data-testid="export-download"]').disabled).toBe(false);
  });

  it('switching format swaps the options strip and preview kind, and re-labels Download', async () => {
    const root = mount(base);
    await waitFor(() => root.querySelector('[data-testid="export-preview"]'));
    const csvBtn = [...root.querySelectorAll('[data-testid="export-format"] button')].find((b) => b.textContent.trim() === 'CSV');
    csvBtn.click();
    await waitFor(() => root.querySelector('[data-testid="export-csv-bom"]'));
    await waitFor(() => /sku,price/.test(root.querySelector('[data-testid="export-preview"]').textContent));
    expect(root.querySelector('[data-testid="export-download"]').textContent).toMatch(/Download 3 records · CSV/);
    const xlsxBtn = [...root.querySelectorAll('[data-testid="export-format"] button')].find((b) => b.textContent.trim() === 'Excel');
    xlsxBtn.click();
    await waitFor(() => root.querySelector('.csv-preview-table')); // grid preview
  });

  it('what-will-happen shows the columns line only for column formats', async () => {
    const root = mount(base);
    (await waitFor(() => root.querySelector('[data-testid="export-count-toggle"]'))).click();
    const steps = await waitFor(() => root.querySelector('[data-testid="export-plan"]'));
    expect(steps.textContent).toMatch(/1,000-record batches/);
    expect(steps.textContent).toMatch(/Cancelling discards the partial file/);
    expect(steps.textContent).toMatch(/read-only/);
    expect(steps.textContent).not.toMatch(/union of fields/);
    [...root.querySelectorAll('[data-testid="export-format"] button')].find((b) => b.textContent.trim() === 'CSV').click();
    await waitFor(() => /union of fields/.test(root.querySelector('[data-testid="export-plan"]').textContent));
    // Let the column-discovery fetch actually resolve (not just the render-time
    // bullet) so this test doesn't leave a pending aggregate() call to spill
    // into a later test's mock-call assertions.
    await waitFor(() => /sku,price/.test(root.querySelector('[data-testid="export-preview"]').textContent));
  });

  it('Download hands the full config to onExport and closes the modal', async () => {
    const onExport = vi.fn();
    const root = mount({ ...base, filterState: FILTER, onExport });
    await waitFor(() => root.querySelector('[data-testid="export-preview"]'));
    // Scope now defaults to All records — pick the filter explicitly.
    [...root.querySelectorAll('[data-testid="export-scope"] button')].find((b) => b.textContent.trim().startsWith('Current filter')).click();
    [...root.querySelectorAll('[data-testid="export-format"] button')].find((b) => b.textContent.trim() === 'CSV').click();
    await waitFor(() => root.querySelector('[data-testid="export-csv-bom"]'));
    // count for filtered scope resolves to 7 via the $count mock
    await waitFor(() => /Exports 7 records/.test(root.querySelector('[data-testid="export-count"]').textContent));
    root.querySelector('[data-testid="export-download"]').click();
    expect(closeModal).toHaveBeenCalled();
    expect(onExport).toHaveBeenCalledWith({
      scope: 'filtered', formatId: 'csv',
      opts: { delimiter: ',', header: true, bom: false },
      columns: ['sku', 'price'], count: 7,
    });
  });

  it('a failed count never blocks Download (config carries count: null)', async () => {
    api.aggregate.mockImplementation(async (_c, pipeline) => {
      const last = pipeline[pipeline.length - 1] || {};
      if ('$count' in last) throw new Error('boom');
      return { result: [] };
    });
    const onExport = vi.fn();
    const root = mount({ ...base, totalCount: null, onExport });
    const btn = await waitFor(() => { const b = root.querySelector('[data-testid="export-download"]'); return b && !b.disabled ? b : null; });
    await waitFor(() => /Download JSON/.test(btn.textContent)); // no count → plain label
    btn.click();
    expect(onExport.mock.calls[0][0].count).toBe(null);
  });

  it('column discovery only runs for column formats, lazily, and is cached across a csv<->xlsx switch', async () => {
    const root = mount(base);
    await waitFor(() => root.querySelector('[data-testid="export-preview"]'));
    await new Promise((r) => setTimeout(r, 20)); // let any pending microtasks settle
    const groupCalls = () => api.aggregate.mock.calls.filter(([, pipeline]) => JSON.stringify(pipeline).includes('$group')).length;
    expect(groupCalls()).toBe(0); // JSON never needs columns

    [...root.querySelectorAll('[data-testid="export-format"] button')].find((b) => b.textContent.trim() === 'CSV').click();
    await waitFor(() => /sku,price/.test(root.querySelector('[data-testid="export-preview"]').textContent));
    expect(groupCalls()).toBe(1); // fetched once, lazily, on first need

    [...root.querySelectorAll('[data-testid="export-format"] button')].find((b) => b.textContent.trim() === 'Excel').click();
    await waitFor(() => root.querySelector('.csv-preview-table'));
    expect(groupCalls()).toBe(1); // xlsx reuses the cached columns — no refetch
  });

  it('shows "Building preview…" (not "Preview unavailable") while CSV columns are still loading', async () => {
    let resolveDiscovery;
    api.aggregate.mockImplementation(async (_c, pipeline) => {
      const last = pipeline[pipeline.length - 1] || {};
      if ('$count' in last) return { result: [{ total: 7 }] };
      if (JSON.stringify(pipeline).includes('$group')) {
        return new Promise((resolve) => { resolveDiscovery = resolve; });
      }
      return { result: [{ sku: 'A', price: 1 }, { sku: 'B', price: 2 }] };
    });
    const root = mount(base);
    // Wait for the initial JSON preview (which doesn't need columns) to fully
    // resolve first, so the OUTER "Building preview…" note (shown while the
    // row sample itself is loading) can't be mistaken for the inner one.
    await waitFor(() => /"sku"/.test(root.querySelector('[data-testid="export-preview"]').textContent));
    [...root.querySelectorAll('[data-testid="export-format"] button')].find((b) => b.textContent.trim() === 'CSV').click();
    await waitFor(() => /Building preview/.test(root.querySelector('[data-testid="export-preview"]').textContent));
    expect(root.querySelector('[data-testid="export-preview"]').textContent).not.toMatch(/Preview unavailable/);
    resolveDiscovery({ result: [{ keys: ['sku', 'price'] }] });
    await waitFor(() => /sku,price/.test(root.querySelector('[data-testid="export-preview"]').textContent));
  });

  it('aborts in-flight count/sample/discovery aggregations when the wizard unmounts (e.g. modal closed)', async () => {
    const signals = [];
    api.aggregate.mockImplementation((_c, _p, opts) => {
      signals.push(opts?.signal);
      return new Promise(() => {}); // never resolves — only abort behavior is under test
    });
    // totalCount: null forces the count effect to hit the network too (rather
    // than taking the cached-total fast path); CSV brings in the discovery call.
    const root = mount({ ...base, totalCount: null });
    [...root.querySelectorAll('[data-testid="export-format"] button')].find((b) => b.textContent.trim() === 'CSV').click();
    await waitFor(() => signals.length >= 3); // count + sample + discovery effects have all fired
    for (const s of signals) expect(s.aborted).toBe(false);
    render(null, root); // unmount, as closing the modal would
    for (const s of signals) expect(s.aborted).toBe(true);
  });
});
