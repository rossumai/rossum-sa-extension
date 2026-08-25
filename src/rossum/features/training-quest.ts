// The bottom-right quest card. Injects nothing and fetches nothing until the
// gate is unlocked AND a track has been started, so a locked profile pays for
// one storage read and one listener.
//
// Verification is URL + read-only API state — never click-tracking, and the
// extension never writes to the org.
import { TRACK } from '../../training/track.js';
import {
  markStep, startMission, missionStatus, stepState,
  xpFor, levelFor, badges, isMissionComplete, migrate,
} from '../../training/progress.js';
import {
  CHECKS, evaluateVisit, evaluateApi, signatureFor, collectResponses,
} from '../../training/steps.js';
import { readProgress, writeProgress, PROGRESS_KEY } from '../../training/storage.js';
import { isUnlocked, onUnlockChange } from '../../training/gate.js';
import { fetchRossumApiFresh } from '../api.js';
import { showTether, hideTether } from './training-tether.js';
import { track } from '../../usage/track.js';
import type { Track, Mission, TrackStep } from '../../training/track.js';
import type { Progress } from '../../training/progress.js';

// Everything the loop reads from the outside world, all injectable so a test can drive it
// without a page, a clock, or the network.
type QuestDeps = {
  getLocation?: () => { pathname: string; search?: string };
  get?: (path: string, opts?: any) => Promise<any>;
  now?: () => number;
  intervalMs?: number;
};

export const CARD_ID = 'rossum-sa-extension-training-card';
const STYLE_ID = 'rossum-sa-extension-training-style';
const DISMISS_KEY = 'rossum-sa-extension-training-dismissed';
const API_MIN_INTERVAL_MS = 20_000;

export function nextStep(track: Track, progress: Progress) {
  for (const m of track.missions) {
    if (missionStatus(track, progress, m.id) !== 'active') continue;
    for (const s of m.steps) {
      const st = stepState(progress, m.id, s.id);
      if (st !== 'passed' && st !== 'self') return { mission: m, step: s };
    }
  }
  return null;
}

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
#${CARD_ID} {
  position: fixed; bottom: 16px; right: 16px; z-index: 2147483645; width: 268px;
  box-sizing: border-box; padding: 12px 13px; border-radius: 11px; color: #fff;
  background: linear-gradient(150deg, #2f4fa8, #4270db 55%, #5b8af0);
  box-shadow: 0 8px 26px rgba(20, 30, 60, 0.32);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 12px; line-height: 1.4;
}
#${CARD_ID} .rossum-sa-extension-tq-head { display: flex; align-items: center; gap: 6px;
  font-size: 10px; font-weight: 700; letter-spacing: .04em; opacity: .9; }
#${CARD_ID} .rossum-sa-extension-tq-close { margin-left: auto; background: none; border: 0;
  color: #fff; font-size: 16px; line-height: 1; cursor: pointer; opacity: .8; padding: 0 2px; }
#${CARD_ID} .rossum-sa-extension-tq-mission { font-weight: 800; margin: 6px 0 2px; }
#${CARD_ID} .rossum-sa-extension-tq-bar { height: 5px; border-radius: 3px; margin: 8px 0 4px;
  background: rgba(255,255,255,.26); overflow: hidden; }
