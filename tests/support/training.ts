// Shared fixtures for the onboarding-track tests.
//
// Track/Mission/TrackStep carry presentation fields (title, blurb, hint) that the progress
// arithmetic never reads. Tests still build the complete shape rather than a partial one,
// so a fixture cannot drift from the type the real TRACK satisfies; pass only the fields
// the assertion is about.
import type { Track, Mission, TrackStep } from '../../src/training/track.js';

export const step = (p: Partial<TrackStep> & Pick<TrackStep, 'id' | 'kind'>): TrackStep => ({
  hint: '',
  ...p,
});

export const mission = (p: Partial<Mission> & Pick<Mission, 'id' | 'steps'>): Mission => ({
  title: '',
  blurb: '',
  ...p,
});

export const track = (p: Partial<Track> & Pick<Track, 'id' | 'version' | 'missions'>): Track => ({
  title: '',
  ...p,
});
