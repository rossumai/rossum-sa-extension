import { describe, it, expect } from 'vitest';
import { tokenize, diffWords } from '../src/ui/textDiff.js';

const join = (segs, types) => segs.filter((s) => types.includes(s.type)).map((s) => s.text).join('');

describe('textDiff', () => {
  it('tokenize keeps words and whitespace so the text reconstructs exactly', () => {
    const s = 'The  Invoices\nqueue';
    expect(tokenize(s).join('')).toBe(s);
  });
  it('identical inputs → all "same"', () => {
    const segs = diffWords('same text here', 'same text here');
    expect(segs.every((s) => s.type === 'same')).toBe(true);
    expect(join(segs, ['same'])).toBe('same text here');
  });
  it('a word change → del of the old word, add of the new', () => {
    const segs = diffWords('the invoices queue', 'the Invoices queue');
    const dels = segs.filter((s) => s.type === 'del').map((s) => s.text);
    const adds = segs.filter((s) => s.type === 'add').map((s) => s.text);
    expect(dels).toContain('invoices');
    expect(adds).toContain('Invoices');
  });
  it('same+del reconstructs the BEFORE text; same+add reconstructs the AFTER text', () => {
    const a = 'automation should be good over time';
    const b = 'automation is at least 80% over the last month';
    const segs = diffWords(a, b);
    expect(join(segs, ['same', 'del'])).toBe(a);
    expect(join(segs, ['same', 'add'])).toBe(b);
  });
  it('empty before → everything is an add; empty after → everything is a del', () => {
    expect(diffWords('', 'hello world').every((s) => s.type === 'add')).toBe(true);
    expect(diffWords('hello world', '').every((s) => s.type === 'del')).toBe(true);
  });
});
