import { h } from 'preact';
import { useState } from 'preact/hooks';
import FabryMarkdown from '../../ui/fabry/FabryMarkdown.jsx';
import { toolLabel } from '../../agent/agentStream.js';
import { sendFeedback, openChat } from '../chat.js';
import * as store from '../store.js';

// One assistant turn: collapsible reasoning, ordered tool chips, markdown body,
// feedback + copy footer. `threadIdx` is this turn's index in store.thread;
// sendFeedback maps it to the server's feedback turn_index (see
// serverMessageIndex in thread.js).
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
      <FabryMarkdown text={turn.text} streaming={streaming} />
      {turn.interrupted && (
        <div class="fabry-interrupted">
          Stopped before the reply finished.{' '}
          <button type="button" class="fabry-refresh" onClick={() => openChat(store.activeChatId.value)}>Refresh from server</button>
        </div>
      )}
      {!streaming && !turn.interrupted && (
        <div class="fabry-turn-foot">
          <button type="button" class={'fabry-fb-up' + (turn.feedback === true ? ' on' : '')} title="Good answer" onClick={() => sendFeedback(threadIdx, true)}>{'\u{1F44D}'}</button>
          <button type="button" class={'fabry-fb-down' + (turn.feedback === false ? ' on' : '')} title="Bad answer" onClick={() => sendFeedback(threadIdx, false)}>{'\u{1F44E}'}</button>
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
