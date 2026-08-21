import { h } from 'preact';
import { useRef, useState } from 'preact/hooks';
import * as store from '../store.js';
import * as fstore from '../../store.js';
import { railTarget } from '../specTarget.js';
import { displayTitle } from '../format.js';
import { CheckBadge } from './SpecView.jsx';
import CheckPanel from './CheckPanel.jsx';
import ImplementPanel from './ImplementPanel.jsx';
import RefineDock from './RefineDock.jsx';
import HistoryPanel from './HistoryPanel.jsx';

// The per-deliverable inspector, beside the one continuous specification (spec 2026-08-19 §6).
//
// It FOLLOWS the reader's scroll (owner's choice), which is only safe because of two rules in
// specTarget.railTarget: an explicit pin wins, and a deliverable with a check in flight HOLDS the
// target until it finishes — a run started here must not be scrolled out from under itself.

// Which deliverable currently has work in flight — a check, or the implement loop.
function runningId() {
  const rs = store.results.value;
  for (const id of Object.keys(rs)) if (rs[id] && rs[id].running) return id;
  if (store.implementRunning.value) {
    const im = store.implement.value;
    for (const id of Object.keys(im)) {
      const st = im[id] && im[id].status;
      if (st === 'planning' || st === 'running') return id;
    }
  }
  return null;
}

export default function InspectorRail() {
  const ds = store.deliverables.value;
  const [tab, setTab] = useState('check');
  const shownRef = useRef<any>(null);

  const running = runningId();
  const id = railTarget({
    // The SETTLED target, not the live one: see store.setSettledTarget.
    spy: store.settledTarget.value,
    pinned: store.pinnedTarget.value,
    running,
    shown: shownRef.current,
  });
  const d = ds.find((x) => x.id === id) || ds[0];
  if (!d) return null;
  shownRef.current = d.id;

  const result = store.results.value[d.id];
  const pinned = store.pinnedTarget.value === d.id;
  const held = !!running && running === d.id && !pinned;
  const implAllowed = fstore.implementAllowed.value;

  const rv = store.reviewTarget.value;
  const wideHere = !!rv && rv.id === d.id && (rv.kind === 'refine' || rv.kind === 'history');
  const TABS = [['check', 'Check'], ['refine', '✦ Refine'], ...(implAllowed ? [['implement', '▷ Implement']] : []), ['history', '↺ History']];
  const active = TABS.some(([k]) => k === tab) ? tab : 'check';

  // Drag the rail's LEFT edge to resize (the Fabry sidebar's pattern, mirrored: this column is on
  // the right, so moving left widens it). Live during the drag, persisted once on release.
  function startResize(e: any) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = store.railWidth.value;
    const handle = e.currentTarget;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    function onMove(ev: any) { store.railWidth.value = store.clampRailWidth(startWidth - (ev.clientX - startX)); }
    function onUp() {
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      store.setRailWidth(store.railWidth.value);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  return (
    <aside class="fabry-rail" style={{ width: store.railWidth.value + 'px' }}>
      <div class="fabry-rail-resizer" title="Drag to resize" onMouseDown={startResize} />
      <div class="fabry-rail-hd">
        <div class="fabry-rail-for">{pinned ? 'Pinned to' : 'Inspecting'}</div>
        <div class="fabry-rail-name" title={displayTitle(d)}>{displayTitle(d)}</div>
        <div class="fabry-rail-chips"><CheckBadge result={result} /></div>
        <div class="fabry-rail-follow">
          <button
            type="button"
            class={'fabry-rail-pin' + (pinned ? ' on' : '')}
            aria-pressed={pinned}
            title={pinned ? 'Unpin — follow what I scroll to' : 'Pin the inspector to this deliverable'}
            onClick={() => store.setPinnedTarget(pinned ? null : d.id)}
          >{pinned ? '◉ Pinned' : '○ Following scroll'}</button>
          {held ? <span class="fabry-rail-held" title="The target stays put while this run finishes">{'held while this runs'}</span> : null}
        </div>
      </div>

      <div class="fabry-rail-tabs" role="tablist">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            class="fabry-rail-tab"
            aria-selected={active === key}
            onClick={() => setTab(key)}
          >{label}</button>
        ))}
      </div>

      <div class="fabry-rail-body">
        {wideHere ? (
          // The same panel must not be mounted twice: HistoryPanel's selection is a shared signal, so
          // two copies would fight over it. While the wide view has it, the rail points at it.
          <div class="fabry-rail-elsewhere">
            {'Shown at document width. '}
            <button type="button" class="fabry-spec-btn" onClick={() => store.setReviewTarget(null)}>{'Bring it back'}</button>
          </div>
        ) : null}
        {!wideHere && active === 'check' ? <CheckPanel key={d.id} deliverable={d} /> : null}
        {!wideHere && active === 'refine' ? <RefineDock key={d.id} deliverable={d} /> : null}
        {active === 'implement' && implAllowed ? <ImplementPanel key={d.id} deliverable={d} /> : null}
        {!wideHere && active === 'history' ? <HistoryPanel key={d.id} deliverable={d} /> : null}
        {!wideHere && (active === 'refine' || active === 'history') ? (
          // A word-diff in a 322px rail is unreadable, so it can be sent to the document column,
          // which is where the width is (spec §6).
          <button
            type="button"
            class="fabry-rail-wide"
            onClick={() => store.setReviewTarget({ id: d.id, kind: active })}
          >{'⤢ Open at document width'}</button>
        ) : null}
      </div>
    </aside>
  );
}
