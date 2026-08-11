import { h } from 'preact';
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
function ErrorStrip() {
  const message = store.error.value;
  if (!message) return null;
  return (
    <div class={css.errorStrip} role="alert">
      <span>{message}</span>
      <button
        type="button"
        class={css.errorDismiss}
        aria-label="Dismiss"
        onClick={() => { store.error.value = null; }}
      >
        {'×'}
      </button>
    </div>
  );
}

export default function AcademyApp({ connected }) {
  const progress = store.progress.value;
  // The not-connected branch renders the strip too — initAcademy's "open the
  // Academy from the popup" message is set on exactly this path, so leaving it
  // out is what made that message unreachable.
  if (!connected) {
    return (
      <div class={css.root}>
        <div class={css.empty}>
          <ErrorStrip />
          <p>Not connected to Rossum.</p>
        </div>
      </div>
    );
  }

  if (!progress) {
    return (
      <div class={css.root}>
        <div class={css.empty}>
          <ErrorStrip />
          <h1>{TRACK.title}</h1>
          <p>{TRACK.missions.length} missions. Your progress is checked against your org, and nothing is ever written to it.</p>
          <button type="button" class={css.primary} onClick={() => store.startTrack()}>Start the track</button>
          <TrainerPanel />
        </div>
      </div>
    );
  }

  const mission = TRACK.missions.find((m) => m.id === store.activeMissionId.value) || TRACK.missions[0];
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
          <b>Level {levelFor(xp)} {'·'} {xp} XP</b>
          <span>{'★'} {badges(TRACK, progress).length}/{TRACK.missions.length}</span>
          <button type="button" class={css.ghost} onClick={() => store.restartTrack()}>Restart track</button>
        </header>
        <MissionDetail mission={mission} progress={progress} onAttest={store.attestStep} />
        {showReceipt && <ReceiptPanel />}
        <TrainerPanel />
      </main>
    </div>
  );
}
