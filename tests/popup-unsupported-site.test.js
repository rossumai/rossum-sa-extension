// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h, render } from 'preact';
import { UnsupportedSite } from '../src/popup/components/App.jsx';

function mount(props) {
  const root = document.createElement('div');
  render(h(UnsupportedSite, props), root);
  return root;
}

const TABS = [{ id: 1, url: 'https://elis.rossum.ai/queues', title: 'Rossum', favIconUrl: '' }];

describe('UnsupportedSite', () => {
  it('shows the Console lede and keeps the tab switcher when on the Console with open Rossum tabs', () => {
    const root = mount({ tabs: TABS, isConsole: true });
    expect(root.textContent).toContain("You're on the Rossum Console.");
    expect(root.textContent).not.toContain("isn't supported");
    expect(root.querySelector('.rossum-tab-list')).toBeTruthy();
    expect(root.textContent).toContain('Switch to one of your open Rossum tabs');
  });

  it('shows the Console lede with the static fallback when on the Console with no Rossum tabs', () => {
    const root = mount({ tabs: [], isConsole: true });
    expect(root.textContent).toContain("You're on the Rossum Console.");
    expect(root.textContent).toContain('It works on');
    expect(root.querySelector('.rossum-tab-list')).toBeNull();
  });

  it('keeps the unsupported lede for a non-Console unsupported tab', () => {
    const root = mount({ tabs: [], isConsole: false });
    expect(root.textContent).toContain("This tab isn't supported by the extension.");
    expect(root.textContent).not.toContain('Rossum Console');
  });
});
