import { h } from 'preact';
import { useState, useMemo, useEffect } from 'preact/hooks';
import JsonTree, { countFields, AUTO_COLLAPSE_FIELD_THRESHOLD } from './JsonTree.jsx';
import { selectionMode } from '../store.js';
import { isRecordSelected, toggleRecordSelection } from '../recordSelection.js';
import { recordSummary, MIN_CHAR_BUDGET, EMPTY_SENTINEL } from '../recordSummary.js';
import type { SortFilterControls } from '../hooks/usePipeline.js';

export default function RecordCard({
  record,
  index,
  expanded,
  onToggle,
  onCopy,
  onEdit,
  onDelete,
  sortState,
  filterState,
  onSort,
  onFilter,
  charBudget,
  indexes,
  readOnly = false,
  collapsible = true,
}: {
  record: any;
  index?: number;
  expanded?: boolean;
  onToggle: (index?: number) => void;
  onCopy: (record: any) => void;
  onEdit: (record: any) => void;
  onDelete: (record: any, index?: number) => void;
  // Forwarded straight to JsonTree; the read-only Stages view omits the handlers.
  sortState: SortFilterControls['sortState'];
  filterState: SortFilterControls['filterState'];
  onSort?: SortFilterControls['onSort'];
  onFilter?: SortFilterControls['onFilter'];
  charBudget?: number;
  indexes?: any[];
  readOnly?: boolean;
  collapsible?: boolean;
}) {
  const fieldCount = useMemo(() => countFields(record), [record]);
  const isLarge = fieldCount > AUTO_COLLAPSE_FIELD_THRESHOLD;
  const [collapseDepth, setCollapseDepth] = useState(isLarge ? 1 : Infinity);
  const [treeKey, setTreeKey] = useState(0);

  // Reset collapse state when the underlying record changes (pagination reuses
  // RecordCard instances via index-based keys in RecordList).
  useEffect(() => {
    setCollapseDepth(isLarge ? 1 : Infinity);
    setTreeKey((k) => k + 1);
  }, [record]);

  const isSelectionMode = !readOnly && selectionMode.value;
  const isSelected = isSelectionMode && isRecordSelected(record);

  function toggleSelected(e: any) {
    e.stopPropagation();
    toggleRecordSelection(record);
  }

  function handleCopy(e: any) {
    const btn = e.currentTarget;
    navigator.clipboard.writeText(JSON.stringify(record, null, 2)).then(() => {
      btn.textContent = '\u2713 Copied';
      setTimeout(() => {
        btn.textContent = 'Copy';
      }, 1000);
    });
  }

  function toggleAll(e: any) {
    e.stopPropagation();
    setCollapseDepth((d) => (d === Infinity ? 1 : Infinity));
    setTreeKey((k) => k + 1);
  }

  const budget = typeof charBudget === 'number' && charBudget > 0 ? charBudget : MIN_CHAR_BUDGET;
  const summary = recordSummary(record, budget, { indexes });
  const isEmpty = summary === EMPTY_SENTINEL;
  const allExpanded = collapseDepth === Infinity;
  // When not collapsible (e.g. the Stages view), the card is permanently open: the
  // body always shows and the header is inert (no chevron, no collapse-on-click).
  const showBody = collapsible ? expanded : true;

  return (
    <div
      class={
        'record-card' +
        (showBody ? ' record-card-expanded' : '') +
        (collapsible ? '' : ' record-card-static') +
        (isSelected ? ' record-card-selected' : '')
      }
    >
      <div
        class="record-card-header"
        onClick={
          collapsible
            ? (e: any) => {
                if (!e.target.closest('.record-actions')) onToggle(index);
              }
            : undefined
        }
      >
        {isSelectionMode && (
          <input
            type="checkbox"
            class="record-checkbox"
            checked={isSelected}
            onClick={toggleSelected}
            onChange={() => {}}
            aria-label="Select record"
          />
        )}
        {collapsible && <span class="record-chevron">{showBody ? '\u25BC' : '\u25B6'}</span>}
        <span class={'record-summary' + (isEmpty ? ' record-summary-empty' : '')}>{summary}</span>
        <span class="record-actions">
          {showBody && isLarge && (
            <button
              class="action-toggle-all"
              title={allExpanded ? 'Collapse nested fields' : 'Expand all nested fields'}
              onClick={toggleAll}
            >
              {allExpanded ? 'Collapse' : 'Expand'}
            </button>
          )}
          <button class="action-copy" title="Copy record as JSON" onClick={handleCopy}>
            Copy
          </button>
          {!isSelectionMode && !readOnly && (
            <button
              class="action-edit"
              title="Edit with update expression"
              onClick={() => onEdit(record)}
            >
              Edit
            </button>
          )}
          {!isSelectionMode && !readOnly && (
            <button
              class="action-delete"
              title="Delete this record"
              onClick={() => onDelete(record, index)}
            >
              Del
            </button>
          )}
        </span>
      </div>
      {showBody && (
        <div class="record-card-body">
          <JsonTree
            key={treeKey}
            data={record}
            depth={0}
            collapseDepth={collapseDepth}
            sortState={sortState}
            filterState={filterState}
            onSort={onSort}
            onFilter={onFilter}
            readOnly={readOnly}
          />
        </div>
      )}
    </div>
  );
}