#${CARD_ID} .rossum-sa-extension-tq-bar i { display: block; height: 100%; background: #9be8c4; }
#${CARD_ID} ul { list-style: none; margin: 6px 0 0; padding: 0; }
#${CARD_ID} li { display: flex; gap: 6px; margin-bottom: 4px; font-size: 11px; }
#${CARD_ID} li.rossum-sa-extension-tq-done { opacity: .65; }
#${CARD_ID} li.rossum-sa-extension-tq-now { font-weight: 700; }
#${CARD_ID} .rossum-sa-extension-tq-foot { display: flex; justify-content: space-between;
  font-size: 10px; font-weight: 700; margin-top: 8px; opacity: .92; }`;
  (document.head || document.documentElement)?.appendChild(style);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string | null, text?: string | null,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text; // never innerHTML
  return n;
}

function renderCard(progress: Progress, active: { mission: Mission; step: TrackStep } | null) {
  document.getElementById(CARD_ID)?.remove();
  if (!active) return;
  injectStyle();
  const card = el('div');
  card.id = CARD_ID;

  const head = el('div', 'rossum-sa-extension-tq-head');
  head.appendChild(el('span', null, '✦ TRAINING'));
  const close = el('button', 'rossum-sa-extension-tq-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss for this session');
  close.addEventListener('click', () => {
    try { window.sessionStorage.setItem(DISMISS_KEY, '1'); } catch { /* ignore */ }
    hideTether();
    card.remove();
  });
  head.appendChild(close);
  card.appendChild(head);

  card.appendChild(el('div', 'rossum-sa-extension-tq-mission', active.mission.title));

  const done = active.mission.steps.filter(
    (s) => ['passed', 'self'].includes(stepState(progress, active.mission.id, s.id) as string)).length;
  const bar = el('div', 'rossum-sa-extension-tq-bar');
  const fill = el('i');
  fill.style.width = `${Math.round((done / active.mission.steps.length) * 100)}%`;
  bar.appendChild(fill);
  card.appendChild(bar);

  const list = el('ul');
  for (const s of active.mission.steps) {
    const st = stepState(progress, active.mission.id, s.id);
    const li = el('li', st ? 'rossum-sa-extension-tq-done'
      : s.id === active.step.id ? 'rossum-sa-extension-tq-now' : null);
    li.appendChild(el('span', null, st ? '✓' : '○'));
    li.appendChild(el('span', null, s.hint));
    list.appendChild(li);
  }
  card.appendChild(list);

  const foot = el('div', 'rossum-sa-extension-tq-foot');
  const xp = xpFor(TRACK, progress);
  foot.appendChild(el('span', null, `${xp} XP · Level ${levelFor(xp)}`));
  foot.appendChild(el('span', null, `★ ${badges(TRACK, progress).length}/${TRACK.missions.length}`));
  card.appendChild(foot);

  document.body.appendChild(card);
}

let started = false;            // a loop is RUNNING
// DEFENSIVE, and honestly labelled as such: `started` was checked and set on
// two ADJACENT synchronous lines after a single `await isUnlocked()`, which no
// interleaving can split — probed, two concurrent inits always produced one
// loop. So this sentinel fixes no live bug. What it buys is that the guarantee
// stops depending on there being exactly one await before the commit point: add
// a second one above `started = true` and the old shape silently admits two
// loops, each with its own interval and only one handle stored. Set
// SYNCHRONOUSLY at function entry, released at the commit point (see start()).
let starting = false;
let gateListenerOn = false;     // never stack a second unlock listener
let progressListenerOn = false; // never stack a second progress listener
let intervalHandle: ReturnType<typeof setInterval> | null = null;
// Bumped by every stop(). A tick that was awaiting the network or a storage
// write when the loop died resumes with a stale generation and must not touch
// the DOM or clear a SUCCESSOR loop's interval — same pattern as
// training-tether.js's `generation`.
let generation = 0;
// Set by the running loop so the progress listener can hand it a fresh record;
// null whenever no loop is running (checked via `started`, which stop() clears).
let onExternalProgress: ((next: Progress | null) => void) | null = null;

// `trainingProgress` is written by TWO surfaces — this loop and the Academy —
// and this one is the only one that can be running when the other writes. Two
// distinct failures follow from not watching it, and one listener fixes both:
//
//  (a) START. init() runs once, at content-script injection. The intended first
//      run is: unlock in the popup (no reload), open the Academy in a Console
//      tab, click "Start the track", switch back. By then init() has already
//      returned at the "no track yet" bail-out, having registered nothing — so
//      the card never appears, and since `visit`/`api` steps can ONLY be marked
//      here the trainee sits at 0/4 with no card and no explanation.
//  (b) STALENESS. The loop holds progress in a closure. Every mission but m3
//      ends on a `self` step, so after an Academy attestation nextStep() keeps
//      returning the step already attested and the card is stuck until a page
//      reload; and "Restart track" clears the record only for the next write to
//      resurrect all of it.
//
// This listener also fires for THIS loop's own writes. That is deliberately a
// cheap no-op: it assigns the record it just read back into the closure and
// returns — no fetch, no tick, no write, so no cascade.
function watchProgress(deps: QuestDeps) {
  if (progressListenerOn) return;
  progressListenerOn = true;
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== 'local' || !changes[PROGRESS_KEY]) return;
    const record = (changes[PROGRESS_KEY].newValue as Record<string, any> | undefined)?.[window.location.origin] ?? null;
    if (!started) {
      // A track appeared while nothing was running: start now. init() re-checks
      // the gate and its synchronous `starting` sentinel, so however many
      // events land in a row this can never stack a loop.
      if (record) init(deps);
      return;
    }
    onExternalProgress?.(record ? migrate(TRACK, record) as Progress : null);
  });
}

export async function init(deps: QuestDeps = {}) {
  // SYNCHRONOUS, before the first await — see the `starting` declaration.
  // `start()` releases the claim itself the moment it commits (`started =
  // true`); the finally only covers the paths that never got that far (locked,
  // or no track yet).
  if (started || starting) return;
  starting = true;
  try {
    await start(deps);
  } finally {
    starting = false;
  }
}

