import { describe, it, expect } from 'vitest';
import { computeMinimalChange } from '../src/mdh/editorDiff.js';

// Apply a CodeMirror-style { from, to, insert } change to a string.
function apply(a: any, change: any) {
  if (change == null) return a;
  return a.slice(0, change.from) + change.insert + a.slice(change.to);
}

describe('computeMinimalChange', () => {
  it('returns null for identical text', () => {
    expect(computeMinimalChange('abc', 'abc')).toBe(null);
    expect(computeMinimalChange('', '')).toBe(null);
  });

  it('produces a change that exactly reconstructs the new text', () => {
    const cases = [
      ['', 'hello'],
      ['hello', ''],
      ['abc', 'abXc'],
      ['abc', 'aXc'],
      ['hello world', 'hello brave world'],
      [
        '[\n  {"$match":{}},\n  {"$limit":5}\n]',
        '[\n  {"$match":{}},\n  {"$sort":{"a":1}},\n  {"$limit":5}\n]',
      ],
    ];
    for (const [a, b] of cases) {
      expect(apply(a, computeMinimalChange(a, b))).toBe(b);
    }
  });

  it('only rewrites the differing middle (keeps shared prefix and suffix)', () => {
    // Mimics the stage-toggle edit: a single stage span gets wrapped in a comment.
    const a = '[\n  {"$match":{}},\n  {"$sort":{"a":1}},\n  {"$limit":5}\n]';
    const b =
      '[\n  {"$match":{}},\n  /* @disabled-stage\n  {"$sort":{"a":1}}, */\n  {"$limit":5}\n]';
    const change = computeMinimalChange(a, b)!;
    // The change must start after the shared "{"$match":{}}," prefix and end
    // before the shared "{"$limit":5}\n]" suffix — i.e. it touches only the
    // $sort stage, not the whole document.
    expect(a.startsWith(a.slice(0, change.from))).toBe(true);
    expect(change.from).toBeGreaterThan(a.indexOf('$match'));
    expect(change.to).toBeLessThan(a.indexOf('$limit'));
    expect(apply(a, change)).toBe(b);
  });

  it('handles a single trailing-character edit', () => {
    const a = 'aaa\nbbb\nccc';
    const b = 'aaa\nbbb\nccd';
    const change = computeMinimalChange(a, b);
    expect(change).toEqual({ from: 10, to: 11, insert: 'd' });
    expect(apply(a, change)).toBe(b);
  });

  it('never splits a UTF-16 surrogate pair at the change boundary', () => {
    const grin = '😀'; // 😀
    const beam = '😁'; // 😁  (shares the high surrogate)
    const cases = [
      [grin, beam], // differing low surrogate at the prefix side
      [grin + 'x', grin + 'y'], // pair fully in shared prefix
      ['x' + grin, 'y' + grin], // pair fully in shared suffix
      ['A' + grin, grin], // pair preserved on the suffix side
      [grin, 'A' + grin],
    ];
    for (const [a, b] of cases) {
      const change = computeMinimalChange(a, b)!;
      expect(apply(a, change)).toBe(b);
      // A boundary must not fall between a high surrogate and its low surrogate.
      const isHigh = (c: any) => c >= 0xd800 && c <= 0xdbff;
      if (change.from > 0) expect(isHigh(a.charCodeAt(change.from - 1))).toBe(false);
      if (change.to > 0 && change.to < a.length)
        expect(isHigh(a.charCodeAt(change.to - 1))).toBe(false);
    }
  });
});
