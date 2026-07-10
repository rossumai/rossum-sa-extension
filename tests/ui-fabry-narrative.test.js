import { describe, it, expect } from 'vitest';
import { parseNarrative, parseCitations } from '../src/ui/fabry/narrative.js';

describe('parseCitations', () => {
  it('splits text and cite segments', () => {
    const seg = parseCitations('A [e:audit:1] and [e:user:2].');
    expect(seg.filter((s) => s.type === 'cite').map((s) => s.id)).toEqual(['audit:1', 'user:2']);
    expect(seg[0]).toEqual({ type: 'text', text: 'A ' });
  });
  it('no markers → single text segment; empty → []', () => {
    expect(parseCitations('plain')).toEqual([{ type: 'text', text: 'plain' }]);
    expect(parseCitations('')).toEqual([]);
  });
});

describe('parseNarrative', () => {
  it('splits lines into paragraph and bullet blocks', () => {
    const b = parseNarrative('Takeaway.\n- one\n- two\nNext step: go.');
    expect(b.map((x) => x.type)).toEqual(['p', 'li', 'li', 'p']);
    expect(b[3].segments[0].text).toContain('Next step');
  });
  it('tolerates blank lines, • bullets, a partial last line; empty/null → []', () => {
    const b = parseNarrative('Head\n\n• first\n- seco');
    expect(b.map((x) => x.type)).toEqual(['p', 'li', 'li']);
    expect(b[2].segments[0].text).toBe('seco');
    expect(parseNarrative('')).toEqual([]);
    expect(parseNarrative(null)).toEqual([]);
  });
});
