import { h } from 'preact';
import { useRef, useEffect, useState } from 'preact/hooks';
import * as store from '../store.js';
import * as fstore from '../../store.js';
import { openChat } from '../../chat.js';
import { updateDeliverable, reImplement, reRun, renameDeliverable, stopImplement } from '../actions.js';
import { relativeTime, displayTitle } from '../format.js';
import MarkdownEditor from './MarkdownEditor.jsx';
import FabryMarkdown from '../../../ui/fabry/FabryMarkdown.jsx';
import RefineDock from './RefineDock.jsx';
import { openArmDialog } from './ArmDialog.jsx';
import { promptModal } from '../../../ui/Modal.jsx';

const CHIP = { pass: { cls: 'pass', label: '✓ Met' }, fail: { cls: 'fail', label: '✗ Not met' }, uncertain: { cls: 'uncertain', label: '? Uncertain' } };

export default function DeliverableEditor({ deliverable }) {
  const result = store.results.value[deliverable.id];
  const impl = store.implement.value[deliverable.id];
  const timer = useRef(null);
  const latest = useRef(deliverable.text);
  const edRef = useRef(null);

  // Debounced persistence; flush pending edit on unmount / switch (null timer after).
  useEffect(() => () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; updateDeliverable(deliverable.id, latest.current); }
  }, [deliverable.id]);

  function onChange(text) {
    latest.current = text;
    setPreview(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; updateDeliverable(deliverable.id, text); }, 600);
  }
  function viewChat() { if (!result?.chatId) return; fstore.setFabryMode('chat'); openChat(result.chatId); }
  function rename() {
    promptModal('Rename deliverable', { initialValue: (deliverable.title || '').trim(), placeholder: 'Deliverable title', submitLabel: 'Rename' },
      (val) => renameDeliverable(deliverable.id, val));
  }

  const [preview, setPreview] = useState(deliverable.text);
  const [view, setView] = useState('edit');   // 'edit' | 'preview'
  const [tab, setTab] = useState('check');     // 'check' | 'refine' | 'implement' — Check FIRST
  useEffect(() => { setPreview(deliverable.text); setView('edit'); setTab('check'); }, [deliverable.id]);
  // CodeMirror re-measures when the Edit view is (re)shown from hidden.
  useEffect(() => { if (view === 'edit') edRef.current?.refresh?.(); }, [view]);

  const now = Date.now();
  const chip = result && !result.running ? CHIP[result.verdict] : null;
  const implAllowed = fstore.implementAllowed.value;
  const implActive = !!impl && store.implementRunning.value && (impl.status === 'planning' || impl.status === 'running');

  let pill = null;
  if (result?.running) pill = { cls: 'run', label: 'Checking…' };
  else if (chip) pill = { cls: chip.cls, label: chip.label + (result.stale ? ' · stale' : '') };

  function onImplement() { openArmDialog(1, () => { setTab('implement'); reImplement(deliverable.id); }); }

  // Drag the console's top edge to resize it (drag up = taller). Persists globally.
  function startResize(e) {
    e.preventDefault();
    const startY = e.clientY;
    const startH = store.consoleHeight.value;
    const onMove = (ev) => store.setConsoleHeight(startH + (startY - ev.clientY));
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
    };
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  return (
    <div class="fabry-arch-editor">
      <div class="fabry-arch-phead">
        <button type="button" class="fabry-arch-titlebtn" title="Rename deliverable" onClick={rename}>{displayTitle(deliverable)}</button>
        {pill && <span class={'fabry-arch-pill ' + pill.cls}>{pill.label}</span>}
      </div>

      <div class="fabry-arch-doc">
        <div class="fabry-arch-doc-bar">
          <span class="fabry-arch-doc-lbl">Requirement</span>
          <div class="fabry-arch-viewtoggle" role="group" aria-label="View">
            <button type="button" aria-pressed={view === 'edit'} onClick={() => setView('edit')}>{'✎ Edit'}</button>
            <button type="button" aria-pressed={view === 'preview'} onClick={() => setView('preview')}>{'◑ Preview'}</button>
          </div>
        </div>
        <div class="fabry-arch-doc-body">
          <div class="fabry-arch-source" hidden={view !== 'edit'}><MarkdownEditor key={deliverable.id} editorRef={edRef} value={deliverable.text} onChange={onChange} /></div>
          <div class="fabry-arch-preview" hidden={view !== 'preview'}><FabryMarkdown text={preview} streaming={false} /></div>
        </div>
      </div>

      <div class={'fabry-arch-console' + (pill ? ' verdict-' + pill.cls : '')} style={{ height: store.consoleHeight.value + 'px' }}>
        <div class="fabry-arch-console-grip" role="separator" aria-label="Resize the action console" title="Drag to resize" onMouseDown={startResize} />
        <div class="fabry-arch-ctabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'check'} class="fabry-arch-ctab" onClick={() => setTab('check')}>
            {pill && pill.cls !== 'run' && <span class={'fabry-arch-ctab-dot ' + pill.cls} />}{'Check'}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'refine'} class="fabry-arch-ctab" onClick={() => setTab('refine')}>{'✦ Refine'}</button>
          {implAllowed && <button type="button" role="tab" aria-selected={tab === 'implement'} class="fabry-arch-ctab" onClick={() => setTab('implement')}>{'▷ Implement'}{implActive ? h('span', { class: 'fabry-arch-spin', style: 'margin-left:6px' }) : null}</button>}
        </div>
        <div class="fabry-arch-cbody">
          <div class="fabry-arch-cpanel" hidden={tab !== 'check'}>
            {result?.running ? (
              <div class="fabry-arch-check-empty"><span class="fabry-arch-spin" />{'Checking…'}</div>
            ) : chip ? (
              <div class="fabry-arch-check">
                <div class={'fabry-arch-check-hd ' + chip.cls}>
                  <span class="fabry-arch-check-verdict">{chip.label}</span>
                  {result.stale && <span class="fabry-arch-check-stale">{'last checked '}{relativeTime(result.ranAt, now) || 'previously'}{' · may be outdated'}</span>}
                  <button type="button" class="fabry-arch-rerun" disabled={store.running.value} onClick={() => reRun(deliverable.id)}>{'Re-run ▷'}</button>
                </div>
                <div class="fabry-arch-evidence"><FabryMarkdown text={result.evidence || '(no evidence returned)'} streaming={false} /></div>
                <div class="fabry-arch-check-foot">
                  <span class="fabry-arch-credit">by Mr. Fabry</span>
                  {result.chatId && <button type="button" class="fabry-arch-viewchat" onClick={viewChat}>{'View investigation →'}</button>}
                </div>
              </div>
            ) : (
              <div class="fabry-arch-check-empty">{'Not checked yet. '}<button type="button" class="fabry-arch-rerun" disabled={store.running.value} onClick={() => reRun(deliverable.id)}>{'Run check ▷'}</button></div>
            )}
          </div>

          <div class="fabry-arch-cpanel" hidden={tab !== 'refine'}><RefineDock key={deliverable.id} deliverable={deliverable} /></div>

          {implAllowed && (
            <div class="fabry-arch-cpanel" hidden={tab !== 'implement'}>
              <div class="fabry-arch-implement-hd">
                <span class="fabry-arch-implement-title">{'Implement this deliverable'}</span>
                {implActive
                  ? <button type="button" class="fabry-arch-implement-stop" onClick={stopImplement}>{'Stop'}</button>
                  : <button type="button" class="fabry-arch-implement-run" disabled={store.implementRunning.value} onClick={onImplement}>{'Implement ▷'}</button>}
              </div>
              {!impl && <p class="fabry-arch-implement-hint">{'Mr. Fabry plans this deliverable into tasks and implements them autonomously — write-enabled, bounded, and audited. You confirm before it starts.'}</p>}
              {impl && (
                <div class={'fabry-arch-implement-body status-' + (impl.status || 'idle')}>
                  <div class="fabry-arch-implement-status">
                    {implActive ? h('span', { class: 'fabry-arch-spin' }) : null}
                    {impl.status === 'passing' ? '✓ implemented (check passed)'
                      : impl.status === 'failed' ? '✗ could not satisfy'
                      : impl.status === 'blocked' ? '⚠ blocked'
                      : impl.status === 'uncertain' ? '? could not verify (check error)'
                      : impl.status === 'planning' ? 'Planning tasks…'
                      : impl.status === 'running' ? 'Implementing tasks…' : ''}
                    {impl.error && <span class="fabry-arch-implement-err">{' — '}{impl.error}</span>}
                  </div>
                  {impl.tasks && impl.tasks.length > 0 && (
                    <ol class="fabry-arch-tasklist">
                      {impl.tasks.map((t) => (
                        <li key={t.id} class={'fabry-arch-task task-' + (t.status || 'pending')}>
                          <span class="fabry-arch-task-dot" />
                          <span class="fabry-arch-task-text">{t.text}</span>
                          {t.origin && t.origin !== 'plan' && <span class="fabry-arch-task-origin">{t.origin}</span>}
                        </li>
                      ))}
                    </ol>
                  )}
                  {impl.summary && <div class="fabry-arch-implement-summary">{impl.summary}</div>}
                  {impl.notes && impl.notes.length > 0 && impl.notes.map((n, i) => <div key={i} class="fabry-arch-implement-note">{n}</div>)}
                  {impl.writes && impl.writes.length > 0 && (
                    <ul class="fabry-arch-implement-audit">
                      {impl.writes.map((w, i) => (
                        <li key={i} class={w.ok ? 'ok' : 'pending'}><code>{w.tool}</code>{w.argsSummary ? ' ' + w.argsSummary : ''}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
