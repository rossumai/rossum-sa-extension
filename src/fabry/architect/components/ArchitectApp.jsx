import { h } from 'preact';
import { useEffect } from 'preact/hooks';
import * as store from '../store.js';
import { loadArchitect } from '../actions.js';
import DeliverableEditor from './DeliverableEditor.jsx';

export default function ArchitectApp() {
  useEffect(() => { loadArchitect(); }, []);
  const active = store.deliverables.value.find((d) => d.id === store.activeId.value);
  return (
    <div class="fabry-arch">
      {active ? (
        <DeliverableEditor deliverable={active} />
      ) : (
        <div class="fabry-arch-placeholder">
          <p class="fabry-arch-placeholder-title">SOW deliverables</p>
          <p class="fabry-arch-placeholder-sub">Select a deliverable from the sidebar, or add one, then Run to check it read-only against this organization.</p>
        </div>
      )}
    </div>
  );
}
