import { describe, it, expect } from 'vitest';
import { classifySpecial, cpLabel, hasSpecial, tokenizeSpecial } from '../src/mdh/specialChars.js';

describe('classifySpecial', () => {
  it('classifies a representative member of each category', () => {
    expect(classifySpecial(0x00a0)).toEqual({
      category: 'space',
      name: 'NO-BREAK SPACE',
      abbr: 'NBSP',
    });
    expect(classifySpecial(0x200b)).toEqual({
      category: 'zero-width',
      name: 'ZERO WIDTH SPACE',
      abbr: 'ZWSP',
    });
    expect(classifySpecial(0x0009)).toEqual({ category: 'control', name: 'TAB', abbr: 'TAB' });
    expect(classifySpecial(0x200e)).toEqual({
      category: 'bidi',
      name: 'LEFT-TO-RIGHT MARK',
      abbr: 'LRM',
    });
  });

  it('does NOT classify ordinary space, letters, digits, or astral emoji', () => {
    expect(classifySpecial(0x20)).toBeNull(); // ordinary space
    expect(classifySpecial('A'.codePointAt(0)!)).toBeNull();
    expect(classifySpecial('7'.codePointAt(0)!)).toBeNull();
    expect(classifySpecial('\u{1F600}'.codePointAt(0)!)).toBeNull(); // U+1F600
  });

  it('gives a generic name/abbr to un-named control chars', () => {
    const info = classifySpecial(0x0007)!; // BEL
    expect(info.category).toBe('control');
    expect(info.name).toBe('CONTROL U+0007');
    expect(info.abbr).toBe('U+0007'); // no curated abbreviation → falls back to cpLabel
  });

  it('labels the C0 information separators (e.g. U+001F) instead of the raw codepoint', () => {
    expect(classifySpecial(0x001f)).toEqual({
      category: 'control',
      name: 'UNIT SEPARATOR',
      abbr: 'US',
    });
    expect(classifySpecial(0x001e)).toEqual({
      category: 'control',
      name: 'RECORD SEPARATOR',
      abbr: 'RS',
    });
    expect(classifySpecial(0x001d)).toEqual({
      category: 'control',
      name: 'GROUP SEPARATOR',
      abbr: 'GS',
    });
    expect(classifySpecial(0x001c)).toEqual({
      category: 'control',
      name: 'FILE SEPARATOR',
      abbr: 'FS',
    });
  });
});

describe('cpLabel', () => {
  it('formats uppercase hex, min 4 digits', () => {
    expect(cpLabel(0x00a0)).toBe('U+00A0');
    expect(cpLabel(0x0009)).toBe('U+0009');
    expect(cpLabel(0x1f600)).toBe('U+1F600');
  });
});

describe('hasSpecial', () => {
  it('detects presence and absence', () => {
    expect(hasSpecial('Acme\u00a0Corp')).toBe(true);
    expect(hasSpecial('Acme Corp')).toBe(false); // ordinary spaces only
    expect(hasSpecial('')).toBe(false);
  });
  it('returns false for non-strings', () => {
    expect(hasSpecial(42)).toBe(false);
    expect(hasSpecial(null)).toBe(false);
    expect(hasSpecial({})).toBe(false);
  });
});

describe('tokenizeSpecial', () => {
  it('coalesces normal runs and emits one special token', () => {
    const { tokens, truncated } = tokenizeSpecial('ab\u00a0cd');
    expect(truncated).toBe(false);
    expect(tokens).toEqual([
      { type: 'text', value: 'ab' },
      {
        type: 'special',
        cp: 0x00a0,
        char: '\u00a0',
        category: 'space',
        name: 'NO-BREAK SPACE',
        abbr: 'NBSP',
      },
      { type: 'text', value: 'cd' },
    ]);
  });

  it('handles a value that is all special characters', () => {
    const { tokens } = tokenizeSpecial('\u00a0\u200b');
    expect(tokens.map((t) => t.type)).toEqual(['special', 'special']);
    expect(tokens.map((t) => t.category)).toEqual(['space', 'zero-width']);
  });

  it('truncates by source-character count and sets truncated', () => {
    const long = 'x'.repeat(25);
    const { tokens, truncated } = tokenizeSpecial(long, { limit: 20 });
    expect(truncated).toBe(true);
    expect(tokens).toEqual([{ type: 'text', value: 'x'.repeat(20) }]);
  });

  it('does not truncate when length equals the limit', () => {
    const { truncated } = tokenizeSpecial('y'.repeat(20), { limit: 20 });
    expect(truncated).toBe(false);
  });

  it('iterates by code point so astral characters are not split', () => {
    const { tokens } = tokenizeSpecial('a\u{1F600}b');
    expect(tokens).toEqual([{ type: 'text', value: 'a\u{1F600}b' }]);
  });
});
