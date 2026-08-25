// src/devtools/DiffConfirm.tsx
import { h } from 'preact';
import { diffObjects } from './diff.js';

export default function DiffConfirm({
  original,
  edited,
  saving,
  onConfirm,
  onCancel,
}: {
  original: any;
  edited: any;
  saving?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const d = diffObjects(original, edited);
  const empty = d.leaves.length === 0 && d.removed.length === 0;
  return (
    <div class="rawjson-diff-overlay">
      <div class="rawjson-diff-card">
        <h4 class="rawjson-diff-title">Review changes</h4>
        {empty ? (
          <div class="rawjson-diff-empty">No changes to save.</div>
        ) : (
          <div class="rawjson-diff-list">
            {d.leaves.map((l) => (
              <div class={`rawjson-diff-leaf rawjson-diff-${l.kind}`}>
                <code class="rawjson-diff-path">{l.path}</code>
                <span class="rawjson-diff-before">
                  {l.kind === 'added' ? '—' : JSON.stringify(l.before)}
                </span>
                <span class="rawjson-diff-arrow">→</span>
                <span class="rawjson-diff-after">
                  {l.kind === 'removed' ? '—' : JSON.stringify(l.after)}
                </span>
              </div>
            ))}
          </div>
        )}
        {d.removed.length ? (
          <div class="rawjson-diff-removed-warn">
            Removed top-level keys are NOT applied (PATCH can't delete keys): {d.removed.join(', ')}
          </div>
        ) : null}
        <div class="rawjson-diff-actions">
          <button class="rawjson-cancel" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
          <button class="rawjson-confirm" onClick={onConfirm} disabled={saving || empty}>
            {saving ? 'Saving…' : 'Confirm & save'}
          </button>
        </div>
      </div>
    </div>
  );
}
