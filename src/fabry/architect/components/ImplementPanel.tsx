import { h } from 'preact';
import * as store from '../store.js';
import { reImplement, stopImplement } from '../actions.js';
import { openArmDialog } from './ArmDialog.jsx';
import type { Deliverable } from '../collectionPlan.js';

// The write-enabled implement loop for ONE deliverable. Markup lifted verbatim from the deliverable
// pane's Implement tab when the pane was replaced by the unified view (2026-08-19). The Arm dialog
// still gates every run — that gate is the whole safety story and it did not move.
export default function ImplementPanel({ deliverable }: { deliverable: Deliverable }) {
  const impl = store.implement.value[deliverable.id];
  const result = store.results.value[deliverable.id];
  const active = !!impl && store.implementRunning.value && (impl.status === 'planning' || impl.status === 'running');

  function onImplement() {
    openArmDialog(1, () => reImplement(deliverable.id));
  }

  return (
    <div>
      <div class="fabry-arch-implement-hd">
        <span class="fabry-arch-implement-title">{'Implement this deliverable'}</span>
        {active
          ? <button type="button" class="fabry-arch-implement-stop" onClick={stopImplement}>{'Stop'}</button>
          : <button type="button" class="fabry-arch-implement-run" disabled={store.implementRunning.value || store.running.value || result?.running} onClick={onImplement}>{'Implement ▷'}</button>}
      </div>
      {!impl && <p class="fabry-arch-implement-hint">{'Mr. Fabry plans this deliverable into tasks and implements them autonomously — write-enabled, bounded, and audited. You confirm before it starts.'}</p>}
      {impl && (
        <div class={'fabry-arch-implement-body status-' + (impl.status || 'idle')}>
          <div class="fabry-arch-implement-status">
            {active ? h('span', { class: 'fabry-arch-spin' }) : null}
            {impl.status === 'passing' ? '✓ implemented (check passed)'
              : impl.status === 'failed' ? '✗ could not satisfy'
              : impl.status === 'blocked' ? '⚠ blocked'
              : impl.status === 'uncertain' ? '? could not verify (check error)'
              : impl.status === 'stopped' ? '■ stopped'
              : impl.status === 'planning' ? 'Planning tasks…'
              : impl.status === 'running' ? 'Implementing tasks…' : ''}
            {impl.error && <span class="fabry-arch-implement-err">{' — '}{impl.error}</span>}
          </div>
          {impl.tasks && impl.tasks.length > 0 && (
            <ol class="fabry-arch-tasklist">
              {impl.tasks.map((t) => (
                <li key={t.id} class={'fabry-arch-task task-' + (t.status || 'pending')}>
                  <span class="fabry-arch-task-dot" />
                  <span class="fabry-arch-task-text">{t.text}</span>
                  {t.origin && t.origin !== 'plan' && <span class="fabry-arch-task-origin">{t.origin}</span>}
                </li>
              ))}
            </ol>
          )}
          {impl.summary && <div class="fabry-arch-implement-summary">{impl.summary}</div>}
          {impl.notes && impl.notes.length > 0 && impl.notes.map((n: any, i: any) => <div key={i} class="fabry-arch-implement-note">{n}</div>)}
          {impl.writes && impl.writes.length > 0 && (
            <ul class="fabry-arch-implement-audit">
              {impl.writes.map((w, i) => (
                <li key={i} class={w.ok ? 'ok' : 'pending'}><code>{w.tool}</code>{w.argsSummary ? ' ' + w.argsSummary : ''}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
