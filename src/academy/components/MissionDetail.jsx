import { h } from 'preact';
import { stepState } from '../../training/progress.js';
import FabryMarkdown from '../../ui/fabry/FabryMarkdown.jsx';
import css from '../Academy.module.css';

const CHIP = { visit: 'url', api: 'api', self: 'self' };

export default function MissionDetail({ mission, progress, onAttest }) {
  return (
    <section class={css.detail}>
      <h2 class={css.detailTitle}>{mission.title}</h2>
      <p class={css.blurb}>{mission.blurb}</p>
      {mission.steps.map((s) => {
        const state = stepState(progress, mission.id, s.id);
        return (
          <article key={s.id} class={css.step} data-state={state || 'open'}>
            <span class={css.tick}>{state ? '✓' : '○'}</span>
            <div class={css.stepBody}>
              <b>{s.hint}</b>
              <FabryMarkdown text={s.teach} />
              {s.kind === 'self' && !state && (
                <button type="button" class={css.attest} onClick={() => onAttest(mission.id, s.id)}>
                  I{'’'}ve done this
                </button>
              )}
            </div>
            <span class={css.chip} data-kind={s.kind}>{CHIP[s.kind]}</span>
          </article>
        );
      })}
    </section>
  );
}
