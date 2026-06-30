import { h, Fragment } from 'preact';
import { useState, useRef } from 'preact/hooks';

// Shared picker box for the MDH file-import modals. Renders the hidden file
// input + the dashed `.file-input-area`, owns click-to-open, drag-over
// highlighting, and drop-time extension validation. The click path is
// intentionally NOT validated (the OS dialog already filters by `accept`);
// only the drop path checks the extension.

// The dotted tokens of an `accept` string (".csv,text/csv" -> [".csv"]),
// lowercased. MIME tokens are ignored for matching.
export function allowedExtensions(accept) {
  return (accept || '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.startsWith('.'));
}

// Human-readable rejection message for a wrong-type drop.
export function formatExpected(exts) {
  if (exts.length === 0) return 'Unsupported file type';
  if (exts.length === 1) return `Expected a ${exts[0]} file`;
  if (exts.length === 2) return `Expected a ${exts[0]} or ${exts[1]} file`;
  return `Expected a ${exts.slice(0, -1).join(', ')}, or ${exts[exts.length - 1]} file`;
}

// True if `name` ends with one of `exts` (case-insensitive). No exts -> accept.
export function extensionMatches(name, exts) {
  if (exts.length === 0) return true;
  const lower = (name || '').toLowerCase();
  return exts.some((ext) => lower.endsWith(ext));
}

export default function FileDropArea({ accept, onFile, onReject, inputTestid, children }) {
  const inputRef = useRef(null);
  const dragDepth = useRef(0); // nested enter/leave counter — avoids flicker
  const [dragging, setDragging] = useState(false);
  const exts = allowedExtensions(accept);

  // Only react to drags that actually carry files (not page-element drags).
  function hasFiles(e) {
    const types = e.dataTransfer && e.dataTransfer.types;
    if (!types) return false;
    return Array.from(types).includes('Files');
  }

  // Click path: unchanged — forward the first file with no validation.
  function pick(e) {
    const f = e.target.files && e.target.files[0];
    if (f) onFile(f);
  }

  function onDragEnter(e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }

  function onDragOver(e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }

  function onDragLeave(e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }

  function onDrop(e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation(); // handled once; never reaches the overlay guard
    dragDepth.current = 0;
    setDragging(false);
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    if (!extensionMatches(f.name, exts)) {
      if (onReject) onReject(formatExpected(exts));
      return;
    }
    onFile(f);
  }

  return (
    <Fragment>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        style="display:none"
        onChange={pick}
        data-testid={inputTestid}
      />
      <div
        class={`file-input-area${dragging ? ' drag-over' : ''}`}
        onClick={() => inputRef.current && inputRef.current.click()}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {children}
      </div>
    </Fragment>
  );
}
