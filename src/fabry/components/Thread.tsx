import { h } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import * as store from '../store.js';
import AssistantTurn from './AssistantTurn.jsx';
import type { Turn } from '../thread.js';

function UserTurn({ turn }: { turn: Turn }) {
  if (turn.chip) return <div class="fabry-turn-chip">{turn.text}</div>;
  return (
    <div class="fabry-turn-user">
      {turn.images.map((img: any, idx: any) => <img key={idx} class="fabry-turn-img" src={`data:${img.media_type};base64,${img.data}`} alt="attachment" />)}
      <div class="fabry-turn-user-text">{turn.text}</div>
    </div>
  );
}

export default function Thread() {
  const ref = useRef<HTMLDivElement | null>(null);
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

  // The empty-new-chat greeting now lives in <Welcome> (App renders it instead of
  // this thread stack while the chat is empty), so Thread only renders turns + live.
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
