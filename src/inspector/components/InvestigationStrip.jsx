import { h } from 'preact';
import * as store from '../store.js';

function stageState(stage, self) {
  const order = ['gathering', 'attributing', 'synthesizing', 'complete'];
  const cur = stage === 'agent-offline' ? 'complete' : stage;
  const a = order.indexOf(self); const b = order.indexOf(cur);
  if (b > a) return 'done';
  if (b === a) return 'run';
  return 'pend';
}

function Pill({ state, label, note }) {
  return (
    <span class={`inspector-inv-st ${state}`}>
      <span class="inspector-inv-ic">{state === 'done' ? '✓' : ''}</span> {label}{note ? <span class="inspector-inv-note"> {note}</span> : null}
    </span>
  );
}

// The visible investigation lifecycle (spec §4.3): Gather → Attribute → Synthesize.
export default function InvestigationStrip() {
  const inv = store.investigation.value;
  if (inv.stage === 'idle') return null;
  const attrs = Object.values(store.attributions.value);
  const ai = attrs.filter((a) => a.source === 'ai');
  const aiDone = ai.filter((a) => a.status !== 'loading').length;
  const loadingPhase = ai.find((a) => a.status === 'loading' && a.phase)?.phase;
  const activity = inv.activity || loadingPhase || '';

  if (inv.stage === 'complete' || inv.stage === 'agent-offline') {
    const unavailable = (store.evidence.value?.items || []).filter((i) => i.reliability === 'unavailable').length;
    return (
      <div class="inspector-inv">
        <span class="inspector-inv-st done"><span class="inspector-inv-ic">{'✓'}</span> Investigation {inv.stage === 'agent-offline' ? 'finished (AI offline)' : 'complete'}</span>
        <span class="inspector-inv-act">
          {inv.sourcesTotal} sources {'·'} {ai.length} attribution{ai.length === 1 ? '' : 's'}{unavailable ? ` · ${unavailable} unavailable` : ''}
        </span>
      </div>
    );
  }
  return (
    <div class="inspector-inv">
      <Pill state={stageState(inv.stage, 'gathering')} label="Gather" note={`${inv.sourcesDone}/${inv.sourcesTotal}`} />
      <span class="inspector-inv-sep">{'›'}</span>
      <Pill state={stageState(inv.stage, 'attributing')} label="Attribute" note={ai.length ? `${aiDone} of ${ai.length}` : ''} />
      <span class="inspector-inv-sep">{'›'}</span>
      <Pill state={stageState(inv.stage, 'synthesizing')} label="Synthesize" />
      {activity ? <span class="inspector-inv-act">{activity}{'…'}</span> : null}
    </div>
  );
}
