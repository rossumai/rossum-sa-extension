import { h } from 'preact';
import { useEffect } from 'preact/hooks';
import * as store from '../store.js';
import { loadArchitect } from '../actions.js';
import { preloadDeliverables } from '../preload.js';
import SpecView from './SpecView.jsx';
import InspectorRail from './InspectorRail.jsx';

export default function ArchitectApp() {
  useEffect(() => { loadArchitect(); }, []);

  // Warm every OTHER deliverable's rendered document in idle time, so switching is instant
  // (owner, 2026-08-18). Re-runs when the list or the open document changes; the returned
  // cancel stops an in-flight sweep, so a burst of switches cannot pile up queues. `dark` and
  // `syncLines` must match what the pane asks for or the warmed entries are keyed differently.
  const ids = store.deliverables.value.map((d) => d.id).join(',');
  useEffect(() => {
    let dark = false;
    try { dark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); } catch { /* default light */ }
    return preloadDeliverables({
      deliverables: store.deliverables.value,
      activeId: store.activeId.value,
      dark,
      syncLines: true,
    });
  }, [ids, store.activeId.value]);
  const legacy = store.legacyNotice.value;
  return (
    <div class="fabry-arch fabry-arch-unified">
      {legacy ? (
        // Both collections exist, which means an older build recreated the previous one after
        // this org was migrated. Stated plainly rather than "fixed" silently: nothing is
        // copied or dropped, and each deliverable is written back to whichever collection it
        // lives in (api.js colFor). See collectionPlan.js.
        <p class="fabry-arch-legacy">
          <span>{'\u2637'}</span>
          <span>
            {legacy.count} deliverable{legacy.count === 1 ? '' : 's'} still stored under this
            organization{'\u2019'}s previous collection name. Both are shown; each one saves back to
            where it lives.
          </span>
        </p>
      ) : null}
      {store.deliverables.value.length ? (
        <SpecView />
      ) : (
        <div class="fabry-arch-placeholder">
          <p class="fabry-arch-placeholder-title">SOW deliverables</p>
          <p class="fabry-arch-placeholder-sub">Select a deliverable from the sidebar, or add one, then Run to check it read-only against this organization.</p>
        </div>
      )}
      {store.deliverables.value.length && store.railOpen.value ? <InspectorRail /> : null}
    </div>
  );
}
