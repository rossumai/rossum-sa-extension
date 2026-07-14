import { h } from 'preact';
import { useRef, useEffect, useState } from 'preact/hooks';
import * as store from '../store.js';
import * as fstore from '../../store.js';
import { openChat } from '../../chat.js';
import { updateDeliverable } from '../actions.js';
import { relativeTime, summaryLine } from '../format.js';
import MarkdownEditor from './MarkdownEditor.jsx';
import FabryMarkdown from '../../../ui/fabry/FabryMarkdown.jsx';

const CHIP = { pass: { cls: 'pass', label: '✓ Met' }, fail: { cls: 'fail', label: '✗ Not met' }, uncertain: { cls: 'uncertain', label: '? Uncertain' } };

export default function DeliverableEditor({ deliverable }) {
  const result = store.results.value[deliverable.id];
  const timer = useRef(null);
  const latest = useRef(deliverable.text);

  // Debounce persistence of edits; flush any pending edit on unmount / switch.
  // DeliverableEditor is NOT remounted on a switch (only the inner MarkdownEditor
  // is keyed), so these refs persist across switches — we MUST null timer.current
  // after clearing it, so a deliverable that was only VIEWED never triggers a
  // stale write of another's text.
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

  // Live rendered-Markdown preview (right pane); reseeded on a deliverable switch.
  const [preview, setPreview] = useState(deliverable.text);
  useEffect(() => { setPreview(deliverable.text); }, [deliverable.id]);

  // Verdict banner at the TOP. Its expand/collapse state is a SHARED preference
  // (store.verdictExpanded): expanding one deliverable's verdict opens the others
  // expanded by default too — so it's deliberately NOT reset on a switch.
  const open = store.verdictExpanded.value;

  const chip = result && !result.running ? CHIP[result.verdict] : null;
  const now = Date.now();

  return (
    <div class="fabry-arch-editor">
      {result?.running && (
        <div class="fabry-arch-details">
          <div class="fabry-arch-banner running"><span class="fabry-arch-spin" />{'Checking…'}</div>
        </div>
      )}
      {chip && (
        <div class="fabry-arch-details">
          <div class={'fabry-arch-banner ' + chip.cls}>
            <button type="button" class="fabry-arch-banner-hd" aria-expanded={open} onClick={() => { store.verdictExpanded.value = !store.verdictExpanded.value; }}>
              <span class="fabry-arch-banner-verdict">{chip.label}</span>
              {result.stale
                ? <span class="fabry-arch-banner-stale">{'last checked '}{relativeTime(result.ranAt, now) || 'previously'}{' · may be outdated — re-run'}</span>
                : <span class="fabry-arch-banner-sum">{summaryLine(result.evidence)}</span>}
              <span class="fabry-arch-banner-more">{open ? 'Hide' : 'Show evidence'}{' '}{open ? '▴' : '▾'}</span>
            </button>
            {open && (
              <div class="fabry-arch-banner-body fabry-arch-evidence">
                <FabryMarkdown text={result.evidence || '(no evidence returned)'} streaming={false} />
                <div class="fabry-arch-banner-foot">
                  <span class="fabry-arch-credit">by Mr. Fabry</span>
                  {result.chatId && <button type="button" class="fabry-arch-viewchat" onClick={viewChat}>{'View investigation →'}</button>}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      <div class="fabry-arch-editor-body">
        <div class="fabry-arch-source"><MarkdownEditor key={deliverable.id} value={deliverable.text} onChange={onChange} /></div>
        <div class="fabry-arch-preview"><FabryMarkdown text={preview} streaming={false} /></div>
      </div>
    </div>
  );
}
