import { h } from 'preact';
import * as store from '../store.js';
import EvidenceSection from './EvidenceSection.jsx';
import ReliabilityBadge from './ReliabilityBadge.jsx';

// Arrival story: email/upload/split/archive + duplicates (spec §5.5-intake).
export default function IntakeSection() {
  const items = (store.evidence.value?.items || []).filter((i) => i.section === 'intake');
  const status = !store.data.value?.resolved?._intakeLoaded ? 'pending' : (items.length ? 'loaded' : 'na');
  const arrival = items.find((i) => i.id === 'intake:arrival');
  return (
    <EvidenceSection id="intake" title="Intake & origin" count={arrival ? arrival.data.attachmentStatus || 'upload' : null} status={status}>
      {items.map((i) => (
        <div class="inspector-ev" data-evidence-id={i.id}>
          <span class="inspector-ev-id">{i.id}</span>
          <span>{i.fact}</span> <ReliabilityBadge level={i.reliability} />
        </div>
      ))}
    </EvidenceSection>
  );
}
