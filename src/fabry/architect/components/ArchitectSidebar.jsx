import { h, Fragment } from 'preact';
import { useEffect, useState, useRef } from 'preact/hooks';
import * as store from '../store.js';
import { loadArchitect, addDeliverable, openDeliverable, runAll, stopRun, moveDeliverable, reRun, deleteDeliverable, reImplement, renameDeliverable } from '../actions.js';
import { displayTitle } from '../format.js';
import { confirmModal, promptModal } from '../../../ui/Modal.jsx';
import * as fstore from '../../store.js';
import { openArmDialog } from './ArmDialog.jsx';

function dotClass(r) {
  if (!r) return 'none';
  if (r.running) return 'running';
  if (r.verdict === 'pass') return 'pass' + (r.stale ? ' stale' : '');
  if (r.verdict === 'fail') return 'fail' + (r.stale ? ' stale' : '');
  if (r.verdict === 'uncertain') return 'uncertain' + (r.stale ? ' stale' : '');
  return 'none';
}

// Live results summary for the footer (B2). Counts are scoped to deliverables
// currently in the list, so a stray/orphan result can never make the breakdown
// exceed the total.
function Summary({ ds, results, running }) {
  const total = ds.length;
  if (!total) return null;
  const done = ds.map((d) => results[d.id]).filter((r) => r && !r.running && r.verdict);
  if (running) {
    return <div class="fabry-arch-summary">{done.length}{' / '}{total} checked</div>;
  }
  if (!done.length) {
    return <div class="fabry-arch-summary">{total}{' '}deliverable{total === 1 ? '' : 's'}{' · not yet run'}</div>;
  }
  const met = done.filter((r) => r.verdict === 'pass').length;
  const notmet = done.filter((r) => r.verdict === 'fail').length;
  const unc = done.filter((r) => r.verdict === 'uncertain').length;
  return (
    <div class="fabry-arch-summary">
      {total}{' '}deliverable{total === 1 ? '' : 's'}
      {met > 0 && <>{' · '}<span class="ok">{met} met</span></>}
      {notmet > 0 && <>{' · '}<span class="bad">{notmet} not met</span></>}
      {unc > 0 && <>{' · '}<span class="warn">{unc} uncertain</span></>}
    </div>
  );
}

export default function ArchitectSidebar() {
  useEffect(() => { loadArchitect(); }, []);
  const ds = store.deliverables.value;
  const results = store.results.value;
  const running = store.running.value;
  const implementAllowed = fstore.implementAllowed.value;
  const implementRunning = store.implementRunning.value;

  // Drag-and-drop reordering.
  const [dragId, setDragId] = useState(null);
  const [overId, setOverId] = useState(null);
  const dragIndex = dragId ? ds.findIndex((d) => d.id === dragId) : -1;
  function onDrop(targetId) {
    if (dragId && dragId !== targetId) moveDeliverable(dragId, ds.findIndex((d) => d.id === targetId));
    setDragId(null);
    setOverId(null);
  }

  // Per-row kebab (⋮) menu: Re-run + Delete (Delete → shared confirm modal).
  const listRef = useRef(null);
  const [menuId, setMenuId] = useState(null);
  const [menuUp, setMenuUp] = useState(false);
  function openMenu(id, e) {
    if (menuId === id) { setMenuId(null); return; }
    // Open upward only when there isn't room below AND there's more room above,
    // so the menu stays inside the scrolling list.
    let up = false;
    try {
      const kb = e.currentTarget.getBoundingClientRect();
      const lr = listRef.current && listRef.current.getBoundingClientRect();
      if (lr) { const below = lr.bottom - kb.bottom; up = below < 96 && (kb.top - lr.top) > below; }
    } catch { /* no layout (jsdom) → open downward */ }
    setMenuUp(up);
    setMenuId(id);
  }
  function closeMenu() { setMenuId(null); }
  // Close the menu on any outside click.
  useEffect(() => {
    if (!menuId) return undefined;
    const onDown = (e) => { if (!e.target.closest || !e.target.closest('.fabry-arch-menu, .fabry-arch-kebab')) closeMenu(); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuId]);

  function confirmDelete(id) {
    closeMenu();
    confirmModal('Delete deliverable', "Delete this deliverable? This can't be undone.", () => deleteDeliverable(id));
  }

  return (
    <div class="fabry-arch-side">
      {store.loadError.value && <div class="fabry-arch-error">{store.loadError.value}</div>}
      <div class="fabry-arch-list" ref={listRef}>
        {ds.length === 0 && <div class="fabry-arch-empty">No deliverables yet.</div>}
        {ds.map((d, i) => (
          <div
            key={d.id}
            role="button"
            tabIndex={0}
            draggable
            class={'fabry-arch-item'
              + (store.activeId.value === d.id ? ' active' : '')
              + (dragId === d.id ? ' dragging' : '')
              + (menuId === d.id ? ' menuopen' : '')
              + (overId === d.id && dragId && dragId !== d.id
                ? (dragIndex >= 0 && dragIndex < i ? ' dragover-after' : ' dragover-before')
                : '')}
            onClick={() => openDeliverable(d.id)}
            onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openDeliverable(d.id); } }}
            onDragStart={(e) => { setDragId(d.id); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'; }}
            onDragOver={(e) => { e.preventDefault(); if (overId !== d.id) setOverId(d.id); }}
            onDragLeave={() => setOverId((v) => (v === d.id ? null : v))}
            onDrop={(e) => { e.preventDefault(); onDrop(d.id); }}
            onDragEnd={() => { setDragId(null); setOverId(null); }}
          >
            <span class={'fabry-arch-dot ' + dotClass(results[d.id])} />
            <span class="fabry-arch-item-title">{displayTitle(d)}</span>
            <button
              type="button"
              class="fabry-arch-kebab"
              title="Deliverable actions"
              aria-label="Deliverable actions"
              onClick={(e) => { e.stopPropagation(); openMenu(d.id, e); }}
            >{'⋮'}</button>
            {menuId === d.id && (
              <div class={'fabry-arch-menu' + (menuUp ? ' up' : '')} onClick={(e) => e.stopPropagation()}>
                <button type="button" class="fabry-arch-menu-item" disabled={running || implementRunning || results[d.id]?.running} onClick={() => { reRun(d.id); closeMenu(); }}>{'Re-run ▷'}</button>
                {implementAllowed && (
                  <button type="button" class="fabry-arch-menu-item" disabled={implementRunning || running || results[d.id]?.running}
                    onClick={() => { closeMenu(); openArmDialog(1, () => reImplement(d.id)); }}>
                    {'Implement ▷'}
                  </button>
                )}
                <button type="button" class="fabry-arch-menu-item" onClick={() => { closeMenu(); promptModal('Rename deliverable', { initialValue: (d.title || '').trim(), placeholder: 'Deliverable title', submitLabel: 'Rename' }, (v) => renameDeliverable(d.id, v)); }}>{'Rename…'}</button>
                <button type="button" class="fabry-arch-menu-item danger" onClick={() => confirmDelete(d.id)}>Delete</button>
              </div>
            )}
          </div>
        ))}
      </div>
      <div class="fabry-arch-foot">
        <button
          type="button"
          class="fabry-arch-runall"
          disabled={implementRunning || (!running && ds.length === 0)}
          onClick={() => (running ? stopRun() : runAll())}
        >
          {running ? 'Stop' : 'Run all ▷'}
        </button>
        <Summary ds={ds} results={results} running={running} />
        <button type="button" class="fabry-arch-new" onClick={() => addDeliverable()}>{'＋ New deliverable'}</button>
      </div>
    </div>
  );
}
