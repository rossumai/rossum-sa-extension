import { h } from 'preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import { selectedCollection, records, sampledFields, error } from '../store.js';
import { extractFieldNames } from './JsonEditor.jsx';
import { openModal } from './Modal.jsx';
import * as agentApi from '../agent/agentApi.js';
import * as api from '../api.js';
import { runAgentQuery, continueAgentQuery } from '../agent/agentQuery.js';
import { getSchemaHints } from '../agent/aiContext.js';
import { stripAiComment } from '../llmPipeline.js';
import FabryInput from '../../ui/fabry/FabryInput.jsx';

// Playful MongoDB/Rossum gerunds cycled in the loading placeholder.
const GERUNDS = [
  'Summoning Mr. Fabry', 'Aggregating', 'Unwinding arrays', 'Matching values',
  'Projecting fields', 'Sorting things out', 'Grouping documents', 'Sifting the data',
  'Polishing the pipeline', 'Verifying results', 'Almost there',
];

// Footer phase tracker steps (keys match agentQuery's onPhase). Refine is appended
// only when a correction turn actually happens — the tracker stays honest.
const PHASES = [['generate', 'Generate'], ['run', 'Run'], ['verify', 'Verify']];
const REFINE_PHASE = ['refine', 'Refine'];

function fieldsNow() {
  const merged = new Set([...extractFieldNames(records.value), ...sampledFields.value]);
  return [...merged].sort();
}

// Map a finished run's note to the compact footer result line.
// ok:true means a pipeline was applied to the editor; ok:false is a failure message.
export function outcomeFor(request, note) {
  const rows = (n) => `${n} row${n === 1 ? '' : 's'}`;
  switch (note?.kind) {
    case 'verified':
    case 'refined':
      return { ok: true, request, meta: note.rowCount == null ? 'verified' : `${rows(note.rowCount)} · verified` };
    case 'empty': return { ok: true, request, meta: '0 matching rows' };
    case 'unrun': return { ok: true, request, meta: 'applied' };
    case 'error': return { ok: true, request, meta: 'applied · run failed' };
    case 'blocked': return { ok: false, request, message: 'Blocked — that request would modify data; only read-only queries are allowed.' };
    default: return { ok: false, request, message: 'Couldn’t build a query for that request.' };
  }
}

// Generate → Run → Verify (→ Refine) tracker shown in the footer slot while running.
function PhaseTracker({ phase, hadRefine }) {
  const steps = hadRefine ? [...PHASES, REFINE_PHASE] : PHASES;
  const idx = steps.findIndex(([k]) => k === phase);
  return (
    <div class="agent-phases">
      {steps.map(([k, label], i) => (
        <span key={k} class={'agent-phase' + (k === phase ? ' active' : idx >= 0 && i < idx ? ' done' : '')}>
          <i />{label}
        </span>
      ))}
    </div>
  );
}

// Compact result line filling the footer slot when a run finishes.
function ResultLine({ outcome, onOpen }) {
  return (
    <div class="agent-result">
      <span class={outcome.ok ? 'agent-result-ok' : 'agent-result-err'}>{outcome.ok ? '✓' : '✗'}</span>
      {outcome.ok
        ? (
          <span class="agent-result-sum" title={outcome.request}>{outcome.request}</span>
        )
        : <span class="agent-result-msg" title={outcome.message}>{outcome.message}</span>}
      {outcome.ok && <span class="agent-result-meta">{'· ' + outcome.meta}</span>}
      {onOpen && <button type="button" class="agent-transcript-link" onClick={onOpen}>View conversation</button>}
    </div>
  );
}

const roleLabel = (r) => (r === 'user' ? 'You' : r === 'assistant' ? 'Mr. Fabry' : 'Run');

// One transcript turn — assistant shows reasoning (if any) + full reply in a <pre>.
function Turn({ t }) {
  return (
    <div class={'agent-chat-turn agent-chat-' + t.role}>
      <div class="agent-chat-role">{roleLabel(t.role)}</div>
      {t.role === 'assistant'
        ? (
          <div class="agent-chat-assistant-body">
            {t.reasoning ? <div class="agent-chat-reasoning">{t.reasoning}</div> : null}
            <pre class="agent-chat-code">{t.text}</pre>
          </div>
        )
        : <div class="agent-chat-text">{t.text}</div>}
    </div>
  );
}

