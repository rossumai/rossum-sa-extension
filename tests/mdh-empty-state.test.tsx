// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';

vi.mock('../src/mdh/components/Sidebar.jsx', () => ({
  showCreateModal: vi.fn(),
}));

import CollectionEmptyState from '../src/mdh/components/CollectionEmptyState.jsx';
import { collections, loading, error } from '../src/mdh/store.js';
import { showCreateModal } from '../src/mdh/components/Sidebar.jsx';

function mount(props = { connected: true }) {
  const root = document.createElement('div');
  render(<CollectionEmptyState {...props} />, root);
  return root;
}

describe('CollectionEmptyState', () => {
  beforeEach(() => {
    collections.value = [];
    loading.value = false;
    error.value = null;
    vi.mocked(showCreateModal).mockClear();
  });

  it('shows the no-collections first-run block when loaded, connected, and empty', () => {
    const root = mount({ connected: true });
    expect(root.textContent).toContain('No collections yet');
    expect(root.textContent).toContain('Master Data Hub');
    const btn = root.querySelector('button.btn-success');
    expect(btn).toBeTruthy();
    expect(btn!.textContent).toContain('Create collection');
    expect(root.textContent).not.toContain('Select a collection');
  });

  it('shows the select-a-collection line when collections exist (no button)', () => {
    collections.value = ['a'];
    const root = mount({ connected: true });
    expect(root.textContent).toContain('Select a collection to get started');
    expect(root.textContent).not.toContain('No collections yet');
    expect(root.querySelector('button')).toBeNull();
  });

  it('renders nothing while loading (empty + connected)', () => {
    loading.value = true;
    expect(mount({ connected: true }).textContent).toBe('');
  });

  it('renders nothing when disconnected (empty + not loading)', () => {
    expect(mount({ connected: false }).textContent).toBe('');
  });

  it('renders nothing when an error is present (empty + connected)', () => {
    error.value = { message: 'boom' };
    expect(mount({ connected: true }).textContent).toBe('');
  });

  it('invokes the create flow when the button is clicked', () => {
    const btn = mount({ connected: true }).querySelector<HTMLButtonElement>('button.btn-success');
    btn!.click();
    expect(showCreateModal).toHaveBeenCalledTimes(1);
  });

  it('collections-present wins over loading/error/disconnected (precedence)', () => {
    // The `collections.length > 0` branch is checked before loading/connection/
    // error, so a selection is imminent — the truthful "select" line must show
    // regardless of those flags (this ordering is what keeps the drop-last and
    // boot transients coherent).
    collections.value = ['a'];
    loading.value = true;
    error.value = { message: 'boom' };
    const root = mount({ connected: false });
    expect(root.textContent).toContain('Select a collection to get started');
    expect(root.querySelector('button')).toBeNull();
  });
});
