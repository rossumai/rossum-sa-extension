// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';
import RecentAnnotations from '../src/inspector/components/RecentAnnotations.jsx';
import * as store from '../src/inspector/store.js';

let root: any;
beforeEach(() => { store.recents.value = []; root = document.createElement('div'); document.body.appendChild(root); });
afterEach(() => { render(null, root); root.remove(); });

describe('RecentAnnotations', () => {
  it('renders the empty-state callout when there are no recents', () => {
    render(h(RecentAnnotations, { onSelect: () => {} }), root);
    expect(root.querySelector('.inspector-recents')).toBe(null);
    const empty: any = root.querySelector('.inspector-recents-empty');
    expect(empty).toBeTruthy();
    expect(empty.textContent).toContain('Rossum UI');
  });

  it('renders a row per recent with filename, queue, status, and #id, plus a Clear control', () => {
    store.recents.value = [
      { id: '133641827', fileName: 'invoice_4471.pdf', queue: 'Vendor US', status: 'rejected', at: 2 },
      { id: '133640012', fileName: 'PO-99.pdf', queue: 'AP Queue', status: 'exported', at: 1 },
    ];
    render(h(RecentAnnotations, { onSelect: () => {} }), root);
    expect(root.querySelectorAll('tr.inspector-recent').length).toBe(2);
    expect(root.textContent).toContain('invoice_4471.pdf');
    expect(root.textContent).toContain('Vendor US');
    expect(root.textContent).toContain('rejected');
    expect(root.textContent).toContain('#133641827');
    expect(root.querySelector('.inspector-recents-clear')).toBeTruthy();
    expect(root.querySelector('.inspector-rectable')).toBeTruthy();
    expect(root.querySelector('.inspector-recent-status').className).toContain('inspector-pill-rejected');
  });

  it('falls back to #id and omits missing queue/status', () => {
    store.recents.value = [{ id: '55', fileName: null, queue: null, status: null, at: 1 }];
    render(h(RecentAnnotations, { onSelect: () => {} }), root);
    expect(root.querySelector('.inspector-recent-name').textContent).toBe('#55');
    expect(root.querySelector('.inspector-recent-queue')).toBe(null);
    expect(root.querySelector('.inspector-recent-status')).toBe(null);
  });

  it('calls onSelect with the id as a string on click', () => {
    const onSelect = vi.fn();
    store.recents.value = [{ id: 99, fileName: 'a.pdf', at: 1 }];
    render(h(RecentAnnotations, { onSelect }), root);
    root.querySelector('.inspector-recent').click();
    expect(onSelect).toHaveBeenCalledWith('99');
  });
});
