// PURE. No chrome APIs, no DOM, no network. Owns the shape of a trainee's
// progress for ONE org, plus the reward math and the linear unlock rule.
// Step states: 'passed' (verified), 'self' (attested), 'skipped' (no credit).

import type { Track, TrackStep } from './track.js';

/** 'passed' = verified, 'self' = attested, 'skipped' = no credit. */
export type StepState = 'passed' | 'self' | 'skipped';

export type StepRecord = { state: StepState; at: number };

export type MissionProgress = {
  startedAt: number;
  /** The mission-start snapshot every `api` check measures its delta against. */
  baseline: Record<string, unknown> | null;
  steps: Record<string, StepRecord>;
};

export type Progress = {
  trackId: string;
  trackVersion: number;
  startedAt: number;
  missions: Record<string, MissionProgress>;
  receipt?: Record<string, unknown> | null;
};

export const STEP_XP: Record<TrackStep['kind'], number> = { visit: 10, api: 25, self: 10 };
export const MISSION_BONUS = 50;
// Level N spans LEVELS[N-1] .. LEVELS[N]. Data, not logic — tune freely.
export const LEVELS = [0, 100, 220, 350, 480];

export function emptyProgress(track: Track, at: number): Progress {
  return { trackId: track.id, trackVersion: track.version, startedAt: at, missions: {} };
}

function missionOf(track: Track, missionId: string) {
  return track.missions.find((m) => m.id === missionId) || null;
}

export function stepState(progress: Progress | null | undefined, missionId: string, stepId: string): StepState | null {
  return progress?.missions?.[missionId]?.steps?.[stepId]?.state ?? null;
}

export function startMission(progress: Progress, missionId: string, baseline: MissionProgress['baseline'], at: number): Progress {
  const existing = progress.missions[missionId];
  if (existing && existing.baseline != null) return progress; // captured exactly once
  return {
    ...progress,
    missions: {
      ...progress.missions,
      [missionId]: {
        startedAt: existing?.startedAt ?? at,
        baseline,
        steps: existing?.steps || {},
      },
    },
  };
}

export function markStep(progress: Progress, missionId: string, stepId: string, state: StepState | null, at: number): Progress {
  const mission = progress.missions[missionId] || { startedAt: at, baseline: null, steps: {} };
  const prev = mission.steps[stepId]?.state ?? null;
  // Monotonic: only an explicit null (re-verification) may clear a pass.
  if (prev === 'passed' && state !== null) return progress;
  const steps = { ...mission.steps };
  if (state === null) delete steps[stepId];
  else steps[stepId] = { state, at };
  return { ...progress, missions: { ...progress.missions, [missionId]: { ...mission, steps } } };
}

export function isMissionComplete(track: Track, progress: Progress, missionId: string): boolean {
  const m = missionOf(track, missionId);
  if (!m) return false;
  return m.steps.every((s) => {
    const st = stepState(progress, missionId, s.id);
    return st === 'passed' || st === 'self';
  });
}

export function missionStatus(track: Track, progress: Progress, missionId: string): string {
  if (isMissionComplete(track, progress, missionId)) return 'done';
  const idx = track.missions.findIndex((m) => m.id === missionId);
  if (idx < 0) return 'locked';
  const allPriorDone = track.missions
    .slice(0, idx)
    .every((m) => isMissionComplete(track, progress, m.id));
  return allPriorDone ? 'active' : 'locked';
}

export function xpFor(track: Track, progress: Progress): number {
  let xp = 0;
  for (const m of track.missions) {
    for (const s of m.steps) {
      const st = stepState(progress, m.id, s.id);
      if (st === 'passed' || st === 'self') xp += STEP_XP[s.kind] ?? 0;
    }
    if (isMissionComplete(track, progress, m.id)) xp += MISSION_BONUS;
  }
  return xp;
}

export function levelFor(xp: number): number {
  let level = 1;
  for (let i = 1; i < LEVELS.length; i++) if (xp >= LEVELS[i]) level = i + 1;
  return level;
}

export function badges(track: Track, progress: Progress): string[] {
  return track.missions.filter((m) => isMissionComplete(track, progress, m.id)).map((m) => m.id);
}

// The mission the trainee is actually ON: the first one not yet complete (the
// unlock rule is linear, so that is also the only 'active' one), falling back
// to the last mission when the whole track is done. Reopening the Academy on
// mission 1 after finishing four of them is not a neutral default — it hides
// the work and the next step at the same time.
export function firstActiveMission(track: Track, progress: Progress): string | null {
  const m = track.missions.find((x) => !isMissionComplete(track, progress, x.id));
  return (m || track.missions[track.missions.length - 1])?.id ?? null;
}

export function isTrackComplete(track: Track, progress: Progress): boolean {
  return track.missions.every((m) => isMissionComplete(track, progress, m.id));
}

// Reconcile stored progress against a newer shipped curriculum: keep step ids
// that still exist, drop the rest, and mark any receipt as issued against an
// older track rather than silently revalidating it.
export function migrate(track: Track, progress: Progress | null | undefined): Progress | null | undefined {
  if (!progress) return progress;
  if (progress.trackVersion === track.version && progress.trackId === track.id) return progress;
  const missions: Record<string, MissionProgress> = {};
  for (const m of track.missions) {
    const stored = progress.missions?.[m.id];
    if (!stored) continue;
    const known: Record<string, StepRecord> = {};
    for (const s of m.steps) if (stored.steps?.[s.id]) known[s.id] = stored.steps[s.id];
    missions[m.id] = { ...stored, steps: known };
  }
  const next = { ...progress, trackId: track.id, trackVersion: track.version, missions };
  if (next.receipt) next.receipt = { ...next.receipt, stale: true };
  return next;
}
