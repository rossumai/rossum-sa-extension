import { h } from 'preact';
import * as store from '../store.js';
import EvidenceSection from './EvidenceSection.jsx';

// Approval-workflow state: run status + ordered steps, current step marked.
export default function WorkflowSection() {
  const items = (store.evidence.value?.items || []).filter((i: any) => i.section === 'workflow');
  const run = items.find((i: any) => i.id === 'workflow:run');
  const status = !store.data.value?.resolved?._workflowLoaded ? 'pending' : (items.length ? 'loaded' : 'na');
  return (
    <EvidenceSection id="workflow" title="Approval workflow" count={status === 'pending' ? null : (run ? run.data.status : 'no workflow')} status={status}>
      {items.map((i: any) => (
        <div class={`inspector-ev${i.data?.current ? ' inspector-wf-current' : ''}`} data-evidence-id={i.id}>
          <span class="inspector-ev-id">{i.id}</span>{i.fact}
        </div>
      ))}
    </EvidenceSection>
  );
}
