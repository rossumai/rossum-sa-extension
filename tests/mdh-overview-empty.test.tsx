// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';

vi.mock('../src/mdh/api.js', () => ({ aggregate: vi.fn() }));
vi.mock('../src/mdh/components/Sidebar.jsx', () => ({ showCreateModal: vi.fn() }));

import OverviewPanel from '../src/mdh/components/OverviewPanel.jsx';
import { collections, connected, loading, error } from '../src/mdh/store.js';

function mount() {
  const root = document.createElement('div');
  render(<OverviewPanel />, root);
  return root;
}

describe('OverviewPanel empty state', () => {
  beforeEach(() => {
    collections.value = [];
    connected.value = true;
    loading.value = false;
    error.value = null;
  });

  it('reuses the shared no-collections empty state instead of bare text', () => {
    const root = mount();
    expect(root.textContent).toContain('No collections yet');
    expect(root.querySelector('button.btn-success')).toBeTruthy();
    // the old bare "No collections" .stats-empty div is gone
    expect(root.querySelector('.stats-empty')).toBeNull();
    // no stats table when empty
    expect(root.querySelector('table.stats-table')).toBeNull();
  });

  it('shows nothing (not the old "No collections") when empty and disconnected', () => {
    // CollectionEmptyState gates on !connected → renders null; the connection
    // bar carries the reason, matching the collection view. This is the behavior
    // delta from the old bare "No collections" text.
    connected.value = false;
    const root = mount();
    expect(root.textContent).not.toContain('No collections yet');
    expect(root.textContent).not.toContain('No collections');
    expect(root.querySelector('button.btn-success')).toBeNull();
    expect(root.querySelector('.stats-empty')).toBeNull();
  });
});
