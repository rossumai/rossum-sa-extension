import { h, Fragment } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import * as store from '../store.js';
import { askFabry } from '../index.jsx';
import { parseNarrative } from '../synthesize.js';

function flashEvidence(id, section) {
  const el = document.querySelector(`[data-evidence-id="${id}"]`) || (section ? document.querySelector(`[data-evidence-section="${section}"]`) : null);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('inspector-ev-flash');
  // restart the animation on repeated clicks
  void el.offsetWidth;
  el.classList.add('inspector-ev-flash');
}

function Cite({ id }) {
  const items = store.evidence.value?.items || [];
  const item = items.find((i) => i.id === id);
  if (!item) return <span class="inspector-cite unresolved" title="cited evidence not found">{id}</span>;
  return (
    <button type="button" class="inspector-cite" title={item.fact} onClick={() => flashEvidence(id, item.section)}>{id}</button>
  );
}

// Line-aware rendering: consecutive "- " bullets group into one list; other
// lines are paragraphs. Streaming-safe (partial last line renders as-is).
function Narrative({ text, streaming }) {
  const blocks = parseNarrative(text);
  const out = [];
  let bullets = [];
  const seg = (segments) => segments.map((s) => (s.type === 'cite' ? <Cite id={s.id} /> : <span>{s.text}</span>));
  const flush = () => { if (bullets.length) { out.push(<ul class="inspector-diag-list">{bullets}</ul>); bullets = []; } };
  for (const b of blocks) {
    if (b.type === 'li') bullets.push(<li>{seg(b.segments)}</li>);
    else { flush(); out.push(<p>{seg(b.segments)}</p>); }
  }
  flush();
  return (
    <div class="inspector-diag-body">
      {out}
      {streaming ? <span class="inspector-caret" /> : null}
    </div>
  );
}

// Inspector-flavored gerunds cycled while a follow-up streams (AgentBox pattern).
const GERUNDS = ['Consulting Mr. Fabry', 'Reading the evidence', 'Cross-checking logs', 'Following citations', 'Almost there'];
const GERUND_MS = 2400;

// Follow-up Q&A thread + ask input in the same synthesis chat — mirrors the MDH
// aggregation-pipeline prompt (sparkle idle, rainbow loader, Enter to send).
function FollowupThread({ syn }) {
  const [input, setInput] = useState('');
  const [gi, setGi] = useState(0);
  const followups = syn.followups || [];
  const busy = followups.some((f) => f.status === 'streaming');
  useEffect(() => {
    if (!busy) return undefined;
    const t = setInterval(() => setGi((n) => n + 1), GERUND_MS);
    return () => clearInterval(t);
  }, [busy]);
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
            : <Narrative text={f.text} streaming={f.status === 'streaming'} />}
        </div>
      ))}
      <div class="agent-input-row inspector-ask">
        <div class="nl-search-wrapper">
          <span class={'agent-spark' + (busy ? ' loading' : '')}>{'✦'}</span>
          <input
            class={'nl-search-input' + (busy ? ' loading' : '')}
            type="text"
            placeholder="Ask Mr. Fabry about this annotation…"
            value={busy ? '' : input}
            disabled={busy}
            onInput={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') send(e.target.value); if (e.key === 'Escape') setInput(''); }}
          />
          {busy && (
            <div class="nl-search-loading">
              {gi > 0 && <span key={'o' + gi} class="nl-gerund nl-gerund-out">{GERUNDS[(gi - 1) % GERUNDS.length] + '…'}</span>}
              <span key={'i' + gi} class="nl-gerund nl-gerund-in">{GERUNDS[gi % GERUNDS.length] + '…'}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Transcript({ reasoning, tools, onClose }) {
  return (
    <div class="inspector-modal-backdrop" onClick={onClose}>
      <div class="inspector-modal" onClick={(e) => e.stopPropagation()}>
        <div class="inspector-modal-hd">Investigation transcript <button type="button" class="inspector-modal-x" onClick={onClose}>{'×'}</button></div>
        {tools.length ? <div class="inspector-note">Tools used: {tools.join(', ')}</div> : null}
        <pre class="inspector-code-block">{reasoning || '(no reasoning recorded)'}</pre>
      </div>
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
      {(syn?.status === 'streaming' || syn?.status === 'done') && <Narrative text={syn.text} streaming={syn.status === 'streaming'} />}
      {syn?.status === 'done' && syn.chatId ? <FollowupThread syn={syn} /> : null}
      {showTranscript && syn ? <Transcript reasoning={syn.reasoning} tools={syn.tools || []} onClose={() => setShowTranscript(false)} /> : null}
    </div>
  );
}
