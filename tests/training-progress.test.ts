import { describe, it, expect } from 'vitest';
import {
  emptyProgress,
  markStep,
  startMission,
  stepState,
  isMissionComplete,
  missionStatus,
  xpFor,
  levelFor,
  badges,
  isTrackComplete,
  migrate,
} from '../src/training/progress.js';
import { track, mission, step } from './support/training.js';

const TRACK = track({
  id: 't',
  version: 1,
  missions: [
    mission({
      id: 'm1',
      steps: [step({ id: 'm1.s1', kind: 'visit' }), step({ id: 'm1.s2', kind: 'self' })],
    }),
    mission({ id: 'm2', steps: [step({ id: 'm2.s1', kind: 'api' })] }),
  ],
});

describe('emptyProgress', () => {
  it('records the track identity and starts empty', () => {
    const p = emptyProgress(TRACK, 1000);
    expect(p.trackId).toBe('t');
    expect(p.trackVersion).toBe(1);
    expect(p.startedAt).toBe(1000);
    expect(p.missions).toEqual({});
  });
});

describe('markStep', () => {
  it('returns a new object and does not mutate the input', () => {
    const p = emptyProgress(TRACK, 1);
    const next = markStep(p, 'm1', 'm1.s1', 'passed', 2000);
    expect(stepState(next, 'm1', 'm1.s1')).toBe('passed');
    expect(stepState(p, 'm1', 'm1.s1')).toBe(null);
    expect(next).not.toBe(p);
  });

  it('is monotonic — a passed step is never downgraded', () => {
    let p = markStep(emptyProgress(TRACK, 1), 'm1', 'm1.s1', 'passed', 2);
    p = markStep(p, 'm1', 'm1.s1', 'skipped', 3);
    expect(stepState(p, 'm1', 'm1.s1')).toBe('passed');
  });

  it('revokes a pass when explicitly reset to null (mint-time re-verification)', () => {
    let p = markStep(emptyProgress(TRACK, 1), 'm1', 'm1.s1', 'passed', 2);
    p = markStep(p, 'm1', 'm1.s1', null, 3);
    expect(stepState(p, 'm1', 'm1.s1')).toBe(null);
  });
});

describe('startMission', () => {
  it('stores the baseline once and does not overwrite it on re-entry', () => {
    let p = startMission(emptyProgress(TRACK, 1), 'm1', { queueIds: [1] }, 10);
    p = startMission(p, 'm1', { queueIds: [1, 2] }, 20);
    expect(p.missions.m1.baseline).toEqual({ queueIds: [1] });
    expect(p.missions.m1.startedAt).toBe(10);
  });

  it('captures the baseline even when a step was marked before the mission started', () => {
    let p = markStep(emptyProgress(TRACK, 1), 'm1', 'm1.s2', 'self', 5);
    p = startMission(p, 'm1', { queueIds: [1] }, 10);
    expect(p.missions.m1.baseline).toEqual({ queueIds: [1] });
    expect(stepState(p, 'm1', 'm1.s2')).toBe('self'); // the earlier mark survives
  });
});

describe('missionStatus (linear)', () => {
  it('opens the first mission, locks the rest, unlocks on completion', () => {
    const p0 = emptyProgress(TRACK, 1);
    expect(missionStatus(TRACK, p0, 'm1')).toBe('active');
    expect(missionStatus(TRACK, p0, 'm2')).toBe('locked');

    let p = markStep(p0, 'm1', 'm1.s1', 'passed', 2);
    p = markStep(p, 'm1', 'm1.s2', 'self', 3);
    expect(isMissionComplete(TRACK, p, 'm1')).toBe(true);
    expect(missionStatus(TRACK, p, 'm1')).toBe('done');
    expect(missionStatus(TRACK, p, 'm2')).toBe('active');
  });
});

describe('xp and levels', () => {
  it('scores visit 10, api 25, self 10, plus 50 per completed mission', () => {
    let p = markStep(emptyProgress(TRACK, 1), 'm1', 'm1.s1', 'passed', 2);
    expect(xpFor(TRACK, p)).toBe(10);
    p = markStep(p, 'm1', 'm1.s2', 'self', 3);
    expect(xpFor(TRACK, p)).toBe(10 + 10 + 50);
  });

  it('scores a skipped step zero', () => {
    const p = markStep(emptyProgress(TRACK, 1), 'm1', 'm1.s1', 'skipped', 2);
    expect(xpFor(TRACK, p)).toBe(0);
  });

  it('scores an api step 25, plus the mission bonus when it completes the mission', () => {
    // m2 has a single step, m2.s1, which is api-kind — passing it also
    // completes m2, so the total must include both STEP_XP.api and the bonus.
    const p = markStep(emptyProgress(TRACK, 1), 'm2', 'm2.s1', 'passed', 2);
    expect(xpFor(TRACK, p)).toBe(25 + 50);
  });

  it('maps xp to a level', () => {
    expect(levelFor(0)).toBe(1);
    expect(levelFor(99)).toBe(1);
    expect(levelFor(100)).toBe(2);
    expect(levelFor(10_000)).toBe(5);
  });
});

describe('badges and completion', () => {
  it('awards one badge per completed mission and reports track completion', () => {
    let p = markStep(emptyProgress(TRACK, 1), 'm1', 'm1.s1', 'passed', 2);
    p = markStep(p, 'm1', 'm1.s2', 'self', 3);
    expect(badges(TRACK, p)).toEqual(['m1']);
    expect(isTrackComplete(TRACK, p)).toBe(false);
    p = markStep(p, 'm2', 'm2.s1', 'passed', 4);
    expect(isTrackComplete(TRACK, p)).toBe(true);
  });
});

describe('migrate', () => {
  it('drops unknown step ids, keeps known ones, and stales an existing receipt', () => {
    let p = markStep(emptyProgress(TRACK, 1), 'm1', 'm1.s1', 'passed', 2);
    p = markStep(p, 'm1', 'GONE', 'passed', 3);
    p = { ...p, trackVersion: 0, receipt: { code: 'X' } };
    const m = migrate(TRACK, p)!;
    expect(stepState(m, 'm1', 'm1.s1')).toBe('passed');
    expect(stepState(m, 'm1', 'GONE')).toBe(null);
    expect(m.trackVersion).toBe(1);
    expect(m.receipt!.stale).toBe(true);
  });

  it('is a no-op on a matching version', () => {
    const p = emptyProgress(TRACK, 1);
    expect(migrate(TRACK, p)).toBe(p); // same-reference short-circuit, not just deep-equal
  });
});
