import { h } from 'preact';
import JsonTree, { displayValue } from './JsonTree.jsx';
import AiInsight from './AiInsight.jsx';
import { selectedCollection } from '../store.js';

function recordSummary(record) {
  const keys = Object.keys(record);
  const parts = keys.slice(0, 4).map((k) => `${k}: ${displayValue(record[k])}`);
  if (keys.length > 4) parts.push(`+${keys.length - 4} more`);
  return parts.join(' \u00b7 ');
}

export default function RecordCard({ record, index, expanded, onToggle, onCopy, onEdit, onDelete, sortState, filterState, onSort, onFilter }) {
  function handleCopy(e) {
    const btn = e.currentTarget;
    navigator.clipboard.writeText(JSON.stringify(record, null, 2)).then(() => {
      btn.textContent = '\u2713 Copied';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1000);
    });
  }

  return (
    <div class={'record-card' + (expanded ? ' record-card-expanded' : '')}>
      <div class="record-card-header" onClick={(e) => { if (!e.target.closest('.record-actions')) onToggle(index); }}>
        <span class="record-chevron">{expanded ? '\u25BC' : '\u25B6'}</span>
        <span class="record-summary">{recordSummary(record)}</span>
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
