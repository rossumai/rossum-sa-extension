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
  it('suppresses a trailing, not-yet-closed [e: marker ONLY while streaming (no literal flicker)', () => {
    // While streaming, the closing "]" arrives a tick after "[e:blocker". The raw marker
    // must not render as text in the meantime.
    expect(parseCitations('done [e:blocker', true)).toEqual([{ type: 'text', text: 'done ' }]);
    expect(parseCitations('done [e:', true)).toEqual([{ type: 'text', text: 'done ' }]);
    expect(parseCitations('a [e:x] then [e:drift:added', true)).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'cite', id: 'x' },
      { type: 'text', text: ' then ' },
    ]);
    // A bare "[" or "[e" (no colon yet) is ambiguous prose → left as-is.
    expect(parseCitations('see [1] note', true)).toEqual([{ type: 'text', text: 'see [1] note' }]);
  });
  it('does NOT truncate a finished (non-streaming) render that ends with an unclosed [e: fragment', () => {
    // On the final render the text is kept verbatim — silently dropping a completed
    // narrative's trailing content would be worse than a stray marker.
    expect(parseCitations('reference it with [e:')).toEqual([
      { type: 'text', text: 'reference it with [e:' },
    ]);
    expect(parseCitations('done [e:blocker')).toEqual([{ type: 'text', text: 'done [e:blocker' }]);
  });
  it('matches the full evidence-id charset (letters/digits/_ . : -) — real ids use colons heavily', () => {
    const ids = [
      'blocker:0',
      'field:item_amount',
      'gap:hookLogs',
      'drift:added:12',
      'workflow:step:5',
      'intake:arrival',
      'label-not:7',
      'message:0',
    ];
    const text = ids.map((id) => `x [e:${id}]`).join(' ');
    expect(
      parseCitations(text)
        .filter((s) => s.type === 'cite')
        .map((s) => s.id),
    ).toEqual(ids);
  });
});

describe('parseNarrative', () => {
  it('splits lines into paragraph and bullet blocks', () => {
    const b = parseNarrative('Takeaway.\n- one\n- two\nNext step: go.');
    expect(b.map((x) => x.type)).toEqual(['p', 'li', 'li', 'p']);
    expect((b[3].segments[0] as any).text).toContain('Next step');
  });
  it('tolerates blank lines, • bullets, a partial last line; empty/null → []', () => {
    const b = parseNarrative('Head\n\n• first\n- seco');
    expect(b.map((x) => x.type)).toEqual(['p', 'li', 'li']);
    expect((b[2].segments[0] as any).text).toBe('seco');
    expect(parseNarrative('')).toEqual([]);
    expect(parseNarrative(null)).toEqual([]);
  });
});
