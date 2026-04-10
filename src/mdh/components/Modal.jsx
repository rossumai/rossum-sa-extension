// src/mdh/components/Modal.jsx
import { h } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { modalContent } from '../store.js';

export function closeModal() {
  modalContent.value = null;
}

export function confirmModal(title, message, onConfirm) {
  modalContent.value = {
    title,
    render: () => (
      <div class="modal-body">
        <p class="modal-message">{message}</p>
        <div class="modal-actions">
          <button class="btn btn-secondary" onClick={closeModal}>Cancel</button>
          <button class="btn btn-danger" onClick={() => { closeModal(); onConfirm(); }}>Confirm</button>
        </div>
      </div>
    ),
  };
}

export function promptModal(title, { placeholder, initialValue, submitLabel, submitClass }, onSubmit) {
  modalContent.value = {
    title,
    render: () => <PromptBody placeholder={placeholder} initialValue={initialValue} submitLabel={submitLabel} submitClass={submitClass} onSubmit={onSubmit} />,
  };
}

function PromptBody({ placeholder, initialValue, submitLabel, submitClass, onSubmit }) {
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
    if (!val || val === initialValue) { closeModal(); return; }
    onSubmit(val, hintRef.current);
  }

  return (
    <div class="modal-body">
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
