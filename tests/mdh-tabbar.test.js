// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { h, render } from 'preact';
import * as store from '../src/mdh/store.js';
import TabBar from '../src/mdh/components/TabBar.jsx';

function mount() {
  const root = document.createElement('div');
  render(h(TabBar, null), root);
  return root;
}

beforeEach(() => {
  store.selectedCollection.value = 'col1';
  store.activePanel.value = 'data';
  store.statsSummary.value = null;
});

describe('TabBar stats alert icon', () => {
  it('does not render an icon when statsSummary is null', () => {
    const root = mount();
    expect(root.querySelector('.tab-alert')).toBeNull();
  });

  it('does not render an icon when health >= 90', () => {
    store.statsSummary.value = { collection: 'col1', health: 95, label: 'Excellent' };
    const root = mount();
    expect(root.querySelector('.tab-alert')).toBeNull();
  });

  it('renders the warning variant (triangle) when 50 <= health < 90', () => {
    store.statsSummary.value = { collection: 'col1', health: 72, label: 'Fair' };
    const root = mount();
    const wrap = root.querySelector('.tab-alert');
    expect(wrap).not.toBeNull();
    expect(wrap.getAttribute('title')).toBe('Health: 72 (Fair)');
    expect(wrap.querySelector('.tab-alert-warning')).not.toBeNull();
    expect(wrap.querySelector('.tab-alert-danger')).toBeNull();
  });

  it('renders the danger variant (circle) when health < 50', () => {
    store.statsSummary.value = { collection: 'col1', health: 35, label: 'Poor' };
    const root = mount();
    const wrap = root.querySelector('.tab-alert');
    expect(wrap).not.toBeNull();
    expect(wrap.getAttribute('title')).toBe('Health: 35 (Poor)');
    expect(wrap.querySelector('.tab-alert-danger')).not.toBeNull();
    expect(wrap.querySelector('.tab-alert-warning')).toBeNull();
  });

  it('treats health exactly 50 as warning (not danger)', () => {
    store.statsSummary.value = { collection: 'col1', health: 50, label: 'Fair' };
    const root = mount();
    const wrap = root.querySelector('.tab-alert');
    expect(wrap.querySelector('.tab-alert-warning')).not.toBeNull();
    expect(wrap.querySelector('.tab-alert-danger')).toBeNull();
  });

  it('does not render an icon when summary is for a different collection', () => {
    store.statsSummary.value = { collection: 'other', health: 40, label: 'Poor' };
    const root = mount();
    expect(root.querySelector('.tab-alert')).toBeNull();
  });

  it('attaches the icon to the Stats tab specifically', () => {
    store.statsSummary.value = { collection: 'col1', health: 60, label: 'Fair' };
    const root = mount();
    const statsTab = Array.from(root.querySelectorAll('.tab')).find((b) => b.textContent.includes('Stats'));
    expect(statsTab).toBeDefined();
    expect(statsTab.querySelector('.tab-alert')).not.toBeNull();
  });
});
