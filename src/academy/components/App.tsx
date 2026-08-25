import { h } from 'preact';
import { useState } from 'preact/hooks';
import * as store from '../store.js';
import { TRACK } from '../../training/track.js';
import { xpFor, levelFor, badges, isTrackComplete } from '../../training/progress.js';
import MissionList from './MissionList.jsx';
import MissionDetail from './MissionDetail.jsx';
import ReceiptPanel from './ReceiptPanel.jsx';
import TrainerPanel from './TrainerPanel.jsx';
import css from '../Academy.module.css';

// store.error is set by startTrack/attestStep/initAcademy. Until this existed
// it was written and read NOWHERE: a failed write made "I've done this" simply
// do nothing, with no way for the trainee to tell that from a slow save.
// `inset`: the two `.entry`-branch call sites (not-connected, no-progress hero)
// pass this — `.entry` carries no padding of its own (see Academy.module.css),
// so the strip needs its own horizontal/top inset there. The with-progress
// `.main` call site omits it and keeps relying on `.main`'s own padding, which
// is unaffected by this change.
function ErrorStrip({ inset }: { inset?: boolean } = {}) {
  const message = store.error.value;
  if (!message) return null;
  return (
    <div class={inset ? `${css.errorStrip} ${css.entryError}` : css.errorStrip} role="alert">
      <span>{message}</span>
      <button
        type="button"
        class={css.errorDismiss}
        aria-label="Dismiss"
        onClick={() => {
          store.error.value = null;
        }}
      >
        {'×'}
      </button>
    </div>
  );
}

export default function AcademyApp({ connected }: { connected: boolean | null }) {
  // Declared unconditionally, before either early return, so hook order never
  // depends on `connected`/`progress` — both of which can change across
  // re-renders of the same mounted instance.
  const [showTrainer, setShowTrainer] = useState(false);
  const progress = store.progress.value;
  // The not-connected branch renders the strip too — initAcademy's "open the
  // Academy from the popup" message is set on exactly this path, so leaving it
  // out is what made that message unreachable. Uses the shared app-root/empty-state
  // convention (console.css) like the no-progress branch, NOT css.root.
  if (!connected) {
    return (
      <div class="app-root">
        <div class={css.entry}>
          <ErrorStrip inset />
          <div class="empty-state">
            <div class={`empty-state-card ${css.entryCard}`}>
              <div class="empty-state-title">Not connected</div>
              <p class="empty-state-body">The Academy tracks your progress in your Rossum org.</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!progress) {
    // "Aurora" landing hero — owner-approved design, browser-mockup review.
    // Two columns: the pitch + CTA on the left, a preview of every mission's
    // payoff on the right, over a slow-drifting blurred-color background.
    // TrainerPanel is reachable but not shown by default — a trainer
    // validating a colleague's receipt is a secondary path off this screen,
    // not the hero.
    return (
      <div class="app-root">
        <div class={css.entry}>
          <ErrorStrip inset />
          <div class={css.hero}>
            <div class={css.heroBg} aria-hidden="true">
              <span class={css.heroBlobA} />
              <span class={css.heroBlobB} />
              <span class={css.heroGrain} />
            </div>
            <div class={css.heroInner}>
              <div class={css.heroLeft}>
                <p class={css.eyebrow}>Hands-on onboarding {'·'} 5 missions</p>
                <h1 class={css.heroTitle}>{TRACK.title}</h1>
                <p class={css.lede}>
                  Learn Rossum by building in it {'—'} not by reading about it.
                </p>
                <p class={css.heroBody}>
                  Five short missions take you from your first document through to working
                  automation: schema fields, extensions, business rules and master-data matching.
                  You do the real work in a real organization, so what you learn here transfers
                  straight to a customer project.
                </p>
                <button
                  type="button"
                  class={`btn btn-primary ${css.heroCta}`}
                  onClick={() => store.startTrack()}
                >
                  Start the track
                </button>
                <div class={css.heroFooter}>
                  <p class={css.heroFooterText}>
                    Work at your own pace {'—'} pick up where you left off any time.
                  </p>
                  <button
                    type="button"
                    class={css.trainerToggle}
                    aria-expanded={showTrainer}
                    onClick={() => setShowTrainer((v) => !v)}
                  >
                    Check a colleague{'’'}s receipt
                  </button>
                </div>
              </div>
              <aside class={css.heroCard}>
                <h2 class={css.heroCardHeading}>What you will be able to do</h2>
                <ul class={css.heroMissions}>
                  {TRACK.missions.map((m, i) => (
                    <li key={m.id} class={css.heroMissionRow} style={{ '--i': i }}>
                      <span class={css.heroMissionNode}>{i + 1}</span>
                      <div class={css.heroMissionText}>
                        <b>{m.title}</b>
                        <p>{m.blurb}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </aside>
            </div>
          </div>
          {showTrainer && (
            <div class={css.trainerWrap}>
              <TrainerPanel />
            </div>
          )}
        </div>
      </div>
    );
  }

  const mission =
    TRACK.missions.find((m) => m.id === store.activeMissionId.value) || TRACK.missions[0];
  const xp = xpFor(TRACK, progress);
  // `|| store.mintNote.value`: a failed mint REVOKES the step it failed on, so
  // the track stops being complete in the same breath — unmounting the panel
  // and taking the explanation with it, right as the trainee clicks the last
  // button of the whole track.
  const showReceipt = isTrackComplete(TRACK, progress) || !!store.mintNote.value;
  return (
    <div class={css.root}>
      <MissionList
        track={TRACK}
        progress={progress}
        activeId={mission.id}
        onSelect={store.setActiveMission}
      />
      <main class={css.main}>
        <ErrorStrip />
        <header class={css.hud}>
          <b>
            Level {levelFor(xp)} {'·'} {xp} XP
          </b>
          <span>
            {'★'} {badges(TRACK, progress).length}/{TRACK.missions.length}
          </span>
          <button type="button" class={css.ghost} onClick={() => store.restartTrack()}>
            Restart track
          </button>
        </header>
        <MissionDetail mission={mission} progress={progress} onAttest={store.attestStep} />
        {showReceipt && <ReceiptPanel />}
        <TrainerPanel />
      </main>
    </div>
  );
}
