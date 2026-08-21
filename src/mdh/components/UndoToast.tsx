import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { undoToast } from '../store.js';
import { triggerUndo, dismissUndo } from '../undo.js';

export default function UndoToast() {
  const u = undoToast.value;
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!u || u.status !== 'pending') return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [u?.id, u?.status]);

  if (!u) return null;

  const remainingMs = Math.max(0, u.ts + u.ttlMs - now);
  const remainingS = Math.ceil(remainingMs / 1000);
  const progress = u.status === 'pending' ? remainingMs / u.ttlMs : 0;

  return (
    <div
      class={'undo-toast undo-toast-' + u.status}
      role="status"
      aria-live="polite"
      data-testid="undo-toast"
    >
      <div class="undo-toast-row">
        <span class="undo-toast-message">
          {u.status === 'error' ? `Undo failed: ${u.error}`
            : u.status === 'done' ? 'Undone'
            : u.status === 'running' ? `Undoing…`
            : u.message}
        </span>
        {u.status === 'pending' && (
          <button class="undo-toast-action" onClick={triggerUndo}>
            Undo <span class="undo-toast-countdown">({remainingS}s)</span>
          </button>
        )}
        <button
          class="undo-toast-dismiss"
          title="Dismiss"
          onClick={dismissUndo}
          aria-label="Dismiss"
        >{'×'}</button>
      </div>
      {u.status === 'pending' && (
        <div class="undo-toast-progress" style={`transform: scaleX(${progress})`} />
      )}
    </div>
  );
}
