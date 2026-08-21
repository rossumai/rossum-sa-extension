import { h } from 'preact';
import * as store from '../store.js';
import ReportHeader from './ReportHeader.jsx';
import InvestigationStrip from './InvestigationStrip.jsx';
import VerdictCard from './VerdictCard.jsx';
import DiagnosisPanel from './DiagnosisPanel.jsx';
import EvidenceSection from './EvidenceSection.jsx';
import IntakeSection from './IntakeSection.jsx';
import WorkflowSection from './WorkflowSection.jsx';
import DriftSection from './DriftSection.jsx';
import BlockedPanel from './BlockedPanel.jsx';
import ProvenancePanel from './ProvenancePanel.jsx';
import PipelinePanel from './PipelinePanel.jsx';
import LabelsPanel from './LabelsPanel.jsx';
import RejectedPanel from './RejectedPanel.jsx';
import ExportPanel from './ExportPanel.jsx';

function sectionStatus(section: any) {
  const ev = store.evidence.value;
  if (!ev) return 'pending';
  return ev.items.some((i: any) => i.section === section) ? 'loaded' : 'na';
}

// The single-column Diagnosis Report (spec §5).
export default function Report() {
  const d = store.data.value;
  if (!d) return null;
  const a = d.annotation;
  const attrs = Object.values(store.attributions.value);
  const attributing = attrs.some((x) => x.status === 'loading');
  const logs = store.enrichment.value.hookLogs;
  const pipelineStatus = logs === null || !d.resolved?._hooksLoaded ? 'pending' : (logs === 'unavailable' ? 'unavailable' : 'sparse');
  const labelsStatus = d.resolved?.labelsById === undefined ? 'pending' : (attributing ? 'attributing' : 'loaded');
  const rejectionStatus = (store.enrichment.value.workflow === null || store.enrichment.value.notes === null) ? 'pending' : sectionStatus('rejection');
  return (
    <div class="inspector-report">
      <ReportHeader />
      <InvestigationStrip />
      <VerdictCard />
      <DiagnosisPanel />
      <IntakeSection />
      <EvidenceSection id="blockers" title="Blockers & messages" count={`${(d.blocker?.content || []).length} blocker(s) · ${(a.messages || []).length} message(s)`} status={attributing ? 'attributing' : 'loaded'}>
        <BlockedPanel />
      </EvidenceSection>
      <EvidenceSection id="fields" title="Fields" status="loaded">
        <ProvenancePanel />
      </EvidenceSection>
      <EvidenceSection id="pipeline" title="Extension runs" status={pipelineStatus}>
        <PipelinePanel />
      </EvidenceSection>
      <EvidenceSection id="labels" title="Labels" count={`${(a.labels || []).length} applied`} status={labelsStatus}>
        <LabelsPanel />
      </EvidenceSection>
      <EvidenceSection id="rejection" title="Rejection" status={rejectionStatus}>
        <RejectedPanel />
      </EvidenceSection>
      <WorkflowSection />
      <EvidenceSection id="export" title="Export" status={sectionStatus('export')}>
        <ExportPanel />
      </EvidenceSection>
      <DriftSection />
    </div>
  );
}
