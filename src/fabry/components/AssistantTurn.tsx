import { h } from 'preact';
import { useState } from 'preact/hooks';
import FabryMarkdown from '../../ui/fabry/FabryMarkdown.jsx';
import FabryNotice from '../../ui/fabry/FabryNotice.jsx';
import FabryQuestions from './FabryQuestions.jsx';
import { toolLabel, fallbackNotice } from '../../agent/agentStream.js';
import { openChat, answerQuestions } from '../chat.js';
import * as store from '../store.js';
import type { AssistantTurnView } from '../thread.js';

// One assistant turn: collapsible reasoning, ordered tool chips, then either the
// markdown body, a clarifying-question form (turn.questions), or a fallback
// notice — never blank. Footer = Copy + the deep-verify verdict chip (the 👍/👎
// feedback UI is hidden pending a backend feedback-id fix; see the footer). The
// `threadIdx` prop is retained for the dormant feedback path.
export default function AssistantTurn({
  turn,
  threadIdx,
  streaming,
}: {
  turn: AssistantTurnView;
  threadIdx?: number;
  streaming?: boolean;
}) {
  const [showThinking, setShowThinking] = useState(false);
  const [showDeep, setShowDeep] = useState(false);
  const open = streaming || showThinking; // stream visibly, collapse when done
  return (
    <div class={'fabry-turn-assistant' + (streaming ? ' fabry-turn-live' : '')}>
      {turn.reasoning ? (
        <div class="fabry-thinking">
          <button
            type="button"
            class="fabry-thinking-toggle"
            onClick={() => setShowThinking(!showThinking)}
          >
            {open ? 'Thinking ▾' : 'Thinking ▸'}
          </button>
          {open && <pre class="fabry-thinking-body">{turn.reasoning}</pre>}
        </div>
      ) : null}
      {turn.tools && turn.tools.length ? (
        <div class="fabry-tools">
          {turn.tools.map((t: any, idx) => (
            <span key={idx} class="fabry-tool-chip" title={t}>
              {toolLabel(t)}
            </span>
          ))}
        </div>
      ) : null}
      {streaming || turn.text ? <FabryMarkdown text={turn.text} streaming={streaming} /> : null}
      {!streaming && turn.questions ? (
        <FabryQuestions questions={turn.questions} onSubmit={(a) => answerQuestions(a)} />
      ) : null}
      {!streaming ? <FabryNotice notice={fallbackNotice(turn)} /> : null}
      {turn.interrupted && (
        <div class="fabry-interrupted">
          Stopped before the reply finished.{' '}
          <button
            type="button"
            class="fabry-refresh"
            onClick={() => openChat(store.activeChatId.value as string)}
          >
            Refresh from server
          </button>
        </div>
      )}
      {!streaming && !turn.interrupted && !turn.questions && !fallbackNotice(turn) && (
        <div class="fabry-turn-foot">
          {/* No 👍/👎. PUT /feedback's turn_index addresses the RAW stored history,
              but GET /chats drops text-less tool-only steps, so a thread index
              mis-targets feedback on any tool-using turn (live-confirmed
              2026-07-13; spec §9b). The plumbing was removed 2026-08-20 rather
              than kept dormant — restoring it means restoring sendFeedback,
              agentApi.submitFeedback and thread.serverMessageIndex from git, and
              it should wait for a stable per-message feedback id anyway. */}
          <button
            type="button"
            class="fabry-copy"
            title="Copy reply"
            onClick={() => navigator.clipboard?.writeText(turn.text)}
          >
            Copy
          </button>
          {turn.deep && (
            <button
              type="button"
              class={'fabry-deep-chip ' + turn.deep.verdict}
              onClick={() => setShowDeep(!showDeep)}
            >
              {turn.deep.verdict === 'pass' && <span>{'✓'} Independently verified</span>}
              {turn.deep.verdict === 'fail' && (
                <span>
                  {'⚠'} {turn.deep.issues.length} unresolved issue
                  {turn.deep.issues.length === 1 ? '' : 's'}
                </span>
              )}
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