// Interactive transcript modal: shows the run's conversation AND lets the user
// CONTINUE the same chat to iterate on the resulting query. `onUpdate` propagates
// the grown transcript back so reopening shows it.
export function TranscriptModal({ session, editorRef, onUpdate }) {
  const [turns, setTurns] = useState(session.transcript || []);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef(null);
  const scrollRef = useRef(null);

  useEffect(() => () => { if (abortRef.current) abortRef.current.abort(); }, []);
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [turns, busy]);

  async function send(value) {
    const q = (value ?? input ?? '').trim();
    if (!q || busy || !session.chatId) return;
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setInput('');
    setBusy(true);
    try {
      const ctx = session.ctx || {};
      const currentPipeline = stripAiComment(editorRef?.current?.getValue?.() || '');
      const res = await continueAgentQuery({
        api,
        agentApi,
        chatId: session.chatId,
        request: q,
        collection: ctx.collection,
        fields: ctx.fields || [],
        samples: ctx.samples || null,
        hints: ctx.hints || {},
        currentPipeline,
        transcript: turns,
        signal: ctrl.signal,
      });
      setTurns(res.transcript);
      if (res.pipelineText && editorRef?.current) editorRef.current.setValue(res.pipelineText);
      // lastNote/lastRequest let the AgentBox footer result line reflect this continuation.
      onUpdate({ ...session, transcript: res.transcript, lastNote: res.note, lastRequest: q });
    } catch (err) {
      if (err?.name === 'AbortError') return;
      error.value = { message: 'AI query failed: ' + (err?.message || '') };
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="modal-body agent-chat-modal">
      <div class="agent-chat" ref={scrollRef}>
        {turns.map((t, i) => <Turn key={i} t={t} />)}
      </div>
      <div class="agent-chat-continue">
        <div class="nl-search-wrapper">
          <input
            class={'nl-search-input' + (busy ? ' loading' : '')}
            type="text"
            placeholder="Continue — refine this query…"
            value={busy ? '' : input}
            disabled={busy}
            onInput={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') send(e.target.value); }}
          />
          {busy && <div class="nl-search-loading"><span class="nl-gerund">Refining…</span></div>}
        </div>
      </div>
    </div>
  );
}

function showTranscript(session, editorRef, onUpdate) {
  openModal('Mr. Fabry — conversation', () => h(TranscriptModal, { session, editorRef, onUpdate }));
}

export default function AgentBox({ editorRef }) {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState(null); // 'generate'|'run'|'verify'|'refine' while loading
  const [hadRefine, setHadRefine] = useState(false); // a correction turn happened this run
  const [outcome, setOutcome] = useState(null); // finished-run result line (see outcomeFor)
  const [session, setSession] = useState(null); // { chatId, transcript, ctx }
  const abortRef = useRef(null);

  useEffect(() => () => { if (abortRef.current) abortRef.current.abort(); }, []);
  // Abort an in-flight run and drop the stale session/result when the collection CHANGES.
  // Skip the mount flush: preact defers effects, so without the guard a submit issued
  // right after mount would have its fresh AbortController killed by this effect.
  const colSeen = useRef(false);
  useEffect(() => {
    if (!colSeen.current) { colSeen.current = true; return; }
    if (abortRef.current) abortRef.current.abort();
    setSession(null);
    setOutcome(null);
  }, [selectedCollection.value]);

  // A continuation from the transcript modal grew the chat — mirror it in the result line.
  function handleSessionUpdate(s) {
    setSession(s);
    if (s?.lastNote) setOutcome((prev) => outcomeFor(s.lastRequest || prev?.request || '', s.lastNote));
  }

  async function submit(value) {
    const q = (value ?? input ?? '').trim();
    if (!q || loading || !editorRef?.current) return;

    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const col = selectedCollection.value; // capture: guards against a collection switch mid-run

    setInput('');
    setSession(null);
    setOutcome(null);
    setPhase(null);
    setHadRefine(false);
    setLoading(true);
    try {
      const fields = fieldsNow();
      const samples = (records.value || []).slice(0, 3);
      const hints = await getSchemaHints(api, col, records.value).catch(() => ({}));
      const { pipelineText, note, transcript, chatId } = await runAgentQuery({
        api,
        agentApi,
        request: q,
        collection: col,
        fields,
        samples,
        currentPipeline: stripAiComment(editorRef.current.getValue()),
        hints,
        onPhase: (p) => { if (ctrl.signal.aborted) return; setPhase(p); if (p === 'refine') setHadRefine(true); },
        signal: ctrl.signal,
      });
      if (col !== selectedCollection.value) return; // stale — user switched collections
      // Keep the chat + context so the transcript modal can CONTINUE this conversation.
      setSession(transcript && transcript.length ? { chatId, transcript, ctx: { collection: col, fields, samples, hints } } : null);
      if (pipelineText) {
        editorRef.current.setValue(pipelineText); // no "AI request" comment — the transcript modal carries that context
      }
      // AI-specific outcomes (incl. blocked / couldn't-build) live in the footer slot, not the global banner.
      setOutcome(outcomeFor(q, note));
    } catch (err) {
      if (err?.name === 'AbortError') return;
      if (err?.status === 401) error.value = { message: err.message }; // session-wide — stays global
      else setOutcome({ ok: false, request: q, message: 'AI query failed: ' + (err?.message || '') });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div class="agent-box">
      <FabryInput
        value={input}
        onInput={setInput}
        onSubmit={submit}
        busy={loading}
        placeholder="Ask Mr. Fabry — describe a query…"
        gerunds={GERUNDS}
      />
      {(loading || outcome) && (
        <div class="agent-footer">
          {loading
            ? <PhaseTracker phase={phase} hadRefine={hadRefine} />
            : (
              <ResultLine
                outcome={outcome}
                onOpen={session ? () => showTranscript(session, editorRef, handleSessionUpdate) : null}
              />
            )}
        </div>
      )}
    </div>
  );
}
