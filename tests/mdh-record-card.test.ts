// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';
import RecordCard from '../src/mdh/components/RecordCard.jsx';
import { selectionMode } from '../src/mdh/store.js';

function mount(props: any) {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(RecordCard, {
    record: { _id: '1', name: 'ACME' },
    index: 0,
    expanded: true,
    onToggle: () => {},
    onCopy: () => {},
    onEdit: () => {},
    onDelete: () => {},
    sortState: {},
    filterState: {},
    onSort: () => {},
    onFilter: () => {},
    charBudget: 80,
    indexes: [],
    ...props,
  }), root);
  return root;
}

beforeEach(() => { selectionMode.value = false; });

describe('RecordCard readOnly', () => {
  it('default (not readOnly) shows Edit and Del actions', () => {
    const root = mount({});
    expect(root.querySelector('.action-edit')).not.toBeNull();
    expect(root.querySelector('.action-delete')).not.toBeNull();
    expect(root.querySelector('.action-copy')).not.toBeNull();
  });

  it('readOnly hides Edit/Del but keeps Copy and renders the JSON body', () => {
    const root = mount({ readOnly: true });
    expect(root.querySelector('.action-edit')).toBeNull();
    expect(root.querySelector('.action-delete')).toBeNull();
    expect(root.querySelector('.action-copy')).not.toBeNull();
    // Expanded body renders the JsonTree.
    expect(root.querySelector('.json-tree')).not.toBeNull();
  });

  it('readOnly renders JSON keys/values as non-interactive text (no sort/filter)', () => {
    const root = mount({ readOnly: true });
    // Keys are static spans, not clickable buttons.
    expect(root.querySelector('.json-tree-key-static')).not.toBeNull();
    expect(root.querySelector('button.json-tree-key')).toBeNull();
    // Values are not clickable (no sort/filter); copy buttons remain.
    expect(root.querySelector('.json-tree-value-clickable')).toBeNull();
    expect(root.querySelector('.json-tree-copy-btn')).not.toBeNull();
  });

  it('default (interactive) renders JSON keys/values as clickable buttons', () => {
    const root = mount({}); // not readOnly
    expect(root.querySelector('button.json-tree-key')).not.toBeNull();
    expect(root.querySelector('button.json-tree-value-clickable')).not.toBeNull();
    expect(root.querySelector('.json-tree-key-static')).toBeNull();
  });

  it('readOnly suppresses the selection checkbox even in selection mode', () => {
    selectionMode.value = true;
    const root = mount({ readOnly: true });
    expect(root.querySelector('.record-checkbox')).toBeNull();
    expect(root.querySelector('.action-edit')).toBeNull();
  });
});
