// @vitest-environment jsdom
//
// Locks the Console shell's connected tri-state rendering — the most fragile,
// otherwise-untested surface: a `null` connected (probe pending) must show the
// Connecting placeholder, and a resolved boolean must show the app. The real
// app components are stubbed so this stays focused on the shell's branching.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';

vi.mock('../src/console/components/Rail.jsx', () => ({ default: () => null }));
vi.mock('../src/mdh/components/App.jsx', async () => {
  const { h } = await import('preact');
  return { default: ({ connected }) => h('div', { class: 'mdh-stub' }, `mdh:${String(connected)}`) };
});
vi.mock('../src/audit/components/App.jsx', async () => {
  const { h } = await import('preact');
  return { default: ({ connected }) => h('div', { class: 'audit-stub' }, `audit:${String(connected)}`) };
});

import Console from '../src/console/components/Console.jsx';
import { activeApp } from '../src/console/store.js';
import * as mdhStore from '../src/mdh/store.js';
import * as auditStore from '../src/audit/store.js';

function mount() {
  const root = document.createElement('div');
  render(h(Console, null), root);
  return root;
}

beforeEach(() => {
  activeApp.value = 'mdh';
  mdhStore.connected.value = null;
  auditStore.connected.value = null;
});

describe('Console connected tri-state', () => {
  it('shows the Connecting placeholder while the active app probe is pending (null)', () => {
    activeApp.value = 'mdh';
    mdhStore.connected.value = null;
    const root = mount();
    expect(root.querySelector('.empty-state')?.textContent).toContain('Connecting');
    expect(root.querySelector('.mdh-stub')).toBeNull();
  });

  it('renders the MDH app once connected resolves true', () => {
    activeApp.value = 'mdh';
    mdhStore.connected.value = true;
    const root = mount();
    expect(root.querySelector('.mdh-stub')?.textContent).toBe('mdh:true');
    expect(root.querySelector('.empty-state')).toBeNull();
  });

  it('renders the MDH app (not Connecting) when connected is false — the app shows its own not-connected message', () => {
    activeApp.value = 'mdh';
    mdhStore.connected.value = false;
    const root = mount();
    expect(root.querySelector('.mdh-stub')?.textContent).toBe('mdh:false');
    expect(root.querySelector('.empty-state')).toBeNull();
  });

  it('shows Connecting for the audit app before its probe, then the audit app once resolved', () => {
    activeApp.value = 'audit';
    auditStore.connected.value = null;
    let root = mount();
    expect(root.querySelector('.empty-state')?.textContent).toContain('Connecting');
    expect(root.querySelector('.audit-stub')).toBeNull();

    auditStore.connected.value = true;
    root = mount();
    expect(root.querySelector('.audit-stub')?.textContent).toBe('audit:true');
    expect(root.querySelector('.empty-state')).toBeNull();
  });
});
