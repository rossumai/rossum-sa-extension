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

// Playful MongoDB/Rossum gerunds cycled in the loading placeholder.
const GERUNDS = [
  'Summoning Mr. Fabry', 'Aggregating', 'Unwinding arrays', 'Matching values',
  'Projecting fields', 'Sorting things out', 'Grouping documents', 'Sifting the data',
  'Polishing the pipeline', 'Verifying results', 'Almost there',
];
const GERUND_MS = 2400; // rotation cadence (kept gentle)

function fieldsNow() {
  const merged = new Set([...extractFieldNames(records.value), ...sampledFields.value]);
  return [...merged].sort();
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
      onUpdate({ ...session, transcript: res.transcript });
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
          {busy && <div class="nl-search-loading">Refining…</div>}
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
  const [gi, setGi] = useState(0);
  const [session, setSession] = useState(null); // { chatId, transcript, ctx }
  const abortRef = useRef(null);

  useEffect(() => () => { if (abortRef.current) abortRef.current.abort(); }, []);
  // Abort an in-flight run and drop the stale session when the collection changes.
  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();
    setSession(null);
  }, [selectedCollection.value]);
  // Cycle the loading gerund while a run is in flight.
  useEffect(() => {
    if (!loading) return undefined;
    setGi(0);
    const id = setInterval(() => setGi((i) => (i + 1) % GERUNDS.length), GERUND_MS);
    return () => clearInterval(id);
  }, [loading]);

  async function submit(value) {
    const q = (value ?? input ?? '').trim();
    if (!q || loading || !editorRef?.current) return;

    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const col = selectedCollection.value; // capture: guards against a collection switch mid-run

    setInput('');
    setSession(null);
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
        signal: ctrl.signal,
      });
      if (col !== selectedCollection.value) return; // stale — user switched collections
      // Keep the chat + context so the transcript modal can CONTINUE this conversation.
      setSession(transcript && transcript.length ? { chatId, transcript, ctx: { collection: col, fields, samples, hints } } : null);
      if (pipelineText) {
        editorRef.current.setValue(pipelineText); // no "AI request" comment — the transcript modal carries that context
      } else if (note?.kind === 'blocked') {
        error.value = { message: 'That request looked like it would modify data — only read-only queries are allowed.' };
      } else {
        error.value = { message: 'Couldn’t build a query for that request.' };
      }
    } catch (err) {
      if (err?.name === 'AbortError') return;
      error.value = { message: err?.status === 401 ? err.message : 'AI query failed: ' + (err?.message || '') };
    } finally {
      setLoading(false);
    }
  }

  return (
    <div class="agent-box">
      <div class="agent-input-row">
        <div class="nl-search-wrapper">
          <input
            class={'nl-search-input' + (loading ? ' loading' : '')}
            type="text"
            placeholder="Describe a query in plain English…"
            value={loading ? '' : input}
            disabled={loading}
            onInput={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(e.target.value); if (e.key === 'Escape') setInput(''); }}
          />
          {loading && <div class="nl-search-loading">{`${GERUNDS[gi]}…`}</div>}
        </div>
      </div>
      <div class="agent-footer">
        {!loading && session && (
          <button type="button" class="agent-transcript-link" onClick={() => showTranscript(session, editorRef, setSession)}>View transcript</button>
        )}
        <span class="agent-attribution">Powered by Mr. Fabry</span>
      </div>
    </div>
  );
}
