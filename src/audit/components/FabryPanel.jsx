// src/audit/components/FabryPanel.jsx
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import * as store from '../store.js';
import { askAuditFabry, runDefaultSummary, refreshSummary, viewSignature } from '../index.jsx';
import FabryInput from '../../ui/fabry/FabryInput.jsx';
import FabryNarrative from '../../ui/fabry/FabryNarrative.jsx';
import FabryTranscript from '../../ui/fabry/FabryTranscript.jsx';
import FabryMark from '../../ui/FabryMark.jsx';

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
// A refresh appends a NEW summary turn (question:null) rather than replacing
// the first one, so the preview normally tracks the LATEST summary turn, not
// the original turns[0]. But the latest attempt can itself be a failure (or a
// done-but-empty turn) while an EARLIER summary already produced good text —
// in that case a still-valid takeaway shouldn't be masked by the freshest
// error; the "view changed"/stale marker in the bar already tells the user
// the page moved on. Only report "unavailable" when no summary ever produced
// text at all.
export function previewText(f) {
  const summaries = (f.turns || []).filter((t) => t.question == null);
  if (!summaries.length) return null;
  const last = summaries[summaries.length - 1];
  if (last.state === 'streaming') {
    const line = String(last.text || '').split('\n')[0].trim();
    return line || 'summarizing the loaded page…';
  }
  // Last attempt errored or came back empty → fall back to the most recent
  // summary that actually produced text (the stale marker still tells the
  // user the view changed); only claim "unavailable" when none ever did.
  const lastGood = [...summaries].reverse().find((t) => t.state === 'done' && String(t.text || '').split('\n')[0].trim());
  if (lastGood) return String(lastGood.text).split('\n')[0].trim();
  return 'summary unavailable';
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
  // Reading these signals here (rather than only inside viewSignature/the
  // helper) is what makes the render reactive to filter changes — Preact
  // subscribes to any signal read during render.
  const avail = store.availability.value;
  const sig = viewSignature();
  const stale = f.forView != null && f.forView !== sig;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) {
      if (store.fabry.value.status === 'idle') runDefaultSummary(); // fallback (normally auto-run)
      // A deliberate click is a manual retry — refresh even if this exact
      // view previously failed (refreshFailedFor doesn't gate this branch,
      // only the automatic effect below).
      else if (stale) refreshSummary(); // self-guards on availability/busy
    }
  };

  // Auto-refresh while the panel stays open: once the view changes (stale)
  // and the new rows have landed (avail === 'available'), re-summarize
  // without waiting for another expand. Never fires while collapsed. Gated
  // on refreshFailedFor so a failed attempt for THIS view isn't retried on
  // every render — otherwise a persistent failure (forView stays stale-
  // mismatched) would re-fire refreshSummary in an unbounded loop the moment
  // `busy` flips back to false. A new filter change produces a new
  // signature, which no longer matches refreshFailedFor, re-arming this.
  useEffect(() => {
    if (open && stale && avail === 'available' && !busy && f.refreshFailedFor !== sig) refreshSummary();
  }, [open, stale, avail, busy, f.refreshFailedFor, sig]);

  return (
    <div class="audit-fabry">
      <div class="audit-fabry-bar">
        <button type="button" class="audit-fabry-toggle" aria-expanded={open ? 'true' : 'false'} onClick={toggle}>
          <span class="audit-fabry-title"><span class="audit-fabry-mark"><FabryMark /></span> Audit insights</span>
          <span class="inspector-diag-credit">by Mr. Fabry</span>
          {!open && preview ? <span class="audit-fabry-preview">{'— ' + preview}</span> : null}
          {!open && preview && stale ? <span class="audit-fabry-stale">{'· view changed'}</span> : null}
          {!open && !preview ? <span class="audit-fabry-hint">summarize &amp; ask about the loaded page</span> : null}
        </button>
        {open && lastDone ? <button type="button" class="inspector-fold-btn audit-fabry-tx" onClick={() => setShowTx(true)}>View investigation</button> : null}
      </div>
      {open && (
        <div class="audit-fabry-body">
          {f.turns.map((t) => <Turn key={t.id} turn={t} />)}
          <FabryInput
            size="sm"
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
