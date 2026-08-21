import { h } from 'preact';
import { missionStatus, stepState, type Progress } from '../../training/progress.js';
import type { Track } from '../../training/track.js';
import css from '../Academy.module.css';

export default function MissionList(
  { track, progress, activeId, onSelect }:
  { track: Track; progress: Progress; activeId?: string | null; onSelect: (id: string) => void },
) {
  return (
    <nav class={css.list} aria-label="Missions">
      <h2 class={css.listTitle}>{track.title}</h2>
      {track.missions.map((m) => {
        const status = missionStatus(track, progress, m.id);
        const done = m.steps.filter((s) => ['passed', 'self'].includes(stepState(progress, m.id, s.id) as string)).length;
        return (
          <button
            key={m.id}
            type="button"
            class={css.mission + (m.id === activeId ? ` ${css.missionActive}` : '')}
            disabled={status === 'locked'}
            onClick={() => status !== 'locked' && onSelect(m.id)}
          >
            <span class={css.ring} data-status={status}>
              {status === 'done' ? '✓' : `${done}/${m.steps.length}`}
            </span>
            <span>
              <b>{m.title}</b>
              <i>{status === 'locked' ? 'locked' : status === 'done' ? 'done' : 'in progress'}</i>
            </span>
          </button>
        );
      })}
    </nav>
  );
}
