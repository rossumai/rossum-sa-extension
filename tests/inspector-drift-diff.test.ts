import { describe, it, expect } from 'vitest';
import { driftDiff } from '../src/inspector/driftDiff.js';

describe('driftDiff', () => {
  const e = (content: any, type = 'error', id: string | number | null = null) => ({
    type,
    content,
    id,
  });
  it('classifies added / removed / unchanged by (type, content, id)', () => {
    const persisted = [e('A'), e('B', 'warning'), e('C', 'error', 101)];
    const live = [e('A'), e('D'), e('C', 'error', 102)];
    const d = driftDiff(persisted, live, [{ id: 7 }]);
    expect(d.unchanged.map((m) => m.content)).toEqual(['A']);
    expect(d.removed.map((m) => m.content)).toEqual(['B', 'C']);
    expect(d.added.map((m) => m.content)).toEqual(['D', 'C']);
    expect(d.matchedRules).toEqual([{ id: 7 }]);
  });
  it('tolerates null/undefined inputs', () => {
    const d = driftDiff(null, undefined);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });
});
