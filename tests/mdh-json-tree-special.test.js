// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { h, render } from 'preact';
import JsonTree from '../src/mdh/components/JsonTree.jsx';

function mount(data, extra = {}) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(JsonTree, {
    data,
    sortState: {}, filterState: {}, onSort() {}, onFilter() {},
    ...extra,
  }), root);
  return root;
}

afterEach(() => { document.body.innerHTML = ''; });

describe('JsonTree special-character reveal', () => {
  it('reveals a special char in a string value', () => {
    const root = mount({ name: 'a\u00a0b' });
    const span = root.querySelector('.mdh-special.mdh-special-space');
    expect(span).not.toBeNull();
    expect(span.getAttribute('title')).toBe('U+00A0 NO-BREAK SPACE');
  });

  it('reveals a special char in a string array item', () => {
    const root = mount({ tags: ['x\u200bz'] });
    expect(root.querySelector('.mdh-special.mdh-special-zero-width')).not.toBeNull();
  });

  it('also reveals in read-only mode', () => {
    const root = mount({ name: 'a\u00a0b' }, { readOnly: true });
    expect(root.querySelector('.mdh-special.mdh-special-space')).not.toBeNull();
  });

  it('leaves a clean string untouched', () => {
    const root = mount({ name: 'Alice' });
    expect(root.querySelectorAll('.mdh-special').length).toBe(0);
    expect(root.textContent).toContain('"Alice"');
  });
});
