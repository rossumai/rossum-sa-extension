import { describe, it, expect } from 'vitest';
import { currentSection, railTarget, activeHeadingAt, SPY_OFFSET } from '../src/fabry/architect/specTarget.js';

const TOPS = [{ id: 'a', top: 0 }, { id: 'b', top: 1200 }, { id: 'c', top: 2400 }];

describe('currentSection', () => {
  it('is the last section whose top has passed the threshold', () => {
    expect(currentSection(TOPS, 0)).toBe('a');
    expect(currentSection(TOPS, 1200 - SPY_OFFSET)).toBe('b');   // exactly at the threshold counts
    expect(currentSection(TOPS, 1500)).toBe('b');
    expect(currentSection(TOPS, 5000)).toBe('c');
  });

  it('holds the first section while scrolled above it, and tolerates junk', () => {
    expect(currentSection(TOPS, -300)).toBe('a');
    expect(currentSection([], 10)).toBe(null);
    expect(currentSection(null, 10)).toBe(null);
    expect(currentSection(TOPS, NaN)).toBe('a');
  });

  it('does not assume the input is sorted', () => {
    expect(currentSection([...TOPS].reverse(), 1500)).toBe('b');
  });
});

describe('railTarget', () => {
  it('prefers an explicit pin over the scroll', () => {
    expect(railTarget({ spy: 'c', pinned: 'a', running: null })).toBe('a');
  });

  it('HOLDS the shown deliverable while a check runs for it', () => {
    // A run started from the rail must not have its panel scrolled away.
    expect(railTarget({ spy: 'c', pinned: null, running: 'a', shown: 'a' })).toBe('a');
  });

  it('follows the scroll when nothing is pinned and the run is elsewhere', () => {
    expect(railTarget({ spy: 'c', pinned: null, running: 'b', shown: 'b' })).toBe('b');
    expect(railTarget({ spy: 'c', pinned: null, running: null, shown: 'a' })).toBe('c');
    expect(railTarget({ spy: null, pinned: null, running: null, shown: 'a' })).toBe('a');
    expect(railTarget({})).toBe(null);
  });
});

describe('activeHeadingAt', () => {
  const H = [
    { docId: 'a', slug: 'a--one', top: 40 },
    { docId: 'a', slug: 'a--two', top: 800 },
    { docId: 'b', slug: 'b--one', top: 1300 },
  ];
  it('reports the heading the reader is under, across deliverables', () => {
    expect(activeHeadingAt(H, 0)).toEqual({ docId: 'a', slug: 'a--one' });
    expect(activeHeadingAt(H, 900)).toEqual({ docId: 'a', slug: 'a--two' });
    expect(activeHeadingAt(H, 4000)).toEqual({ docId: 'b', slug: 'b--one' });
    expect(activeHeadingAt([], 10)).toBe(null);
  });
});
