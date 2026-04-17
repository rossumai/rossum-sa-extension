import { h } from 'preact';
import { useState, useMemo, useEffect } from 'preact/hooks';
import JsonTree, { countFields, AUTO_COLLAPSE_FIELD_THRESHOLD } from './JsonTree.jsx';
import AiInsight from './AiInsight.jsx';
import { selectedCollection } from '../store.js';
import { recordSummary, MIN_CHAR_BUDGET, EMPTY_SENTINEL } from '../recordSummary.js';

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

  function handleCopy(e) {
    const btn = e.currentTarget;
    navigator.clipboard.writeText(JSON.stringify(record, null, 2)).then(() => {
      btn.textContent = '\u2713 Copied';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1000);
    });
  }

  function toggleAll(e) {
    e.stopPropagation();
    setCollapseDepth((d) => (d === Infinity ? 1 : Infinity));
    setTreeKey((k) => k + 1);
  }

  const budget = typeof charBudget === 'number' && charBudget > 0 ? charBudget : MIN_CHAR_BUDGET;
  const summary = recordSummary(record, budget, { indexes });
  const isEmpty = summary === EMPTY_SENTINEL;
  const allExpanded = collapseDepth === Infinity;

  return (
    <div class={'record-card' + (expanded ? ' record-card-expanded' : '')}>
      <div class="record-card-header" onClick={(e) => { if (!e.target.closest('.record-actions')) onToggle(index); }}>
        <span class="record-chevron">{expanded ? '\u25BC' : '\u25B6'}</span>
        <span class={'record-summary' + (isEmpty ? ' record-summary-empty' : '')}>{summary}</span>
        <span class="record-actions">
          {expanded && isLarge && (
            <button
              class="action-toggle-all"
              title={allExpanded ? 'Collapse nested fields' : 'Expand all nested fields'}
              onClick={toggleAll}
            >{allExpanded ? 'Collapse' : 'Expand'}</button>
          )}
          <button class="action-copy" title="Copy record as JSON" onClick={handleCopy}>Copy</button>
          <button class="action-edit" title="Edit with update expression" onClick={() => onEdit(record)}>Edit</button>
          <button class="action-delete" title="Delete this record" onClick={() => onDelete(record, index)}>Del</button>
        </span>
      </div>
      {expanded && (
        <div class="record-card-body" style="position:relative">
          <AiInsight input={record} type="record" mode="overlay" context={selectedCollection.value} />
          <JsonTree
            key={treeKey}
            data={record}
            depth={0}
            collapseDepth={collapseDepth}
            sortState={sortState}
            filterState={filterState}
            onSort={onSort}
            onFilter={onFilter}
          />
        </div>
      )}
    </div>
  );
}
