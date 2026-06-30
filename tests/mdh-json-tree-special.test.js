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

describe('JsonTree compact type tags', () => {
  it('renders an EJSON value with the shared compact value-type-tag (short + title), not the full-word badge', () => {
    const root = mount({ _id: { $oid: 'aaaaaaaaaaaaaaaaaaaaaaaa' } });
    expect(root.querySelector('.json-tree-badge')).toBeNull();
    const tag = root.querySelector('.value-type-tag');
    expect(tag).not.toBeNull();
    expect(tag.textContent).toBe('oid');
    expect(tag.getAttribute('title')).toBe('ObjectId');
    expect(tag.classList.contains('json-tree-value-oid')).toBe(true);
    expect(root.textContent).toContain('aaaaaaaaaaaaaaaaaaaaaaaa');
    // In the list view the tag is shown AFTER the value.
    const row = tag.closest('.json-tree-row');
    const kids = [...row.children];
    const valIdx = kids.findIndex((k) => k.classList.contains('json-tree-value'));
    const tagIdx = kids.findIndex((k) => k.classList.contains('value-type-tag'));
    expect(valIdx).toBeGreaterThanOrEqual(0);
    expect(tagIdx).toBeGreaterThan(valIdx);
  });

  it('uses the num tag for numeric EJSON types', () => {
    const root = mount({ n: { $numberDecimal: '1.50' } });
    const tag = root.querySelector('.value-type-tag');
    expect(tag.textContent).toBe('num');
    expect(tag.getAttribute('title')).toBe('Decimal');
  });
});

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
