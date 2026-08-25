import { h, Fragment } from 'preact';
import { ModalMessage, ModalActions } from './Modal.jsx';

// Shared progress / summary components used by ImportWizard.
// StageConfirm / StageImporting / StageDone were retired when the per-format
// wizards were unified into ImportWizard.

export function formatBytes(n: any) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// m:ss elapsed, for the async-operation heartbeat.
export function formatDuration(ms: any) {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function ImportProgress({ progress, onCancel }: { progress: any; onCancel?: () => void }) {
  const { phase, processed = 0, total = 0, indeterminate } = progress;
  const LABELS: Record<string, string> = {
    analyze: 'Analyzing',
    insert: 'Inserting',
    update: 'Updating',
    replace: 'Replacing',
    delete: 'Deleting',
    uploading: 'Uploading',
    processing: 'Processing on the server',
  };
  const label = LABELS[phase] || 'Working';
  if (indeterminate) {
    // Live heartbeat: the server returns its status + file metadata each poll,
    // and the wizard tracks how many times we've checked + how long it's run.
    // Showing these (they change every poll) reassures the user the job is alive.
    const { status, checks, elapsedMs, file } = progress;
    const bits = [];
    if (status) bits.push(`status: ${status}`);
    if (checks) bits.push(`checked ${checks.toLocaleString()}${'×'}`);
    if (elapsedMs != null) bits.push(`${formatDuration(elapsedMs)} elapsed`);
    return (
      <Fragment>
        <ModalMessage>
          {label}
          {'…'}
        </ModalMessage>
        <div class="import-progress">
          <div class="import-progress-track">
            <div class="import-progress-fill indeterminate"></div>
          </div>
        </div>
        {file?.filename && (
          <div class="input-hint">
            {file.filename}
            {file.size != null ? ` · ${formatBytes(file.size)}` : ''}
          </div>
        )}
        {bits.length > 0 && (
          <div class="import-progress-status" data-testid="import-progress-status">
            {bits.join(' · ')}
          </div>
        )}
        <div class="input-hint">
          Typically 30{'–'}60 s. You can close this {'—'} the outcome appears in{' '}
          <strong>Operation Logs</strong>.
        </div>
        {onCancel && (
          <ModalActions>
            <button class="btn btn-secondary" onClick={onCancel}>
              Stop watching
            </button>
          </ModalActions>
        )}
      </Fragment>
    );
  }
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  return (
    <Fragment>
      <ModalMessage>
        {label}
        {'…'}
      </ModalMessage>
      <div class="import-progress">
        <div class="import-progress-track">
          <div class="import-progress-fill" style={`width:${pct}%`}></div>
        </div>
        <div class="import-progress-counts">
          <span>
            {processed.toLocaleString()} / {total.toLocaleString()}
          </span>
          <span>{pct}%</span>
        </div>
      </div>
      {onCancel && (
        <ModalActions>
          <button class="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
        </ModalActions>
      )}
    </Fragment>
  );
}

export function ImportSummary({
  result,
  fileMeta,
  onClose,
}: {
  result: any;
  fileMeta?: any;
  onClose: () => void;
}) {
  if (result.serverManaged) {
    const verb = result.kind === 'replace' ? 'replaced' : 'updated';
    if (result.cancelled) {
      const action = result.kind === 'replace' ? 'replace' : 'update';
      return (
        <Fragment>
          <div class="import-result-header partial">
            <span class="import-result-icon">{'○'}</span>
            <span>
              Cancelled
              {fileMeta?.name && (
                <span class="import-result-filename">
                  {' '}
                  {'·'} {fileMeta.name}
                </span>
              )}
            </span>
          </div>
          <ul class="import-result-list">
            <li>
              Stopped waiting for the server. If the upload already reached the server it may still{' '}
              {action} the collection in the background.
            </li>
          </ul>
          <ModalActions>
            <button class="btn btn-primary" onClick={onClose}>
              Close
            </button>
          </ModalActions>
        </Fragment>
      );
    }
    return (
      <Fragment>
        <div class="import-result-header success">
          <span class="import-result-icon">{'✓'}</span>
          <span>
            Import complete
            {fileMeta?.name && (
              <span class="import-result-filename">
                {' '}
                {'·'} {fileMeta.name}
              </span>
            )}
          </span>
        </div>
        <ul class="import-result-list">
          <li>
            Uploaded <strong>{(result.sent || 0).toLocaleString()}</strong> row
            {result.sent === 1 ? '' : 's'} {'—'} the server {verb} the collection.
          </li>
        </ul>
        <ModalActions>
          <button class="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </ModalActions>
      </Fragment>
    );
  }
  const {
    kind,
    applied = 0,
    inserted = 0,
    deleted = 0,
    skipped = 0,
    failedBatches = [],
    cancelled,
  } = result;
  const ok = failedBatches.length === 0 && !cancelled;
  const appliedVerb = kind === 'replace' ? 'Replaced' : kind === 'update' ? 'Updated' : null;
  return (
    <Fragment>
      <div class={`import-result-header ${ok ? 'success' : 'partial'}`}>
        <span class="import-result-icon">{ok ? '✓' : cancelled ? '○' : '⚠'}</span>
        <span>
          {cancelled ? 'Cancelled' : ok ? 'Import complete' : 'Import partially complete'}
          {fileMeta?.name && (
            <span class="import-result-filename">
              {' '}
              {'·'} {fileMeta.name}
            </span>
          )}
        </span>
      </div>
      <ul class="import-result-list">
        {kind === 'overwrite' && deleted > 0 && (
          <li>
            Deleted <strong>{deleted.toLocaleString()}</strong> existing record
            {deleted === 1 ? '' : 's'}
          </li>
        )}
        {appliedVerb && applied > 0 && (
          <li>
            {appliedVerb} <strong>{applied.toLocaleString()}</strong> record
            {applied === 1 ? '' : 's'}
          </li>
        )}
        {inserted > 0 && (
          <li>
            Inserted <strong>{inserted.toLocaleString()}</strong> document
            {inserted === 1 ? '' : 's'}
          </li>
        )}
        {skipped > 0 && (
          <li>
            Skipped <strong>{skipped.toLocaleString()}</strong> non-matching row
            {skipped === 1 ? '' : 's'}
          </li>
        )}
        {failedBatches.length > 0 && (
          <li style="color:var(--danger)">
            <strong>{failedBatches.length}</strong> operation{failedBatches.length === 1 ? '' : 's'}{' '}
            failed
            <ul class="import-failure-list">
              {failedBatches.slice(0, 5).map((b: any, i: any) => (
                <li key={i}>
                  {b.count > 0 && typeof b.startIdx === 'number' ? (
                    <Fragment>
                      Rows {b.startIdx.toLocaleString()}
                      {b.endIdx !== b.startIdx ? `${'–'}${b.endIdx.toLocaleString()}` : ''} (
                      {b.count.toLocaleString()}):{' '}
                    </Fragment>
                  ) : null}
                  {b.message ? <code>{b.message}</code> : 'failed'}
                </li>
              ))}
              {failedBatches.length > 5 && (
                <li>
                  {'… and '}
                  {failedBatches.length - 5}
                  {' more'}
                </li>
              )}
            </ul>
          </li>
        )}
      </ul>
      <ModalActions>
        <button class="btn btn-primary" onClick={onClose}>
          Close
        </button>
      </ModalActions>
    </Fragment>
  );
}
