import { h } from 'preact';
import { useRef } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import { effect } from '@preact/signals';
import { UNDO_LIMIT } from '../bulkOps.js';

// One-click threshold below which no type-gate is required.
const ONE_CLICK_LIMIT = 10;

function gateModeFor(count, forceNameGate) {
  if (forceNameGate) return 'name';
  if (count == null) return 'blocked';
  if (count <= ONE_CLICK_LIMIT) return 'click';
  if (count <= UNDO_LIMIT) return 'count';
  return 'name';
}

function valueMatches(mode, raw, count, collection) {
  const trimmed = raw.trim();
  if (mode === 'count') {
    if (!/^\d+$/.test(trimmed)) return false;
    return Number(trimmed) === count;
  }
  if (mode === 'name') return trimmed === collection;
  return false;
}

function isGateOk(mode, raw, count, collection) {
  if (mode === 'click') return true;
  if (mode === 'blocked') return false;
  return valueMatches(mode, raw, count, collection);
}

export default function BulkConfirm({
  count,
  collection,
  forceNameGate = false,
  disabled = false,
  submitLabel,
  submitClass = 'btn-primary',
  onSubmit,
  onCancel,
}) {
  const mode = gateModeFor(count, forceNameGate);
  const typed = useSignal('');
  const disposeRef = useRef(null);

  // Ref callback: called synchronously by Preact on mount/unmount.
  // Sets up a signals-core effect that propagates `typed` changes to the
  // button's disabled attribute synchronously (no Preact VDOM scheduling),
  // which is required for jsdom test assertions to work after dispatchEvent.
  const submitRef = (el) => {
    if (disposeRef.current) { disposeRef.current(); disposeRef.current = null; }
    if (!el) return;
    disposeRef.current = effect(() => {
      el.disabled = disabled || !isGateOk(mode, typed.value, count, collection);
    });
  };

  function handleInput(e) {
    typed.value = e.currentTarget.value;
  }

  const gateOk = isGateOk(mode, typed.value, count, collection);
  const submitDisabled = disabled || !gateOk;

  return (
    <div class="bulk-confirm">
      {mode === 'count' && (
        <label class="bulk-confirm-row">
          <span class="bulk-confirm-label">
            Type <strong>{count}</strong> to confirm:
          </span>
          <input
            class="input"
            data-testid="bulk-confirm-input"
            value={typed.value}
            onInput={handleInput}
            placeholder={String(count)}
          />
        </label>
      )}
      {mode === 'name' && (
        <label class="bulk-confirm-row">
          <span class="bulk-confirm-label">
            Type <strong>{collection}</strong> to confirm:
          </span>
          <input
            class="input"
            data-testid="bulk-confirm-input"
            value={typed.value}
            onInput={handleInput}
            placeholder={collection}
          />
        </label>
      )}
      {mode === 'blocked' && (
        <div class="bulk-confirm-row bulk-confirm-blocked">
          Waiting for record count{'…'}
        </div>
      )}
      <div class="modal-actions">
        <button class="btn btn-secondary" data-testid="bulk-cancel" onClick={onCancel}>Cancel</button>
        <button
          ref={submitRef}
          class={`btn ${submitClass}`}
          data-testid="bulk-submit"
          disabled={submitDisabled}
          onClick={onSubmit}
        >{submitLabel}</button>
      </div>
    </div>
  );
}
