// src/audit/components/FabryPanel.jsx
import { h } from 'preact';
import { useState } from 'preact/hooks';
import * as store from '../store.js';
import { askAuditFabry, runDefaultSummary } from '../index.jsx';
import FabryInput from '../../ui/fabry/FabryInput.jsx';
import FabryNarrative from '../../ui/fabry/FabryNarrative.jsx';
import FabryTranscript from '../../ui/fabry/FabryTranscript.jsx';

const GERUNDS = ['Summoning Mr. Fabry', 'Reading the audit log', 'Tracing activity', 'Cross-checking events', 'Almost there'];

function Turn({ turn }) {
  return (
    <div class="audit-fabry-turn">
      <div class="inspector-followup-q">
        <span class="inspector-followup-role">{turn.question == null ? 'Latest activity' : 'You'}</span>
        {turn.question == null ? null : ' ' + turn.question}
      </div>
      {turn.state === 'error'
        ? <div class="inspector-empty">Mr. Fabry could not answer that one.</div>
        : (turn.text
            ? <FabryNarrative text={turn.text} streaming={turn.state === 'streaming'} />
            : <div class="inspector-esec-skel" style="width:88%" />)}
    </div>
  );
}

// The summary's first line (its takeaway) doubles as the collapsed-bar preview —
// one agent call powers both, and the preview streams in as the text arrives.
export function previewText(f) {
  const t0 = f.turns[0];
  if (!t0 || t0.question != null) return null;
  if (t0.state === 'error') return 'summary unavailable';
  const line = String(t0.text || '').split('\n')[0].trim();
  if (line) return line;
  // Streaming with no text yet → progress note; done-but-empty → honest gap
  // (matches the error path, instead of falling back to the idle hint).
  return t0.state === 'streaming' ? 'summarizing the loaded page…' : 'summary unavailable';
}

// Mr. Fabry as a slim purple band in the audit header (Inspector Diagnosis
// identity). Collapsed by default: one line with a live Fabry-generated
// preview. Expanded: the thread reads top-down like a chat, input at the
// bottom. The summary auto-runs once rows load (see initAudit); toggle keeps
// an idle fallback for the rare expand-before-rows case.
export default function FabryPanel() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [showTx, setShowTx] = useState(false);
  const f = store.fabry.value;
  const busy = f.turns.some((t) => t.state === 'streaming');
  const lastDone = [...f.turns].reverse().find((t) => t.state === 'done');
  const send = (v) => { const q = String(v ?? input).trim(); if (!q || busy) return; setInput(''); askAuditFabry(q); };
  const preview = previewText(f);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && store.fabry.value.status === 'idle') runDefaultSummary(); // fallback (normally auto-run)
  };

  return (
    <div class="audit-fabry">
      <div class="audit-fabry-bar">
        <button type="button" class="audit-fabry-toggle" aria-expanded={open ? 'true' : 'false'} onClick={toggle}>
          <span class="audit-fabry-title"><span class="audit-fabry-mark">{'✦'}</span> Audit insights</span>
          <span class="inspector-diag-credit">by Mr. Fabry</span>
          {!open && preview ? <span class="audit-fabry-preview">{'— ' + preview}</span> : null}
          {!open && !preview ? <span class="audit-fabry-hint">summarize &amp; ask about the loaded page</span> : null}
        </button>
        {open && lastDone ? <button type="button" class="inspector-fold-btn audit-fabry-tx" onClick={() => setShowTx(true)}>View investigation</button> : null}
      </div>
      {open && (
        <div class="audit-fabry-body">
          {f.turns.map((t) => <Turn key={t.id} turn={t} />)}
          <FabryInput
            value={input}
            onInput={setInput}
            onSubmit={send}
            busy={busy}
            placeholder="Ask a follow-up about this audit page…"
            gerunds={GERUNDS}
          />
        </div>
      )}
      {showTx && lastDone ? <FabryTranscript reasoning={lastDone.reasoning} tools={lastDone.tools || []} onClose={() => setShowTx(false)} /> : null}
    </div>
  );
}
