import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import * as store from '../store.js';
import { loadEnrichment, loadQueueHooks } from '../index.jsx';
import { classifyRejection, rankRejectCandidates } from '../culprit.js';
import ReliabilityBadge from './ReliabilityBadge.jsx';

export default function RejectedPanel() {
  const d = store.data.value;
  const [investigated, setInvestigated] = useState(false);
  const enr = store.enrichment.value;

  // Best-effort: load workflow activities + rejection notes once.
  useEffect(() => {
    if (store.enrichment.value.workflow === null) loadEnrichment('workflow');
    if (store.enrichment.value.notes === null) loadEnrichment('notes');
  }, [store.annotationId.value]);

  if (!d) return null;
  const rej = classifyRejection({
    annotation: d.annotation,
    workflowActivities: Array.isArray(enr.workflow) ? enr.workflow : [],
    notes: Array.isArray(enr.notes) ? enr.notes : [],
    usersById: d.resolved.usersById,
  });
  if (rej.type === 'none') return <div class="inspector-empty">This annotation has not been rejected.</div>;

  const investigate = () => { loadQueueHooks(); loadEnrichment('hookLogs'); setInvestigated(true); };
  const hookLogs = Array.isArray(enr.hookLogs) ? enr.hookLogs : [];
  const queueHooks = Object.values(d.resolved.hooksById || {});
  const candidates = investigated ? rankRejectCandidates({ hookLogs, queueHooks, rejectedAt: d.annotation.rejected_at, requestId: null }) : [];

  return (
    <div class="inspector-panel">
      <div class={`inspector-culprit inspector-culprit-${rej.culprit?.kind || 'none'}`}>
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
        <div class="inspector-detective">
          <div class="t">The exact extension isn't recorded on the annotation. Investigate correlates hook logs around <code>rejected_at</code> and scans queue extensions for reject capability (webhooks = unknown).</div>
          <button class="btn btn-primary" onClick={investigate}>Investigate</button>
          {investigated && (
            <div class="inspector-candidates">
              {candidates.length === 0 && <div class="inspector-empty">No candidate extensions found (logs may be expired).</div>}
              {candidates.map((c, i) => (
                <div class="inspector-crow">
                  <span class="rank">{i + 1}</span>
                  <span class="nm">{c.name} #{c.hookId} · {c.capability}{c.matchedRequestId ? ' · request_id match' : (c.ran ? ' · ran' : '')}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
