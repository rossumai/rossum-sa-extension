// tests/ui-gerund-loader.test.js
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { h, render } from 'preact';
import GerundLoader from '../src/ui/GerundLoader.jsx';

let root;
afterEach(() => { if (root) { render(null, root); root.remove(); } });
function mount(props) { root = document.createElement('div'); document.body.appendChild(root); render(h(GerundLoader, props), root); return root; }

describe('GerundLoader', () => {
  it('renders the loader wrapper with the first gerund', () => {
    const el = mount({ gerunds: ['Thinking', 'Reading'] });
    expect(el.querySelector('.nl-search-loading')).toBeTruthy();
    expect(el.querySelector('.nl-gerund').textContent).toContain('Thinking');
  });
  it('falls back to a default gerund when the list is empty', () => {
    const el = mount({ gerunds: [] });
    expect(el.querySelector('.nl-gerund').textContent).toContain('Working');
  });
});
