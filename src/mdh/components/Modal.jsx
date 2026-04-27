// src/mdh/components/Modal.jsx
import { h } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { modalContent } from '../store.js';

export function closeModal() {
  const m = modalContent.value;
  if (!m) return;
  modalContent.value = null;
  // Fire any registered close hook (used by promisified helpers to resolve).
  // Read before nulling so re-entrant closeModal calls are no-ops.
  if (m.onClose) m.onClose();
}

// Returns a Promise<boolean> that resolves to true on Confirm and false on
// Cancel / Escape / overlay-click / X. The legacy `onConfirm` callback is
// still invoked on Confirm so existing call sites keep working.
export function confirmModal(title, message, onConfirm) {
  return new Promise((resolve) => {
    let confirmed = false;
    modalContent.value = {
      title,
      render: () => (
        <div class="modal-body">
          <p class="modal-message">{message}</p>
          <div class="modal-actions">
            <button class="btn btn-secondary" onClick={closeModal}>Cancel</button>
            <button class="btn btn-danger" onClick={() => { confirmed = true; closeModal(); }}>Confirm</button>
          </div>
        </div>
      ),
      onClose: () => {
        if (confirmed && onConfirm) onConfirm();
        resolve(confirmed);
      },
    };
  });
}

// Returns a Promise that resolves to the submitted value when the modal
// closes after a successful submission, or to null on cancel/escape/overlay/X.
// Existing callback-style callers keep working — the legacy `onSubmit` is
// invoked first and may keep the modal open for async validation.
export function promptModal(title, { placeholder, initialValue, submitLabel, submitClass, message }, onSubmit) {
  return new Promise((resolve) => {
    let submittedValue = null;
    const wrappedSubmit = (val, hint) => {
      submittedValue = val;
      if (onSubmit) onSubmit(val, hint);
    };
    modalContent.value = {
      title,
      render: () => <PromptBody message={message} placeholder={placeholder} initialValue={initialValue} submitLabel={submitLabel} submitClass={submitClass} onSubmit={wrappedSubmit} />,
      onClose: () => resolve(submittedValue),
    };
  });
}

function PromptBody({ message, placeholder, initialValue, submitLabel, submitClass, onSubmit }) {
  const inputRef = useRef(null);
  const hintRef = useRef(null);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
      if (initialValue) inputRef.current.select();
    }
  }, []);

  function doSubmit() {
    const val = inputRef.current.value.trim();
    if (!val) {
      if (hintRef.current) {
        hintRef.current.textContent = 'Please enter a value';
        hintRef.current.style.color = 'var(--danger)';
      }
      inputRef.current.focus();
      return;
    }
    if (val === initialValue) { closeModal(); return; }
    onSubmit(val, hintRef.current);
  }

  return (
    <div class="modal-body">
      {message && <p class="modal-message">{message}</p>}
      <input
        ref={inputRef}
        class="input"
        style="width:100%"
        placeholder={placeholder || ''}
        value={initialValue || ''}
        onKeyDown={(e) => { if (e.key === 'Enter') doSubmit(); }}
      />
      <div ref={hintRef} class="input-hint"></div>
      <div class="modal-actions">
        <button class="btn btn-secondary" onClick={closeModal}>Cancel</button>
        <button class={`btn ${submitClass || 'btn-primary'}`} onClick={doSubmit}>{submitLabel || 'OK'}</button>
      </div>
    </div>
  );
}

export function openModal(title, renderFn) {
  modalContent.value = { title, render: renderFn };
}

export default function Modal() {
  const modal = modalContent.value;

  useEffect(() => {
    if (!modal) return;
    const onKey = (e) => { if (e.key === 'Escape') closeModal(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [modal]);

  if (!modal) return null;

  return (
    <div class="modal-overlay visible" onClick={(e) => { if (e.target === e.currentTarget) closeModal(); }}>
      <div class="modal-card">
        <div class="modal-header">
          <span class="modal-title">{modal.title}</span>
          <button class="modal-close" onClick={closeModal}>{'\u00d7'}</button>
        </div>
        {modal.render()}
      </div>
    </div>
  );
}
