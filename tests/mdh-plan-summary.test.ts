// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h, render } from 'preact';
import PlanSummary from '../src/mdh/components/PlanSummary.jsx';

function mount(vnode: any) { const el = document.createElement('div'); document.body.appendChild(el); render(vnode, el); return el; }
function waitFor(fn: any, { timeout = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      let v: any; try { v = fn(); } catch { v = null; }
      if (v) return resolve(v);
      if (Date.now() - t0 > timeout) return reject(new Error('waitFor timeout'));
      setTimeout(poll, 10);
    })();
  });
}

describe('PlanSummary', () => {
  it('shows the summary sentence and hides details by default', () => {
    const root = mount(h(PlanSummary, { summary: 'Adds 3 new records.', summaryTestid: 'sum' },
      h('ul', null, h('li', null, 'bullet one'))));
    expect(root.querySelector('[data-testid="sum"]')!.textContent).toBe('Adds 3 new records.');
    expect(root.textContent).not.toContain('bullet one');
    const toggle = root.querySelector('[data-testid="sum-toggle"]')!;
    expect(toggle.textContent).toContain('Details');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('expands and collapses the bullets via the toggle', async () => {
    const root = mount(h(PlanSummary, { summary: 's', summaryTestid: 'sum' },
      h('ul', { 'data-testid': 'bullets' }, h('li', null, 'bullet one'))));
    root.querySelector<HTMLElement>('[data-testid="sum-toggle"]')!.click();
    await waitFor(() => root.querySelector('[data-testid="bullets"]'));
    expect(root.textContent).toContain('bullet one');
    expect(root.querySelector('[data-testid="sum-toggle"]')!.textContent).toContain('Hide');
    root.querySelector<HTMLElement>('[data-testid="sum-toggle"]')!.click();
    await waitFor(() => !root.querySelector('[data-testid="bullets"]'));
  });

  it('renders no toggle when there are no children', () => {
    const root = mount(h(PlanSummary, { summary: 'just a sentence', summaryTestid: 'sum' }));
    expect(root.querySelector('[data-testid="sum-toggle"]')).toBe(null);
  });
});
