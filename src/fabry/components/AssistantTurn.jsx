import { h } from 'preact';
import { useState } from 'preact/hooks';
import FabryMarkdown from '../../ui/fabry/FabryMarkdown.jsx';
import FabryNotice from '../../ui/fabry/FabryNotice.jsx';
import FabryQuestions from './FabryQuestions.jsx';
import { toolLabel, fallbackNotice } from '../../agent/agentStream.js';
import { openChat, answerQuestions } from '../chat.js';
import * as store from '../store.js';

// One assistant turn: collapsible reasoning, ordered tool chips, then either the
// markdown body, a clarifying-question form (turn.questions), or a fallback
// notice — never blank. Footer = Copy + the deep-verify verdict chip (the 👍/👎
// feedback UI is hidden pending a backend feedback-id fix; see the footer). The
// `threadIdx` prop is retained for the dormant feedback path.
export default function AssistantTurn({ turn, threadIdx, streaming }) {
  const [showThinking, setShowThinking] = useState(false);
  const [showDeep, setShowDeep] = useState(false);
  const open = streaming || showThinking; // stream visibly, collapse when done
  return (
    <div class={'fabry-turn-assistant' + (streaming ? ' fabry-turn-live' : '')}>
      {turn.reasoning ? (
        <div class="fabry-thinking">
          <button type="button" class="fabry-thinking-toggle" onClick={() => setShowThinking(!showThinking)}>
            {open ? 'Thinking ▾' : 'Thinking ▸'}
          </button>
          {open && <pre class="fabry-thinking-body">{turn.reasoning}</pre>}
        </div>
      ) : null}
      {turn.tools && turn.tools.length ? (
        <div class="fabry-tools">{turn.tools.map((t, idx) => <span key={idx} class="fabry-tool-chip" title={t}>{toolLabel(t)}</span>)}</div>
      ) : null}
      {(streaming || turn.text) ? <FabryMarkdown text={turn.text} streaming={streaming} /> : null}
      {!streaming && turn.questions ? <FabryQuestions questions={turn.questions} onSubmit={(a) => answerQuestions(a)} /> : null}
      {!streaming ? <FabryNotice notice={fallbackNotice(turn)} /> : null}
      {turn.interrupted && (
        <div class="fabry-interrupted">
          Stopped before the reply finished.{' '}
          <button type="button" class="fabry-refresh" onClick={() => openChat(store.activeChatId.value)}>Refresh from server</button>
        </div>
      )}
      {!streaming && !turn.interrupted && !turn.questions && !fallbackNotice(turn) && (
        <div class="fabry-turn-foot">
          {/* 👍/👎 hidden pending a backend fix: PUT /feedback's turn_index
              addresses the RAW stored history, but GET /chats drops text-less
              tool-only steps, so our thread index mis-targets feedback on any
              tool-using turn (live-confirmed 2026-07-13; spec §9b). The
              plumbing (sendFeedback / serverMessageIndex / submitFeedback) is
              kept dormant for a one-line re-enable once the backend exposes a
              stable per-message feedback id. */}
          <button type="button" class="fabry-copy" title="Copy reply" onClick={() => navigator.clipboard?.writeText(turn.text)}>Copy</button>
          {turn.deep && (
            <button type="button" class={'fabry-deep-chip ' + turn.deep.verdict} onClick={() => setShowDeep(!showDeep)}>
              {turn.deep.verdict === 'pass' && <span>{'✓'} Independently verified</span>}
              {turn.deep.verdict === 'fail' && <span>{'⚠'} {turn.deep.issues.length} unresolved issue{turn.deep.issues.length === 1 ? '' : 's'}</span>}
              {turn.deep.verdict === 'inconclusive' && <span>Verification inconclusive</span>}
            </button>
          )}
        </div>
      )}
      {turn.deep && showDeep && (
        <div class="fabry-deep-strip">
          <FabryMarkdown text={turn.deep.criticText || '(no critic output)'} />
        </div>
      )}
    </div>
  );
}
