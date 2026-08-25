import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import {
  displayValue,
  getEjsonType,
  formatEjsonValue,
  EJSON_TYPES,
  copyTextFor,
} from '../displayValue.js';
import { selectionMode } from '../store.js';
import { isRecordSelected, toggleRecordSelection } from '../recordSelection.js';
import { computeColumnWidths, clampAutoFit } from '../recordTableLayout.js';
import JsonTree, { CopyButton } from './JsonTree.jsx';
import SpecialText from './SpecialText.jsx';
import type { SortFilterControls } from '../hooks/usePipeline.js';

const DEFAULT_COL_WIDTH = 180;
const MIN_COL_WIDTH = 60;
const MAX_AUTOFIT_WIDTH = 600;
// Upper bound on characters rendered into a single string cell. The column width
// + CSS ellipsis decide what's actually visible; this only caps DOM size for
// pathologically long values (the full value is always available via Copy).
const CELL_TEXT_CAP = 500;

function isComplexValue(value: any) {
  return value && typeof value === 'object' && !getEjsonType(value);
}

export default function RecordTable({
  records,
  columns,
  sortState,
  filterState,
  onSort,
  onFilter,
}: SortFilterControls & {
  records: any[];
  columns: string[];
}) {
  const [expanded, setExpanded] = useState(() => new Set());
  const [colWidths, setColWidths] = useState<Record<string, number>>({});
  const colWidthsRef = useRef({});
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [availW, setAvailW] = useState(0);
  const selecting = selectionMode.value;

  // Reset inline-expand state when the data changes (pagination / new query
  // reuses this component instance) so stale "i:col" keys don't pre-expand cells.
  useEffect(() => {
    setExpanded(new Set());
  }, [records]);

  // Reset column widths only when the column SET changes (not on every render).
  const colKey = columns.join('|');
  useEffect(() => {
    colWidthsRef.current = {};
    setColWidths({});
  }, [colKey]);

  // Track the wrap's available width so the computed filler (last) column always
  // fills the pane — re-measures when the pane resizes (pipeline splitter,
  // sidebar, window). Only affects the resized state; harmless otherwise.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setAvailW(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  function toggleExpand(key: any) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function sortBadge(col: any) {
    const dir = sortState && sortState[col];
    if (!dir) return null;
    return (
      <span class={'record-table-sort-badge ' + (dir === 1 ? 'asc' : 'desc')}>
        {dir === 1 ? '↑' : '↓'}
      </span>
    );
  }

  // Enter the "resized" state: freeze every NON-LAST column to its current
  // rendered width so a subsequent drag / AutoFit tracks 1:1 with no
  // redistribution. The last column is deliberately left unfrozen — it becomes
  // the computed filler (see computeColumnWidths) that always absorbs the slack,
  // so the table fills the pane exactly (no trailing gap) instead of switching to
  // width:max-content. Until the first resize the table stretches all columns to
  // fill the wrap, so we capture those stretched widths as the starting point.
  function freezeNonLast(th: any) {
    const widths = colWidthsRef.current;
    if (Object.keys(widths).length > 0) return widths; // already in resized state
    const headRow = th && th.closest('tr');
    const ths = headRow ? headRow.querySelectorAll('th.record-table-th') : null;
    const lastIdx = columns.length - 1;
    const frozen: Record<string, number> = {};
    columns.forEach((c, idx) => {
      if (idx === lastIdx) return; // last column is the computed filler
      const el = ths && ths[idx];
      frozen[c] = el ? Math.round(el.getBoundingClientRect().width) : DEFAULT_COL_WIDTH;
    });
    colWidthsRef.current = frozen;
    setColWidths(frozen);
    return frozen;
  }

  function startColResize(col: any, e: any) {
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget;
    const th = handle.closest('th');

    const widths: Record<string, number> = freezeNonLast(th);
    const startX = e.clientX;
    const startW = widths[col] != null ? widths[col] : DEFAULT_COL_WIDTH;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    function onMove(ev: any) {
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

  // Measure a column's intrinsic content width (header label + loaded body
  // cells). We lay the cells out in an offscreen table-layout:auto ghost table
  // that reuses the same `.record-table` classes, so every cell variant (plain
  // value, EJSON badge, complex badge, copy-button slot) sizes exactly as it
  // would in the real table. We can't read scrollWidth on the live cells: with
  // table-layout:fixed and the flex `min-width:0` value clamp, scrollWidth only
  // ever reports the current column width, never the (possibly smaller) content.
  // Expanded complex cells switch to white-space:normal and would mis-measure,
  // so they're skipped.
  function measureColumnContent(table: any, colPos: any, label: any) {
    const ghost = document.createElement('table');
    ghost.className = 'record-table';
    ghost.style.cssText =
      'position:fixed;left:-99999px;top:0;visibility:hidden;table-layout:auto;width:auto;min-width:0;';
    const tbody = document.createElement('tbody');

    const headTr = document.createElement('tr');
    const headTd = document.createElement('td');
    headTd.textContent = label;
    headTr.appendChild(headTd);
    tbody.appendChild(headTr);

    table.querySelectorAll('tbody tr').forEach((tr: any) => {
      const cell = tr.children[colPos];
      if (!cell || cell.classList.contains('record-table-cell-expanded')) return;
      const tr2 = document.createElement('tr');
      tr2.appendChild(cell.cloneNode(true));
      tbody.appendChild(tr2);
    });

    ghost.appendChild(tbody);
    document.body.appendChild(ghost);
    let w = 0;
    ghost.querySelectorAll('td').forEach((td) => {
      const cw = td.getBoundingClientRect().width;
      if (cw > w) w = cw;
    });
    document.body.removeChild(ghost);
    return w;
  }

  // Double-click a column's handle → AutoFit (Excel-style): size the column to
  // its widest content, clamped to [MIN, MAX] so one long value can't blow out
  // the layout. The last column is the filler and has no handle.
  function autoFitCol(col: any, e: any) {
    const th = e.currentTarget.closest('th');
    const table = th && th.closest('table');
    if (!th || !table) return;
    const idx = columns.indexOf(col);
    if (idx < 0 || idx === columns.length - 1) return; // last column is the filler
    const colPos = (selectionMode.value ? 1 : 0) + idx; // offset for the checkbox column

    const widths = freezeNonLast(th);
    const measured = measureColumnContent(table, colPos, col);

    const next = { ...widths, [col]: clampAutoFit(measured, MIN_COL_WIDTH, MAX_AUTOFIT_WIDTH) };
    colWidthsRef.current = next;
    setColWidths(next);
  }

  function renderCell(rec: any, col: any, i: any) {
    const value = rec[col];
    const filtered = !!(filterState && col in filterState);

    if (isComplexValue(value)) {
      const key = i + ':' + col;
      const isExp = expanded.has(key);
      return (
        <td
          key={col}
          class={'record-table-cell-complex' + (isExp ? ' record-table-cell-expanded' : '')}
        >
          <div class="record-table-cell-inner">
            <span
              class="record-table-badge"
              onClick={(e) => {
                e.stopPropagation();
                toggleExpand(key);
              }}
              title={isExp ? 'Collapse' : 'Expand'}
            >
              <span class="record-table-caret">{isExp ? '▼' : '▶'}</span>
              {' ' + displayValue(value)}
            </span>
            <CopyButton getText={() => JSON.stringify(value, null, 2)} kind="json" />
          </div>
          {isExp && (
            <div class="record-table-nested">
              <JsonTree
                data={value}
                depth={0}
                collapseDepth={1}
                sortState={sortState}
                filterState={filterState}
                onSort={onSort}
                onFilter={onFilter}
              />
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
            <span
              class={
                'record-table-value ' + info.css + (filtered ? ' json-tree-value-filtered' : '')
              }
            >
              {formatted}
            </span>
            <span class={'value-type-tag ' + info.css} title={info.label}>
              {info.short}
            </span>
            <CopyButton getText={() => copyTextFor(value)} kind="value" />
          </div>
        </td>
      );
    }

    // Missing field (column exists in the union of keys but is absent from this
    // record) → em dash, no copy/filter. Distinct from an explicit null value.
    if (!Object.prototype.hasOwnProperty.call(rec, col) || value === undefined) {
      return (
        <td key={col}>
          <div class="record-table-cell-inner">
            <span class="record-table-value json-tree-value-null" title="field omitted">
              {'—'}
            </span>
          </div>
        </td>
      );
    }

    // Special / typed scalar values get the same color classes the JSON tree and
    // EJSON tags use, so plain and typed values read consistently. Long strings
    // are NOT hard-truncated here — the column width + CSS ellipsis govern how
    // much shows (resize / double-click AutoFit to reveal more); copy still
    // yields the full value. CELL_TEXT_CAP only bounds the DOM for huge strings.
    let inner;
    if (value === null) {
      inner = <span class="record-table-value json-tree-value-null">null</span>;
    } else if (value === '') {
      inner = (
        <span class="record-table-value json-tree-value-null" title="empty string">
          (empty)
        </span>
      );
    } else if (typeof value === 'number') {
      inner = (
        <span
          class={
            'record-table-value json-tree-value-number' +
            (filtered ? ' json-tree-value-filtered' : '')
          }
        >
          {String(value)}
        </span>
      );
    } else if (typeof value === 'boolean') {
      inner = (
        <span
          class={
            'record-table-value json-tree-value-bool' +
            (filtered ? ' json-tree-value-filtered' : '')
          }
        >
          {String(value)}
        </span>
      );
    } else if (typeof value === 'string') {
      inner = (
        <span class={'record-table-value' + (filtered ? ' json-tree-value-filtered' : '')}>
          <SpecialText value={value} quote limit={CELL_TEXT_CAP} />
        </span>
      );
    } else {
      inner = (
        <span class={'record-table-value' + (filtered ? ' json-tree-value-filtered' : '')}>
          {displayValue(value)}
        </span>
      );
    }

    return (
      <td
        key={col}
        class="record-table-cell-clickable"
        onClick={() => onFilter(col, value)}
        title={filtered ? `Filtering by ${col} — click to remove` : `Click to filter by ${col}`}
      >
        <div class="record-table-cell-inner">
          {inner}
          <CopyButton getText={() => copyTextFor(value)} kind="value" />
        </div>
      </td>
    );
  }

  // In the resized state, derive explicit widths with the last column as the
  // computed filler; in the default state keep every column at the default width
  // so the table-layout:fixed + width:100% base stretches them equally to fill.
  const resized = Object.keys(colWidths).length > 0;
  let widthArr = null;
  if (resized && columns.length > 0) {
    const nonLastWidths = columns.slice(0, -1).map((c) => colWidths[c] || DEFAULT_COL_WIDTH);
    widthArr = computeColumnWidths({
      availW,
      selectionW: selecting ? 36 : 0,
      nonLastWidths,
      min: MIN_COL_WIDTH,
    });
  }

  return (
    <div class="record-table-wrap" ref={wrapRef} style="overflow:auto">
      <table class="record-table">
        <colgroup>
          {selecting && <col style="width:36px" />}
          {columns.map((col, idx) => (
            <col key={col} style={`width:${widthArr ? widthArr[idx] : DEFAULT_COL_WIDTH}px`} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {selecting && <th class="record-table-check" aria-label="select"></th>}
            {columns.map((col, idx) => (
              <th
                key={col}
                class="record-table-th"
                onClick={() => onSort(col)}
                title="Click to sort"
              >
                {col}
                {sortBadge(col)}
                {idx !== columns.length - 1 && (
                  <span
                    class="col-resizer"
                    title="Drag to resize · double-click to fit content"
                    onMouseDown={(e) => startColResize(col, e)}
                    onClick={(e) => e.stopPropagation()}
                    onDblClick={(e) => {
                      e.stopPropagation();
                      autoFitCol(col, e);
                    }}
                  />
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {records.map((rec, i) => (
            <tr
              key={i}
              class={selecting && isRecordSelected(rec) ? 'record-table-row-selected' : undefined}
            >
              {selecting && (
                <td class="record-table-check">
                  <input
                    type="checkbox"
                    class="record-checkbox"
                    checked={isRecordSelected(rec)}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleRecordSelection(rec);
                    }}
                    onChange={() => {}}
                    aria-label="Select record"
                  />
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
