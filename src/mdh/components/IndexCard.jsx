// src/mdh/components/IndexCard.jsx
import { h } from 'preact';
import { useState } from 'preact/hooks';
import { confirmModal } from './Modal.jsx';
import JsonEditor from './JsonEditor.jsx';

export default function IndexCard({ name, badges = [], definition, canDrop, onDrop }) {
  const [expanded, setExpanded] = useState(true);

  function handleCopy(e) {
    const btn = e.currentTarget;
    navigator.clipboard.writeText(JSON.stringify(definition, null, 2)).then(() => {
      btn.textContent = '\u2713 Copied';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1000);
    });
  }

  function handleDrop() {
    confirmModal(
      `Drop ${name}?`,
      `This will permanently drop "${name}". This cannot be undone.`,
      onDrop,
    );
  }

  return (
    <div class={'record-card' + (expanded ? ' record-card-expanded' : '')}>
      <div
        class="record-card-header"
        style="cursor:pointer"
        onClick={(e) => { if (!e.target.closest('.record-actions')) setExpanded(!expanded); }}
      >
        <span class="record-chevron">{expanded ? '\u25BC' : '\u25B6'}</span>
        <span class="record-summary">
          <strong>{name}</strong>
          {badges.map(({ text, cls }) => (
            <span class={'index-badge' + (cls ? ' ' + cls : '')} style="margin-left:6px">{text}</span>
          ))}
        </span>
        <span class="record-actions">
          {definition && <button class="action-copy" onClick={handleCopy}>Copy</button>}
          {canDrop && onDrop && <button class="action-delete" onClick={handleDrop}>Del</button>}
        </span>
      </div>
      {expanded && definition && (
        <div class="record-card-body">
          <JsonEditor value={JSON.stringify(definition, null, 2)} compact readOnly minHeight="0" />
        </div>
      )}
    </div>
  );
}
