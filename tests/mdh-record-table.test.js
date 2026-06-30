// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import RecordTable from '../src/mdh/components/RecordTable.jsx';
import { selectionMode, selectedIds } from '../src/mdh/store.js';
import { copyTextFor } from '../src/mdh/displayValue.js';

function renderTable(props = {}) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(RecordTable, {
    records: [{ _id: '1', name: 'Alice', tags: ['x', 'y'] }, { _id: '2', name: 'Bob', tags: [] }],
    columns: ['_id', 'name', 'tags'],
    sortState: {}, filterState: {}, onSort() {}, onFilter() {},
    ...props,
  }), root);
  return root;
}

beforeEach(() => {
  selectionMode.value = false;
  selectedIds.value = new Map();
  navigator.clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
});

afterEach(() => {
  selectionMode.value = false;
  selectedIds.value = new Map();
});

describe('RecordTable', () => {
  it('renders a header per column and a row per record', () => {
    const root = renderTable();
    expect(root.querySelectorAll('thead th').length).toBe(3);
    expect(root.querySelectorAll('tbody tr').length).toBe(2);
  });
  it('renders an array cell as a badge, not raw JSON', () => {
    const root = renderTable();
    expect(root.textContent).toContain('[2]'); // tags: ['x','y']
  });
  it('calls onSort when a header is clicked', () => {
    const onSort = vi.fn();
    const root = renderTable({ onSort });
    root.querySelectorAll('thead th')[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onSort).toHaveBeenCalledWith('name');
  });

  it('shows sort badge in header when sortState has a column', () => {
    const root = renderTable({ sortState: { name: 1 } });
    const nameHeader = root.querySelectorAll('thead th')[1];
    expect(nameHeader.textContent).toContain('↑'); // ↑ ascending arrow
    const badge = nameHeader.querySelector('.record-table-sort-badge.asc');
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe('↑');
    // <th> should NOT have the old full-header color classes
    expect(nameHeader.classList.contains('record-table-th-asc')).toBe(false);
    expect(nameHeader.classList.contains('record-table-th-desc')).toBe(false);
  });

  it('renders checkboxes and selection when selectionMode is true', async () => {
    selectionMode.value = true;
    let root;
    await act(() => {
      root = renderTable({
        records: [{ _id: { $oid: 'aaa111' }, name: 'Alice' }, { _id: { $oid: 'bbb222' }, name: 'Bob' }],
        columns: ['_id', 'name'],
      });
    });
    // Should have a checkbox column header + 2 data columns = 3 ths
    expect(root.querySelectorAll('thead th').length).toBe(3);
    const checkboxes = root.querySelectorAll('.record-checkbox');
    expect(checkboxes.length).toBe(2);

    // Click first checkbox to select the first record
    await act(() => {
      checkboxes[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(selectedIds.value.has('aaa111')).toBe(true);

    // The first row should gain the selected class
    const rows = root.querySelectorAll('tbody tr');
    expect(rows[0].classList.contains('record-table-row-selected')).toBe(true);
    expect(rows[1].classList.contains('record-table-row-selected')).toBe(false);

    // Click again to deselect
    await act(() => {
      checkboxes[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(selectedIds.value.has('aaa111')).toBe(false);
  });

  it('shows nested expand badge for complex cells and expands on click', async () => {
    let root;
    await act(() => {
      root = renderTable({
        records: [{ _id: '1', items: [{ sku: 'a', qty: 1 }, { sku: 'b', qty: 3 }] }],
        columns: ['_id', 'items'],
      });
    });

    // Should render the badge with [2] array display
    const badge = root.querySelector('.record-table-badge');
    expect(badge).not.toBeNull();
    expect(badge.textContent).toContain('[2]');

    // No nested tree rendered yet
    expect(root.querySelector('.record-table-nested')).toBeNull();

    // Click the badge to expand
    await act(() => {
      badge.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Nested tree should now be present
    const nested = root.querySelector('.record-table-nested');
    expect(nested).not.toBeNull();
    // JsonTree renders rows — should contain the items' content
    expect(nested.textContent.length).toBeGreaterThan(0);
  });

  // --- Sort header styling (badge, not full-header color) ---
  it('renders a sort badge with ↑ for ascending sort; th does NOT get old color classes', () => {
    const root = renderTable({ sortState: { name: 1 } });
    const nameHeader = root.querySelectorAll('thead th')[1];
    const badge = nameHeader.querySelector('.record-table-sort-badge.asc');
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe('↑');
    // Full-header color classes should not be present
    expect(nameHeader.classList.contains('record-table-th-asc')).toBe(false);
    expect(nameHeader.classList.contains('record-table-th-desc')).toBe(false);
    // Other headers should have no badge
    const idHeader = root.querySelectorAll('thead th')[0];
    expect(idHeader.querySelector('.record-table-sort-badge')).toBeNull();
  });

  it('renders a sort badge with ↓ for descending sort; th does NOT get old color classes', () => {
    const root = renderTable({ sortState: { name: -1 } });
    const nameHeader = root.querySelectorAll('thead th')[1];
    const badge = nameHeader.querySelector('.record-table-sort-badge.desc');
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe('↓');
    expect(nameHeader.classList.contains('record-table-th-asc')).toBe(false);
    expect(nameHeader.classList.contains('record-table-th-desc')).toBe(false);
  });

  // --- colgroup and col-resizer ---
  it('renders a colgroup with one col per column', () => {
    const root = renderTable();
    const colgroup = root.querySelector('colgroup');
    expect(colgroup).not.toBeNull();
    // columns are ['_id', 'name', 'tags'] — 3 cols, no checkbox col (selectionMode off)
    expect(colgroup.querySelectorAll('col').length).toBe(3);
  });

  it('renders a colgroup with extra checkbox col when selectionMode is true', async () => {
    selectionMode.value = true;
    let root;
    await act(() => {
      root = renderTable({ columns: ['_id', 'name'] });
    });
    const colgroup = root.querySelector('colgroup');
    expect(colgroup).not.toBeNull();
    // 2 data cols + 1 checkbox col
    expect(colgroup.querySelectorAll('col').length).toBe(3);
  });

  it('renders a col-resizer span in each column header', () => {
    const root = renderTable();
    const ths = root.querySelectorAll('thead th');
    // 3 data columns — each should have a .col-resizer
    expect(ths.length).toBe(3);
    for (const th of ths) {
      expect(th.querySelector('.col-resizer')).not.toBeNull();
    }
  });

  // --- Filtered value highlight ---
  it('adds json-tree-value-filtered class to value span when column is in filterState', () => {
    const root = renderTable({ filterState: { name: 'Alice' } });
    // First row name cell value should be highlighted
    const rows = root.querySelectorAll('tbody tr');
    const firstRowNameCell = rows[0].querySelectorAll('td')[1];
    const valueSpan = firstRowNameCell.querySelector('.record-table-value');
    expect(valueSpan).not.toBeNull();
    expect(valueSpan.classList.contains('json-tree-value-filtered')).toBe(true);
    // Non-filtered column (_id) should not have the class
    const firstRowIdCell = rows[0].querySelectorAll('td')[0];
    const idValueSpan = firstRowIdCell.querySelector('.record-table-value');
    expect(idValueSpan).not.toBeNull();
    expect(idValueSpan.classList.contains('json-tree-value-filtered')).toBe(false);
  });

  // --- EJSON badge rendering ---
  it('renders ObjectId and Date cells with json-tree-badge and correct labels', async () => {
    let root;
    await act(() => {
      root = renderTable({
        records: [{ _id: { $oid: 'aaaaaaaaaaaaaaaaaaaaaaaa' }, when: { $date: '2020-01-01T00:00:00Z' } }],
        columns: ['_id', 'when'],
        sortState: {}, filterState: {},
      });
    });
    const badges = root.querySelectorAll('.json-tree-badge');
    const badgeTexts = Array.from(badges).map((b) => b.textContent);
    expect(badgeTexts).toContain('ObjectId');
    expect(badgeTexts).toContain('Date');
    // The formatted ObjectId value (hex string) should appear
    expect(root.textContent).toContain('aaaaaaaaaaaaaaaaaaaaaaaa');
    // The ISO date value should appear
    expect(root.textContent).toContain('2020-01-01T00:00:00.000Z');
  });

  // --- Copy button per cell ---
  it('renders a copy button in each data cell and clicking it writes the value to clipboard', async () => {
    let root;
    await act(() => {
      root = renderTable({
        records: [{ name: 'Alice' }],
        columns: ['name'],
      });
    });
    // Each data cell should have exactly one copy button inside the cell-inner wrapper
    const tds = root.querySelectorAll('tbody td');
    expect(tds.length).toBe(1);
    const copyBtn = tds[0].querySelector('.record-table-cell-inner > .json-tree-copy-btn');
    expect(copyBtn).not.toBeNull();

    // Click the copy button and check clipboard was called with the plain value
    await act(async () => {
      copyBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(copyTextFor('Alice'));
  });

  it('clicking the copy button does NOT trigger the cell onFilter', async () => {
    const onFilter = vi.fn();
    let root;
    await act(() => {
      root = renderTable({
        records: [{ name: 'Alice' }],
        columns: ['name'],
        onFilter,
      });
    });
    const tds = root.querySelectorAll('tbody td');
    const copyBtn = tds[0].querySelector('.record-table-cell-inner > .json-tree-copy-btn');
    expect(copyBtn).not.toBeNull();

    await act(async () => {
      copyBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onFilter).not.toHaveBeenCalled();
  });

  it('renders copy button in EJSON and complex cells and copies correctly', async () => {
    let root;
    await act(() => {
      root = renderTable({
        records: [{ _id: { $oid: 'aaaaaaaaaaaaaaaaaaaaaaaa' }, items: [{ sku: 'x' }] }],
        columns: ['_id', 'items'],
      });
    });

    // Check EJSON cell (_id) has copy button inside cell-inner wrapper
    const tds = root.querySelectorAll('tbody td');
    const idCell = tds[0];
    const idCopyBtn = idCell.querySelector('.record-table-cell-inner > .json-tree-copy-btn');
    expect(idCopyBtn).not.toBeNull();

    // Click EJSON copy button — should write the ObjectId value
    await act(async () => {
      idCopyBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(copyTextFor({ $oid: 'aaaaaaaaaaaaaaaaaaaaaaaa' }));

    // Reset clipboard mock
    navigator.clipboard.writeText.mockClear();

    // Check complex cell (items) has copy button inside cell-inner wrapper
    const itemsCell = tds[1];
    const itemsCopyBtn = itemsCell.querySelector('.record-table-cell-inner > .json-tree-copy-btn');
    expect(itemsCopyBtn).not.toBeNull();

    // Click complex copy button — should write the JSON string
    await act(async () => {
      itemsCopyBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(JSON.stringify([{ sku: 'x' }], null, 2));
  });

  it('reveals a special character in a string cell', () => {
    const root = renderTable({
      records: [{ _id: '1', name: 'a\u00a0b' }],
      columns: ['_id', 'name'],
    });
    const span = root.querySelector('.mdh-special.mdh-special-space');
    expect(span).not.toBeNull();
    expect(span.getAttribute('title')).toBe('U+00A0 NO-BREAK SPACE');
  });

  it('leaves a clean string cell untouched and still truncates long values', () => {
    const root = renderTable({
      records: [{ _id: '1', name: 'z'.repeat(25) }],
      columns: ['_id', 'name'],
    });
    expect(root.querySelectorAll('.mdh-special').length).toBe(0);
    expect(root.textContent).toContain('z'.repeat(20) + '...');
  });
});
