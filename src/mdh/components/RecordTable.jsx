import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { displayValue, getEjsonType, formatEjsonValue, EJSON_TYPES, copyTextFor } from '../displayValue.js';
import { selectionMode } from '../store.js';
import { isRecordSelected, toggleRecordSelection } from '../recordSelection.js';
import JsonTree, { CopyButton } from './JsonTree.jsx';

const DEFAULT_COL_WIDTH = 180;
const MIN_COL_WIDTH = 60;

function isComplexValue(value) {
  return value && typeof value === 'object' && !getEjsonType(value);
}

export default function RecordTable({ records, columns, sortState, filterState, onSort, onFilter }) {
  const [expanded, setExpanded] = useState(() => new Set());
  const [colWidths, setColWidths] = useState({});
  const colWidthsRef = useRef({});
  const selecting = selectionMode.value;

  // Reset inline-expand state when the data changes (pagination / new query
  // reuses this component instance) so stale "i:col" keys don't pre-expand cells.
  useEffect(() => { setExpanded(new Set()); }, [records]);

  // Reset column widths only when the column SET changes (not on every render).
  const colKey = columns.join('|');
  useEffect(() => { colWidthsRef.current = {}; setColWidths({}); }, [colKey]);

  function toggleExpand(key) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function sortBadge(col) {
    const dir = sortState && sortState[col];
    if (!dir) return null;
    return (
      <span class={'record-table-sort-badge ' + (dir === 1 ? 'asc' : 'desc')}>
        {dir === 1 ? '↑' : '↓'}
      </span>
    );
  }

  function startColResize(col, e) {
    e.preventDefault();
    e.stopPropagation();
    const th = e.currentTarget.closest('th');
    const startX = e.clientX;
    const startW = colWidthsRef.current[col] || (th ? Math.round(th.getBoundingClientRect().width) : DEFAULT_COL_WIDTH);
    const handle = e.currentTarget;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    function onMove(ev) {
      const w = Math.max(MIN_COL_WIDTH, Math.round(startW + ev.clientX - startX));
      colWidthsRef.current = { ...colWidthsRef.current, [col]: w };
      setColWidths(colWidthsRef.current);
    }
    function onUp() {
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function resetCol(col) {
    const next = { ...colWidthsRef.current };
    delete next[col];
    colWidthsRef.current = next;
    setColWidths(next);
  }

  function renderCell(rec, col, i) {
    const value = rec[col];
    const filtered = !!(filterState && col in filterState);

    if (isComplexValue(value)) {
      const key = i + ':' + col;
      const isExp = expanded.has(key);
      return (
        <td key={col} class={'record-table-cell-complex' + (isExp ? ' record-table-cell-expanded' : '')}>
          <div class="record-table-cell-inner">
            <span class="record-table-badge" onClick={(e) => { e.stopPropagation(); toggleExpand(key); }} title={isExp ? 'Collapse' : 'Expand'}>
              <span class="record-table-caret">{isExp ? '▼' : '▶'}</span>{' ' + displayValue(value)}
            </span>
            <CopyButton getText={() => JSON.stringify(value, null, 2)} kind="json" />
          </div>
          {isExp && (
            <div class="record-table-nested">
              <JsonTree data={value} depth={0} collapseDepth={1} sortState={sortState} filterState={filterState} onSort={onSort} onFilter={onFilter} />
            </div>
          )}
        </td>
      );
    }

    const ejson = getEjsonType(value);
    if (ejson) {
      const info = EJSON_TYPES[ejson];
      const formatted = formatEjsonValue(value, ejson);
      return (
        <td key={col}>
          <div class="record-table-cell-inner">
            <span class={'json-tree-badge ' + info.css}>{info.label}</span>
            <span class={'record-table-value ' + info.css + (filtered ? ' json-tree-value-filtered' : '')}>{formatted}</span>
            <CopyButton getText={() => copyTextFor(value)} kind="value" />
          </div>
        </td>
      );
    }

    return (
      <td key={col} class="record-table-cell-clickable"
        onClick={() => onFilter(col, value)}
        title={filtered ? `Filtering by ${col} — click to remove` : `Click to filter by ${col}`}>
        <div class="record-table-cell-inner">
          <span class={'record-table-value' + (filtered ? ' json-tree-value-filtered' : '')}>{displayValue(value)}</span>
          <CopyButton getText={() => copyTextFor(value)} kind="value" />
        </div>
      </td>
    );
  }

  return (
    <div class="record-table-wrap" style="overflow:auto">
      <table class="record-table">
        <colgroup>
          {selecting && <col style="width:36px" />}
          {columns.map((col) => (
            <col key={col} style={`width:${colWidths[col] || DEFAULT_COL_WIDTH}px`} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {selecting && <th class="record-table-check" aria-label="select"></th>}
            {columns.map((col) => (
              <th key={col} class="record-table-th" onClick={() => onSort(col)} title="Click to sort">
                {col}{sortBadge(col)}
                <span
                  class="col-resizer"
                  title="Drag to resize · double-click to reset"
                  onMouseDown={(e) => startColResize(col, e)}
                  onClick={(e) => e.stopPropagation()}
                  onDblClick={(e) => { e.stopPropagation(); resetCol(col); }}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {records.map((rec, i) => (
            <tr key={i} class={selecting && isRecordSelected(rec) ? 'record-table-row-selected' : undefined}>
              {selecting && (
                <td class="record-table-check">
                  <input type="checkbox" class="record-checkbox" checked={isRecordSelected(rec)}
                    onClick={(e) => { e.stopPropagation(); toggleRecordSelection(rec); }} onChange={() => {}} aria-label="Select record" />
                </td>
              )}
              {columns.map((col) => renderCell(rec, col, i))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
