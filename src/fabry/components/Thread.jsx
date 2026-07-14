import { h } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import * as store from '../store.js';
import { sendMessage } from '../chat.js';
import { STARTERS } from '../starters.js';
import AssistantTurn from './AssistantTurn.jsx';
import FabryMark from '../../ui/FabryMark.jsx';

function UserTurn({ turn }) {
  if (turn.chip) return <div class="fabry-turn-chip">{turn.text}</div>;
  return (
    <div class="fabry-turn-user">
      {turn.images.map((img, idx) => <img key={idx} class="fabry-turn-img" src={`data:${img.media_type};base64,${img.data}`} alt="attachment" />)}
      <div class="fabry-turn-user-text">{turn.text}</div>
    </div>
  );
}

export default function Thread() {
  const ref = useRef(null);
  const turns = store.thread.value;
  const live = store.liveTurn.value;

  // Pin-to-bottom: only auto-scroll when the user hasn't scrolled up. The
  // scroll region is the whole main pane (.fabry-main), not the thread itself.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const scroller = el.closest('.fabry-main') || el;
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
    if (nearBottom) scroller.scrollTop = scroller.scrollHeight;
  }, [turns, live && live.text, live && live.reasoning]);

  if (!store.activeChatId.value && turns.length === 0) {
    return (
      <div class="fabry-greeting">
        <div class="fabry-greeting-mark"><FabryMark /></div>
        <div class="fabry-greeting-title">Ask Mr. Fabry about this organization</div>
        <div class="fabry-greeting-sub">Queues, extensions, documents, data {'—'} Fabry investigates with its own tools.</div>
        <div class="fabry-starters">
          {STARTERS.map((s) => (
            <button type="button" key={s.label} class="fabry-starter" title={s.prompt} onClick={() => sendMessage(s.prompt)}>
              <b>{s.label}</b>
              <span>{s.desc}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div class="fabry-thread" ref={ref}>
      {store.threadLoading.value && <div class="fabry-thread-loading">Loading conversation{'…'}</div>}
      {turns.map((t, i) => {
        if (t.role !== 'assistant') return <UserTurn key={i} turn={t} />;
        return <AssistantTurn key={i} turn={t} threadIdx={i} streaming={false} />;
      })}
      {store.streaming.value && store.deepPhase.value && (
        <div class="fabry-deep-phase">
          {store.deepPhase.value.phase === 'verify'
            ? 'Verifying in a fresh chat…'
            : `Refining ${store.deepPhase.value.round}/2…`}
        </div>
      )}
      {store.streaming.value && live && (
        <AssistantTurn key="live" turn={{ text: live.text, reasoning: live.reasoning, tools: live.tools || [], feedback: null, interrupted: false }} threadIdx={turns.length} streaming />
      )}
    </div>
  );
}
