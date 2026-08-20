import { signal } from '@preact/signals';
import { TRACK } from '../training/track.js';
import {
  emptyProgress, markStep, isMissionComplete, firstActiveMission,
  type Progress,
} from '../training/progress.js';
import { readProgress, writeProgress, clearProgress } from '../training/storage.js';
import { track } from '../usage/track.js';

export const connected = signal<boolean | null>(null); // null = unprobed
export const progress = signal<Progress | null>(null);
export const activeMissionId = signal<string | null>(null);
export const error = signal<string | null>(null);
export const receiptText = signal<string | null>(null);
// The outcome note from the last mint attempt. It lives HERE, not in
// ReceiptPanel's local state, because a failed mint revokes a step — which
// makes the track incomplete, which unmounts the panel, which would destroy the
// very note explaining why. App.jsx keeps the panel mounted while this is set.
export const mintNote = signal<string | null>(null);
// No `busy` signal: the only spinner is ReceiptPanel's, and it is component-local.

let origin = '';
export function setOrigin(value: string) { origin = value; }
export function getOrigin() { return origin; }

export async function refreshProgress() {
  progress.value = await readProgress(origin, TRACK);
  // Only when UNSET: this also runs from the storage listener on every write
  // the content script makes, and yanking the trainee off the mission they are
  // reading because a background tick advanced another one would be worse than
  // the landing bug this fixes.
  if (progress.value && !activeMissionId.value) {
    activeMissionId.value = firstActiveMission(TRACK, progress.value);
  }
  return progress.value;
}

export async function startTrack(now = Date.now) {
  try {
    const existing = await readProgress(origin, TRACK);
    if (existing) {
      progress.value = existing;
      activeMissionId.value ||= firstActiveMission(TRACK, existing);
      return;
    }
    const fresh = emptyProgress(TRACK, now());
    await writeProgress(origin, fresh);
    progress.value = fresh;
    activeMissionId.value = TRACK.missions[0].id;
    track('sa_training_start');
  } catch (e) {
    error.value = `Couldn't start the training track: ${(e as any)?.message || e}`;
  }
}

export function setActiveMission(id: string | null) { activeMissionId.value = id; }

// Only a `self` step may be attested; everything else is evidence-backed.
export async function attestStep(missionId: string, stepId: string, now = Date.now) {
  const mission = TRACK.missions.find((m) => m.id === missionId);
  const step = mission?.steps.find((s) => s.id === stepId);
  if (!step || step.kind !== 'self' || !progress.value) return;
  try {
    // Deliberately a BLIND write of the signal, not the read-modify-write the
    // content script's loop uses. The asymmetry is the point, and it follows
    // from what each side can afford to lose:
    //
    //   - A `self` attestation is UNRECOVERABLE. Only the trainee can assert
    //     it, and nothing re-derives it, so losing one means silently asking
    //     them to redo a step they already did. That is why the LOOP re-reads
    //     before every write — it is the side that would destroy this.
    //   - A `visit`/`api` pass is CHEAP to lose. The loop re-evaluates it
    //     against an unchanged baseline within ~1.5s and marks it again.
    //
    // So the expensive direction is protected and the cheap one is not. Do not
    // "fix" this into symmetry: making the Academy re-read costs a storage
    // round-trip on every click to protect something that self-heals.
    const next = markStep(progress.value, missionId, stepId, 'self', now());
    await writeProgress(origin, next);
    progress.value = next;
    if (isMissionComplete(TRACK, next, missionId)) track('sa_training_mission_complete');
  } catch (e) {
    error.value = `Couldn't save that step: ${(e as any)?.message || e}`;
  }
}

export async function restartTrack() {
  try {
    await clearProgress(origin);
    progress.value = null;
    activeMissionId.value = null;
    receiptText.value = null;
    mintNote.value = null;
  } catch (e) {
    error.value = `Couldn't restart the training track: ${(e as any)?.message || e}`;
  }
}
