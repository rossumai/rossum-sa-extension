import { h, Fragment } from 'preact';
import { useState } from 'preact/hooks';
import * as store from '../store.js';
import { askFabry } from '../index.jsx';
import FabryInput from '../../ui/fabry/FabryInput.jsx';
import FabryNarrative from '../../ui/fabry/FabryNarrative.jsx';
import FabryTranscript from '../../ui/fabry/FabryTranscript.jsx';

function flashEvidence(id, section) {
  const el = document.querySelector(`[data-evidence-id="${id}"]`) || (section ? document.querySelector(`[data-evidence-section="${section}"]`) : null);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('inspector-ev-flash');
  // restart the animation on repeated clicks
  void el.offsetWidth;
  el.classList.add('inspector-ev-flash');
}

// Resolve a [e:<id>] citation to the evidence item — chips flash/scroll the anchor.
function resolveCite(id) {
  const items = store.evidence.value?.items || [];
  const item = items.find((i) => i.id === id);
  if (!item) return null;
  return { title: item.fact, onClick: () => flashEvidence(id, item.section) };
}

// Inspector-flavored gerunds cycled while a follow-up streams (AgentBox pattern).
const GERUNDS = ['Consulting Mr. Fabry', 'Reading the evidence', 'Cross-checking logs', 'Following citations', 'Almost there'];

// Follow-up Q&A thread + ask input in the same synthesis chat — mirrors the MDH
// aggregation-pipeline prompt (sparkle idle, rainbow loader, Enter to send).
function FollowupThread({ syn }) {
  const [input, setInput] = useState('');
  const followups = syn.followups || [];
  const busy = followups.some((f) => f.status === 'streaming');
  const send = (value) => {
    const q = String(value ?? input ?? '').trim();
    if (!q || busy) return;
    setInput('');
    askFabry(q);
  };
  return (
    <div class="inspector-followups">
      {followups.map((f) => (
        <div class="inspector-followup">
          <div class="inspector-followup-q"><span class="inspector-followup-role">You</span> {f.q}</div>
          {f.status === 'error'
            ? <div class="inspector-empty">Mr. Fabry could not answer that one.</div>
            : <FabryNarrative text={f.text} streaming={f.status === 'streaming'} resolveCite={resolveCite} />}
        </div>
      ))}
      <FabryInput
        className="inspector-ask"
        value={input}
        onInput={setInput}
        onSubmit={send}
        busy={busy}
        placeholder="Ask Mr. Fabry about this annotation…"
        gerunds={GERUNDS}
      />
    </div>
  );
}

// The synthesized narrative (spec §4.4) — never gates the programmatic report.
export default function DiagnosisPanel() {
  const [showTranscript, setShowTranscript] = useState(false);
  const syn = store.synthesis.value;
  // Skeleton whenever synthesis hasn't initialized — no stage combination may
  // leave the panel silently blank (the driver co-sets synthesis on terminal
  // stages, but this must not depend on that coupling).
  const waiting = !syn;

  return (
    <div class="inspector-diag">
      <div class="inspector-diag-hd">
        {'✨'} Diagnosis <span class="inspector-diag-credit">by Mr. Fabry</span>
        {waiting ? <span class="inspector-diag-phase">starts after attribution finishes{'…'}</span> : null}
        {syn?.status === 'streaming' ? <span class="inspector-diag-phase">writing{'…'}</span> : null}
        {syn?.status === 'done' ? (
          <span class="inspector-diag-phase">
            <button type="button" class="inspector-fold-btn" onClick={() => setShowTranscript(true)}>View investigation</button>
          </span>
        ) : null}
      </div>
      {waiting && <Fragment><div class="inspector-esec-skel" style="width:92%" /><div class="inspector-esec-skel" style="width:78%" /></Fragment>}
      {syn?.status === 'offline' && <div class="inspector-empty">AI synthesis unavailable (agent offline) — the verified evidence below is complete.</div>}
      {syn?.status === 'error' && <div class="inspector-empty">AI synthesis failed{syn.error ? ` (${syn.error})` : ''} — the verified evidence below is complete.</div>}
      {(syn?.status === 'streaming' || syn?.status === 'done') && <FabryNarrative text={syn.text} streaming={syn.status === 'streaming'} resolveCite={resolveCite} />}
      {syn?.status === 'done' && syn.chatId ? <FollowupThread syn={syn} /> : null}
      {showTranscript && syn ? <FabryTranscript reasoning={syn.reasoning} tools={syn.tools || []} onClose={() => setShowTranscript(false)} /> : null}
    </div>
  );
}