async function start(deps: QuestDeps) {
  const {
    getLocation = () => window.location,
    // MUST forward the options: the call sites pass the check object as the
    // second argument, and one check (collectionAdded) carries method/body/auth
    // on it. Dropping `opts` here sends that check as a Token-authed GET to a
    // Bearer POST endpoint — it fails silently in production while every test
    // that injects its own `get` still passes.
    get = (p: string, opts?: any) => fetchRossumApiFresh(p, opts),
    now = () => Date.now(),
    intervalMs = 1500,
  } = deps;

  if (!(await isUnlocked())) {
    // One listener for the lifetime of the page. Without the guard, a trainee
    // toggling the gate stacks a listener per lock/unlock cycle, and each one
    // re-enters init.
    if (!gateListenerOn) {
      gateListenerOn = true;
      onUnlockChange((on) => { if (on) init(deps); });
    }
    return;
  }
  // BEFORE the "no track yet" bail-out below: that is precisely the state the
  // intended first run starts in, and nothing else would ever notice the track
  // being started from the Academy afterwards.
  watchProgress(deps);
  started = true;
  // Hand mutual exclusion over from `starting` to `started` HERE, at the commit
  // point — not in init()'s finally. Everything below can stop() (a restart
  // arriving mid-fetch does exactly that), and a successor init must be able to
  // start immediately, while this call's own `start()` is still unwinding. A
  // sentinel held until the end would silently swallow that successor and leave
  // the trainee with no loop at all.
  starting = false;

  const origin = window.location.origin;
  let progress = await readProgress(origin, TRACK) as Progress;
  if (!progress) { started = false; return; } // the track is started from the Academy
  let lastApiAt = 0;
  let onFocus: (() => void) | null = null; // this init() call's own focus handler, so stop() removes exactly it

  // This loop's identity. Everything below that touches module-level state or
  // the DOM after an await checks it first: a tick suspended on the network or
  // a storage write when the trainee restarts the track would otherwise resume
  // past stop(), re-render a frozen card that no interval will ever refresh,
  // and — worse — clear a SUCCESSOR loop's interval through the module-level
  // `intervalHandle` it still closes over.
  const myGeneration = ++generation;
  const isCurrent = () => myGeneration === generation;

  // Every write is read-modify-WRITE against storage, never a blind write of
  // the closure. The Academy owns the SAME per-origin record, and writes here
  // replace it wholesale, so a `self` attestation landing between this loop's
  // read and its write would simply vanish. The listener above closes the
  // common case; this closes the window the listener cannot (an event that has
  // not been delivered yet by the time a tick computes its next value). Writes
  // only happen on a transition, so the extra read costs one call per STEP,
  // not per tick.
  //
  // Returns false when the record is gone — "Restart track" — because writing
  // then would resurrect the progress the trainee just cleared.
  const save = async (mutate: (current: Progress) => Progress) => {
    const current = await readProgress(origin, TRACK);
    if (!current) return false;
    progress = mutate(current);
    await writeProgress(origin, progress);
    return true;
  };
  // Wraps a passing-step save with the mission-complete usage event. Guarded
  // explicitly on a before/after comparison (not just relying on markStep's
  // monotonicity) so a mission that finishes on a `visit`/`api` step — the
  // ONLY transitions this loop ever drives — is counted exactly once, the
  // same way `sa_training_mission_complete` already counts a mission that
  // finishes on a `self` step from the Academy's attestStep. The Academy can
  // never observe this transition (it only marks `self` steps) and this loop
  // can never observe the Academy's (it only marks `visit`/`api` steps), so
  // the two call sites cannot double-fire for the same completing step.
  const markStepAndTrack = async (missionId: string, stepId: string, state: any) => {
    let wasComplete = false;
    const ok = await save((current) => {
      wasComplete = isMissionComplete(TRACK, current, missionId);
      return markStep(current, missionId, stepId, state, now());
    });
    if (ok && !wasComplete && isMissionComplete(TRACK, progress, missionId)) {
      track('sa_training_mission_complete');
    }
    return ok;
  };

  function stop() {
    if (!isCurrent()) return; // a successor loop owns the module-level state now
    generation++;             // invalidate any tick of THIS loop still in flight
    if (intervalHandle !== null) { clearInterval(intervalHandle); intervalHandle = null; }
    if (onFocus) { window.removeEventListener('focus', onFocus); onFocus = null; }
    started = false;
    onExternalProgress = null;
    hideTether();
  }

  // The progress listener's hook into this loop. A null record means the
  // trainee restarted the track: tear the card down and stop, rather than
  // ticking on — and leave `started` false so the listener starts a fresh loop
  // if the track is started again.
  onExternalProgress = (next: Progress | null) => {
    if (!next) { document.getElementById(CARD_ID)?.remove(); stop(); return; }
    progress = next;
  };

  async function tick() {
    if (!isCurrent()) return; // a queued tick from a loop that has already died
    // A session dismissal silences the feature completely: no render, no
    // pointer, and — the part that matters — no further network calls. The
    // trainee asked to be left alone; polling their org invisibly is not that.
    let dismissed = false;
    try { dismissed = !!window.sessionStorage.getItem(DISMISS_KEY); } catch { /* ignore */ }
    if (dismissed) { renderCard(progress, null); stop(); return; }

    let active = nextStep(TRACK, progress);
    if (!active) { renderCard(progress, null); hideTether(); return; }

    if (progress.missions[active.mission.id]?.baseline == null) {
      const checks = active.mission.steps.filter((s) => s.kind === 'api').map((s) => CHECKS[s.check!]);
      const baseline: Record<string, unknown> = {};
      let captured = true;
      for (const c of checks) {
        try {
          baseline[c.id] = signatureFor(c.id, await collectResponses(c, get));
        } catch { captured = false; }
      }
      // Persist ONLY a complete baseline. A missing entry is permanent —
      // evaluateApi returns false forever for a check with no baseline — so
      // saving a half-captured snapshot would let one transient network blip
      // at mission start silently strand that step for the whole mission.
      // Leaving it uncaptured simply retries on the next tick.
      if (!captured || !isCurrent()) return; // the fetches above are awaits
      const missionId = active.mission.id;
      if (!(await save((current) => startMission(current, missionId, baseline, now())))) {
        document.getElementById(CARD_ID)?.remove();
        stop();
        return;
      }
      if (!isCurrent()) return;
      active = nextStep(TRACK, progress);
      if (!active) { renderCard(progress, null); hideTether(); return; }
    }

    if (active.step.kind === 'visit' && evaluateVisit(active.step, getLocation())) {
      await markStepAndTrack(active.mission.id, active.step.id, 'passed');
      active = nextStep(TRACK, progress);
    } else if (active.step.kind === 'api' && now() - lastApiAt > API_MIN_INTERVAL_MS) {
      lastApiAt = now();
      const c = CHECKS[active.step.check!];
      try {
        const sig = signatureFor(c.id, await collectResponses(c, get));
        if (evaluateApi(c, sig, progress.missions[active.mission.id]?.baseline?.[c.id])) {
          await markStepAndTrack(active.mission.id, active.step.id, 'passed');
          active = nextStep(TRACK, progress);
        }
      } catch { /* transient — retry next tick */ }
    }

    // The single DOM write of a tick, and the last thing it does. Guarded
    // because everything between here and the top of tick() may have awaited:
    // rendering after stop() leaves a frozen card that no interval will ever
    // refresh — the exact "silently wrong, forever" failure this feature keeps
    // producing.
    if (!isCurrent()) return;
    renderCard(progress, active);
    if (active) showTether(active.step.anchor, { cardEl: document.getElementById(CARD_ID) }); else hideTether();
  }

  await tick();
  // That first tick may have called stop() (a session dismissal, or the record
  // disappearing under us). Installing an interval and a focus listener AFTER
  // stop() has just torn them down is how a "silenced" card keeps a live timer.
  // `isCurrent()` as well as `started`: a successor loop may have taken over,
  // in which case `started` is true again but belongs to someone else.
  if (!started || !isCurrent()) return;
  if (intervalMs > 0) intervalHandle = setInterval(tick, intervalMs);
  onFocus = () => { lastApiAt = 0; tick(); };
  window.addEventListener('focus', onFocus);
}
