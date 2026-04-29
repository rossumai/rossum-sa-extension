import { h } from 'preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import { STATUS_GLYPH } from '../mdh-provenance.js';

function CopyIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function OpenExternalIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M7 17L17 7M17 7H7M17 7v10" />
    </svg>
  );
}

export default function QueryItem({ index, label, status, onCopy, onOpen }) {
  const meta = STATUS_GLYPH[status?.status] || STATUS_GLYPH.pending;
  const hint = status?.hint;
  const showHint = meta.showHint && hint;

  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const flashTimer = useRef(null);
  useEffect(() => () => clearTimeout(flashTimer.current), []);

  const handleCopy = async (e) => {
    e.preventDefault();
    try {
      await onCopy();
      setCopyFailed(false);
      setCopied(true);
      clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopyFailed(true);
    }
  };

  const handleOpen = (e) => {
    e.preventDefault();
    onOpen();
  };

  const liClass = [
    'mdh-q',
    status?.status === 'winner' ? 'mdh-q--winner' : '',
    status?.status === 'skipped' ? 'mdh-q--skipped' : '',
  ].filter(Boolean).join(' ');

  const dotTitle = hint ? `${meta.title} — ${hint}` : meta.title;

  return (
    <li class={liClass}>
      <span class={`mdh-q-status ${meta.cls}`} title={dotTitle}>{meta.glyph}</span>
      <span class="mdh-q-num">{index + 1}.</span>
      <span class="mdh-q-name" title={label}>{label}</span>
      <span class="mdh-q-actions">
        <button
          type="button"
          class={`mdh-q-copy mdh-q-action${copied ? ' mdh-q-copy--ok' : ''}`}
          title={copyFailed ? 'Copy failed — clipboard blocked' : 'Copy pipeline (with current row values) to clipboard'}
          onClick={handleCopy}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
        <button
          type="button"
          class="mdh-q-open mdh-q-action"
          title="Open in Dataset Management with this pipeline prefilled"
          onClick={handleOpen}
        >
          <OpenExternalIcon />
        </button>
      </span>
      {showHint ? (
        <span
          class={`mdh-q-detail${status.status === 'error' ? ' mdh-q-detail--error' : ''}`}
          title={hint}
        >
          {hint}
        </span>
      ) : null}
    </li>
  );
}
