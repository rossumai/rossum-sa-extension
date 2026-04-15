import { h } from 'preact';
import JsonTree from './JsonTree.jsx';
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
  function handleCopy(e) {
    const btn = e.currentTarget;
    navigator.clipboard.writeText(JSON.stringify(record, null, 2)).then(() => {
      btn.textContent = '\u2713 Copied';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1000);
    });
  }

  const budget = typeof charBudget === 'number' && charBudget > 0 ? charBudget : MIN_CHAR_BUDGET;
  const summary = recordSummary(record, budget, { indexes });
  const isEmpty = summary === EMPTY_SENTINEL;

  return (
    <div class={'record-card' + (expanded ? ' record-card-expanded' : '')}>
      <div class="record-card-header" onClick={(e) => { if (!e.target.closest('.record-actions')) onToggle(index); }}>
        <span class="record-chevron">{expanded ? '\u25BC' : '\u25B6'}</span>
        <span class={'record-summary' + (isEmpty ? ' record-summary-empty' : '')}>{summary}</span>
        <span class="record-actions">
          <button class="action-copy" title="Copy record as JSON" onClick={handleCopy}>Copy</button>
          <button class="action-edit" title="Edit with update expression" onClick={() => onEdit(record)}>Edit</button>
          <button class="action-delete" title="Delete this record" onClick={() => onDelete(record, index)}>Del</button>
        </span>
      </div>
      {expanded && (
        <div class="record-card-body" style="position:relative">
          <AiInsight input={record} type="record" mode="overlay" context={selectedCollection.value} />
          <JsonTree data={record} sortState={sortState} filterState={filterState} onSort={onSort} onFilter={onFilter} />
        </div>
      )}
    </div>
  );
}
