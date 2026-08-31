// src/mdh/components/IndexCard.tsx
import { h } from 'preact';
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { confirmModal } from './Modal.jsx';
import JsonEditor from './JsonEditor.jsx';

export default function IndexCard({
  name,
  badges = [],
  definition,
  canDrop,
  onDrop,
  onEdit,
  cardClass,
  meta,
  notice,
  summary,
}: {
  name: string;
  badges?: any[];
  definition?: any;
  canDrop?: boolean;
  onDrop?: () => void;
  onEdit?: () => void;
  cardClass?: string;
  meta?: any;
  // Rendered between header and body, and visible whether or not the card is
  // expanded — it carries state the reader must not have to open the card to see.
  notice?: ComponentChildren;
  // A one-line "what does this cover?" shown beside the name, so a collapsed
  // card still says which index is which.
  summary?: string;
}) {
  const [expanded, setExpanded] = useState(true);

  function handleCopy(e: any) {
    const btn = e.currentTarget;
    navigator.clipboard.writeText(JSON.stringify(definition, null, 2)).then(() => {
      btn.textContent = '\u2713 Copied';
      setTimeout(() => {
        btn.textContent = 'Copy';
      }, 1000);
    });
  }

  function handleDrop() {
    confirmModal(
      `Drop ${name}?`,
      `This will permanently drop "${name}". This cannot be undone.`,
      onDrop!,
    );
  }

  return (
    <div
      class={
        'record-card' +
        (expanded ? ' record-card-expanded' : '') +
        (cardClass ? ' ' + cardClass : '')
      }
    >
      <div
        class="record-card-header"
        style="cursor:pointer"
        onClick={(e: any) => {
          if (!e.target.closest('.record-actions')) setExpanded(!expanded);
        }}
      >
        <span class="record-chevron">{expanded ? '\u25BC' : '\u25B6'}</span>
        <span class="record-summary">
          <strong>{name}</strong>
          {summary ? <span style="margin-left:8px">{summary}</span> : null}
          {badges.map(({ text, cls, title }) => (
            <span
              class={'index-badge' + (cls ? ' ' + cls : '')}
              style="margin-left:6px"
              title={title || undefined}
            >
              {text}
            </span>
          ))}
        </span>
        {meta && <span class="index-card-meta">{meta}</span>}
        <span class="record-actions">
          {onEdit && (
            <button class="action-edit" onClick={onEdit}>
              Edit
            </button>
          )}
          {definition && (
            <button class="action-copy" onClick={handleCopy}>
              Copy
            </button>
          )}
          {canDrop && onDrop && (
            <button class="action-delete" onClick={handleDrop}>
              Del
            </button>
          )}
        </span>
      </div>
      {notice && <div class="record-card-notice">{notice}</div>}
      {expanded && definition && (
        <div class="record-card-body">
          <JsonEditor value={JSON.stringify(definition, null, 2)} compact readOnly minHeight="0" />
        </div>
      )}
    </div>
  );
}
