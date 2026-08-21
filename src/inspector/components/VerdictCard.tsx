import { h } from 'preact';
import * as store from '../store.js';
import CulpritChip from './CulpritChip.jsx';
import ReliabilityBadge from './ReliabilityBadge.jsx';

// The instant programmatic verdict (spec §4.2) — renders as soon as core data is in.
export default function VerdictCard() {
  const ev = store.evidence.value;
  if (!ev || !ev.verdict) return null;
  const v = ev.verdict;
  return (
    <div class={`inspector-verdict sev-${v.severity}`}>
      <div class="inspector-verdict-h">{v.headline}</div>
      {v.reasons.map((r: any) => (
        <div class="inspector-verdict-why">
          {r.fact} {r.culprit ? <CulpritChip culprit={r.culprit} /> : null} <ReliabilityBadge level={r.reliability} />
        </div>
      ))}
    </div>
  );
}
