import { h } from 'preact';
import { useEffect } from 'preact/hooks';
import * as store from '../store.js';
import { loadEnrichment } from '../index.jsx';
import { classifyRejection } from '../culprit.js';
import ReliabilityBadge from './ReliabilityBadge.jsx';
import CulpritChip from './CulpritChip.jsx';

export default function RejectedPanel() {
  const d = store.data.value;
  const enr = store.enrichment.value;

  useEffect(() => {
    if (store.enrichment.value.workflow === null) loadEnrichment('workflow');
    if (store.enrichment.value.notes === null) loadEnrichment('notes');
  }, [store.annotationId.value]);

  const rej = d ? classifyRejection({
    annotation: d.annotation,
    workflowActivities: Array.isArray(enr.workflow) ? enr.workflow : [],
    notes: Array.isArray(enr.notes) ? enr.notes : [],
    usersById: d.resolved.usersById,
  }) : { type: 'none' };

  if (!d) return null;
  if (rej.type === 'none') return <div class="inspector-empty">This annotation has not been rejected.</div>;

  const attr = store.attributions.value.reject;
  return (
    <div class="inspector-panel">
      <div class={`inspector-culprit inspector-culprit-${rej.culprit?.kind || 'none'}`} data-evidence-id="reject">
        <div class="lbl">Culprit · {rej.culprit?.kind}</div>
        <div class="name">{rej.culprit?.name} <ReliabilityBadge level={rej.reliability} /></div>
        <div class="meta">{rej.automatic ? 'Automatic' : 'Manual'}{rej.when ? ` · ${rej.when}` : ''}{rej.current ? '' : ' · (historical — not currently rejected)'}</div>
      </div>
      <div class="inspector-reason">
        <div class="h">Reason</div>
        <div class="body">{rej.reason.text || 'Reason not recorded by the API.'}</div>
        <ReliabilityBadge level={rej.reason.reliability} />
      </div>
      {rej.type === 'hook' && (
        <div class="inspector-ai-attr">
          <div class="t">Which extension rejected this — reasoned by Mr. Fabry from the queue's extension code + logs.</div>
          {!store.aiAvailable.value && <div class="inspector-empty">AI attribution unavailable (agent offline).</div>}
          {attr?.status === 'loading' && <div class="inspector-loading inspector-ai-phase">{attr.phase || 'thinking'}…</div>}
          {attr?.status === 'error' && <div class="inspector-empty">AI attribution failed.</div>}
          {attr?.status === 'done' && (
            <div class="inspector-ai-verdict">
              <div class="ttl"><CulpritChip culprit={attr.verdict.culprit} /> <ReliabilityBadge level={attr.verdict.confidence} /></div>
              {attr.verdict.explanation && <div class="inspector-why">{attr.verdict.explanation}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
