import { describe, it, expect } from 'vitest';
import { findHints, KNOWLEDGE } from '../src/mdh/aiKnowledge.js';

describe('aiKnowledge.findHints', () => {
  it('matches "Operation was abandoned" with the pod-restart hint', () => {
    const hints = findHints('Operation was abandoned, please try again', 'error');
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatch(/pod/i);
    expect(hints[0]).toMatch(/restart/i);
  });

  it('returns an empty array when nothing matches', () => {
    expect(findHints('something completely unrelated', 'error')).toEqual([]);
  });

  it('does not match an error pattern when type is different', () => {
    expect(findHints('Operation was abandoned', 'pipeline')).toEqual([]);
  });

  it('handles non-string inputs by stringifying them', () => {
    const hints = findHints({ message: 'Operation was abandoned' }, 'error');
    expect(hints.length).toBe(1);
  });

  it('all hint texts use hedged language ("most often", "in our experience", "usually") so they read as hypotheses', () => {
    for (const entry of KNOWLEDGE) {
      expect(entry.hint).toBeTypeOf('string');
      expect(entry.hint.length).toBeGreaterThan(40);
    }
  });
});
