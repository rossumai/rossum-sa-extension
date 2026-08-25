// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';

vi.mock('../src/audit/api.js');
import * as api from '../src/audit/api.js';
import * as store from '../src/audit/store.js';
import App from '../src/audit/components/App.jsx';

async function waitFor(cond: any, desc = 'condition', timeoutMs = 2000) {
  const start = Date.now();
  for (;;) {
    let ok = false;
    try {
      ok = cond();
    } catch {
      ok = false;
    }
    if (ok) return;
    if (Date.now() - start > timeoutMs) throw new Error(`Timeout: ${desc}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
function mount(connected: any) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(<App connected={connected} />, root);
  return root;
}

beforeEach(() => {
  vi.clearAllMocks();
  store.activeSource.value = 'audit';
  store.availability.value = 'available';
  store.rows.value = [];
  store.selectedRow.value = null;
  store.error.value = null;
  store.aiAvailable.value = false;
});

describe('Audit shell', () => {
  it('renders the audit filters and no tab bar when connected', () => {
    const root = mount(true);
    expect(root.querySelector('.filters')).not.toBeNull();
    expect(root.querySelector('.audit-tabbar')).toBeNull();
  });

  it('renders a row and opens the detail panel on click', async () => {
    store.rows.value = [
      {
        _idx: 0,
        timestamp: '2026-01-01T00:00:00Z',
        username: 'a@b.c',
        object_type: 'user',
        action: 'app_load',
        object_id: 7,
        content: { status_code: 200, method: 'GET', path: '/x', request_id: 'r1' },
      },
    ];
    const root = mount(true);
    await waitFor(() => root.querySelector('.result-row'), 'row rendered');
    // The detail sidebar is always present; before any selection it prompts the user.
    expect(root.querySelector('.audit-detail')!.textContent).toContain('Click a row');
    root.querySelector<HTMLElement>('.result-row')!.click();
    await waitFor(
      () => root.querySelector('.audit-detail')!.textContent.includes('app_load'),
      'raw JSON shown',
    );
    // The sidebar shows the full raw record as a JSON tree (keys + values).
    expect(root.querySelector('.audit-detail')!.textContent).toContain('app_load');
    expect(root.querySelector('.audit-detail')!.textContent).toContain('request_id');
  });

  it('shows the unavailable panel when the active source is 403', () => {
    store.availability.value = 'unavailable';
    const root = mount(true);
    expect(root.querySelector('.unavailable-panel')).not.toBeNull();
    expect(root.querySelector('.results-wrap')).toBeNull();
  });

  it('mounts the Fabry panel only when the agent is available', () => {
    store.aiAvailable.value = false;
    expect(mount(true).querySelector('.audit-fabry')).toBeNull();
    store.aiAvailable.value = true;
    expect(mount(true).querySelector('.audit-fabry')).not.toBeNull();
  });
});
