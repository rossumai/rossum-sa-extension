import { h } from 'preact';
import * as store from '../store.js';

const STEPS = [
  ['created_at', 'Created'],
  ['assigned_at', 'Assigned'],
  ['confirmed_at', 'Confirmed'],
  ['rejected_at', 'Rejected'],
  ['exported_at', 'Exported'],
  ['export_failed_at', 'Export failed'],
  ['modified_at', 'Modified'],
];

const CHECK = (
  <svg class="inspector-step-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

function fmt(ts) { return String(ts).replace('T', ' ').replace('Z', '').slice(0, 16); }

// Short relative gap between two timestamps (e.g. "18d", "1h", "2m").
function gap(a, b) {
  const ms = new Date(b) - new Date(a);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

// Outcome color for the current (latest) node + status pill.
function statusTone(status) {
  if (status === 'rejected' || status === 'failed_export') return 'danger';
  if (status === 'confirmed' || status === 'exported') return 'success';
  if (status === 'to_review' || status === 'reviewing' || status === 'importing' || status === 'created') return 'warning';
  return 'accent';
}

export default function Timeline() {
  const d = store.data.value;
  if (!d) return null;
  const a = d.annotation;
  const steps = STEPS.filter(([k]) => a[k]).map(([k, label]) => ({ label, ts: a[k] }));
  if (!steps.length) return null;
  const lastIdx = steps.length - 1;
  const tone = statusTone(a.status);
  return (
    <div class="inspector-tl">
      <div class="inspector-tl-hd">Status timeline</div>
      <ol class="inspector-steps">
        {steps.map((s, i) => {
          const isCurrent = i === lastIdx;
          const g = i > 0 ? gap(steps[i - 1].ts, s.ts) : null;
          return (
            <li class={`inspector-step ${isCurrent ? `current tone-${tone}` : 'done'}`}>
              {g ? <span class="inspector-step-gap">{g}</span> : null}
              <span class="d">{isCurrent ? null : CHECK}</span>
              <div class="t">{s.label}</div>
              <div class="dt">{fmt(s.ts)}</div>
              {isCurrent ? <span class="inspector-step-now">{String(a.status).replace(/_/g, ' ')}</span> : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
