// Shared modal system (extracted from src/mdh so any Console app can reuse it —
// MDH re-exports this; Fabry Architect uses confirmModal for deletes). Styling is
// the self-contained CSS Module Modal.module.css; consumers compose modal content
// with the presentational sub-components below (ModalBody / ModalActions / …) and
// never reference the (now-scoped) class names. .btn-* live in console.css.
import { h, type ComponentChildren } from 'preact';
import { signal } from '@preact/signals';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import styles from './Modal.module.css';

// The one open modal: a title, a render function, and an optional close hook the
// promisified helpers (confirmModal / promptModal) use to resolve.
export type ModalContent = {
  title: string;
  render: () => ComponentChildren;
  onClose?: () => void;
};
export const modalContent = signal<ModalContent | null>(null);

// ── Presentational building blocks (own the scoped modal-* styles) ──────────
export function ModalBody(
  { children, class: cls, style, rootRef }:
  { children?: ComponentChildren; class?: string; style?: any; rootRef?: any },
) {
  return <div class={styles.body + (cls ? ' ' + cls : '')} style={style} ref={rootRef}>{children}</div>;
}
export function ModalActions({ children }: { children?: ComponentChildren }) {
  return <div class={styles.actions}>{children}</div>;
}
export function ModalMessage({ children }: { children?: ComponentChildren }) {
  return <p class={styles.message}>{children}</p>;
}
export function ModalFieldLabel({ children, style }: { children?: ComponentChildren; style?: any }) {
  return <div class={styles.fieldLabel} style={style}>{children}</div>;
}
export function ModalLoading({ children }: { children?: ComponentChildren }) {
  return <div class={styles.message + ' ' + styles.messageLoading}><span class={styles.inlineSpinner} aria-hidden="true" />{children}</div>;
}
export function ModalClose({ onClick, label }: { onClick: () => void; label?: string }) {
  return <button type="button" class={styles.close} aria-label={label || 'Close'} onClick={onClick}>{'×'}</button>;
}
// The import wizard's header identity strip (file name · size · rows · cols).
export function ModalFileTitle({ name, meta }: { name?: string; meta?: ComponentChildren }) {
  return (
    <span class={styles.titleSource} data-testid="source-strip">
      <span class={styles.titleFile}>{name}</span>
      <span class={styles.titleMeta}>{meta}</span>
    </span>
  );
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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
export function confirmModal(title: string, message: ComponentChildren, onConfirm: () => void) {
  return new Promise((resolve) => {
    let confirmed = false;
    modalContent.value = {
      title,
      render: () => (
        <ModalBody>
          <ModalMessage>{message}</ModalMessage>
          <ModalActions>
            <button class="btn btn-secondary" onClick={closeModal}>Cancel</button>
            <button class="btn btn-danger" onClick={() => { confirmed = true; closeModal(); }}>Confirm</button>
          </ModalActions>
        </ModalBody>
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
export function promptModal(
  title: string,
  { placeholder, initialValue, submitLabel, submitClass, message }: {
    placeholder?: string; initialValue?: string; submitLabel?: string;
    submitClass?: string; message?: ComponentChildren;
  },
  onSubmit?: (value: string, hint?: any) => unknown,
) {
  return new Promise((resolve) => {
    let submittedValue: string | null = null;
    const wrappedSubmit = (val: any, hint: any) => {
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

function PromptBody(
  { message, placeholder, initialValue, submitLabel, submitClass, onSubmit }: {
    message?: ComponentChildren; placeholder?: string; initialValue?: string;
    submitLabel?: string; submitClass?: string; onSubmit: (value: string, hint?: any) => unknown;
  },
) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const hintRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current!.focus();
      if (initialValue) inputRef.current.select();
    }
  }, []);

  function doSubmit() {
    const val = inputRef.current!.value.trim();
    if (!val) {
      if (hintRef.current) {
        hintRef.current.textContent = 'Please enter a value';
        hintRef.current.style.color = 'var(--danger)';
      }
      inputRef.current!.focus();
      return;
    }
    if (val === initialValue) { closeModal(); return; }
    onSubmit(val, hintRef.current);
  }

  return (
    <ModalBody>
      {message && <ModalMessage>{message}</ModalMessage>}
      <input
        ref={inputRef}
        class="input"
        style="width:100%"
        placeholder={placeholder || ''}
        value={initialValue || ''}
        onKeyDown={(e) => { if (e.key === 'Enter') doSubmit(); }}
      />
      <div ref={hintRef} class="input-hint"></div>
      <ModalActions>
        <button class="btn btn-secondary" onClick={closeModal}>Cancel</button>
        <button class={`btn ${submitClass || 'btn-primary'}`} onClick={doSubmit}>{submitLabel || 'OK'}</button>
      </ModalActions>
    </ModalBody>
  );
}

export function openModal(title: string, renderFn: () => ComponentChildren) {
  modalContent.value = { title, render: renderFn };
}

// Update the currently-open modal's title in place. Multi-step flows (e.g. the
// import wizard) use this to surface the picked file in the header. Guarded
// no-op when no modal is open — so components rendered standalone (unit tests)
// stay safe even when the store's modalContent isn't provided.
export function setModalTitle(title: any) {
  if (!modalContent || !modalContent.value) return;
  modalContent.value = { ...modalContent.value, title };
}

export default function Modal() {
  const modal = modalContent.value;
  const cardRef = useRef<HTMLDivElement | null>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);

  // useLayoutEffect runs before child useEffects, so we can snapshot
  // activeElement before any inner component (e.g. PromptBody) grabs focus.
  useLayoutEffect(() => {
    if (!modal) return;
    prevFocusRef.current = document.activeElement as HTMLElement | null;
    const card = cardRef.current;
    if (card && !card.contains(document.activeElement)) card.focus();
    return () => {
      const prev = prevFocusRef.current;
      if (prev && typeof prev.focus === 'function' && document.contains(prev)) {
        prev.focus();
      }
      prevFocusRef.current = null;
    };
  }, [modal]);

  useEffect(() => {
    if (!modal) return;
    const onKey = (e: any) => {
      if (e.key === 'Escape') {
        closeModal();
        return;
      }
      if (e.key === 'Tab') {
        const card = cardRef.current;
        if (!card) return;
        const focusables = card.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
        if (focusables.length === 0) {
          e.preventDefault();
          card.focus();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [modal]);

  if (!modal) return null;

  return (
    <div
      class={styles.overlay}
      onClick={(e) => { if (e.target === e.currentTarget) closeModal(); }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => e.preventDefault()}
    >
      <div
        class={styles.card}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        tabIndex={-1}
        ref={cardRef}
      >
        <div class={styles.header}>
          <span class={styles.title} id="modal-title">{modal.title}</span>
          <ModalClose onClick={closeModal} />
        </div>
        {modal.render()}
      </div>
    </div>
  );
}
