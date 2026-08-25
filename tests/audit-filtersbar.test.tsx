// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { h, render } from 'preact';
import FiltersBar from '../src/audit/components/FiltersBar.jsx';
import * as store from '../src/audit/store.js';

function mount() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(<FiltersBar />, root);
  return root;
}
const resetBtn = (root: any) =>
  [...root.querySelectorAll('button')].find((b) => /reset filters/i.test(b.textContent));

beforeEach(() => {
  store.activeSource.value = 'audit';
  store.filtersBySource.value = {
    audit: {
      object_type: 'user', action: 'app_load', object_id: '7', username: 'a@b.c',
      timestamp_after: '', timestamp_before: '', page: 3, cursor: null, pageSize: 100, search: '',
    },
  };
});

describe('FiltersBar — reset', () => {
  it('shows an enabled Reset button when narrowing filters are active', () => {
    const btn = resetBtn(mount());
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(false);
  });

  it('clears the narrowing filters + paging but preserves the required object_type', () => {
    resetBtn(mount()).click();
    const f = store.filtersBySource.value.audit;
    expect(f.object_type).toBe('user'); // required scope preserved
    expect(f.action).toBe('');
    expect(f.object_id).toBe('');
    expect(f.username).toBe('');
    expect(f.page).toBe(1);
    expect(f.cursor).toBeNull();
  });

  it('disables Reset when only the required scope is set', () => {
    store.filtersBySource.value = {
      audit: {
        object_type: 'annotation', action: '', object_id: '', username: '',
        timestamp_after: '', timestamp_before: '', page: 1, cursor: null, pageSize: 100, search: '',
      },
    };
    expect(resetBtn(mount()).disabled).toBe(true);
  });
});
