import { describe, it, expect } from 'vitest';
import {
  canonicalString, formatCode, renderReceipt, parseReceipt, mintCode, verifyReceipt,
} from '../src/training/receipt.js';
import { hmacSha256 } from '../src/training/hmac.js';

const FIELDS = {
  trackId: 'partner-foundations', trackVersion: 1,
  host: 'partner-sandbox.rossum.app', userId: 42, username: 'j.doe',
  missionsPassed: ['m1', 'm2', 'm3', 'm4', 'm5'], selfCount: 6, dateUtc: '2026-08-07',
};

// Deterministic stand-in for HMAC so receipt.js stays pure and testable.
const fakeSign = async (msg) => {
  const out = new Uint8Array(32);
  let h = 0x811c9dc5;
  for (let i = 0; i < msg.length; i++) h = Math.imul(h ^ msg.charCodeAt(i), 0x01000193) >>> 0;
  for (let b = 0; b < 32; b++) { h = Math.imul(h ^ (b + 1), 0x01000193) >>> 0; out[b] = h & 0xff; }
  return out;
};

describe('canonicalString', () => {
  it('is stable, ordered and pipe-delimited', () => {
    expect(canonicalString(FIELDS)).toBe(
      'RSAT1|partner-foundations@1|partner-sandbox.rossum.app|42|j.doe|m1,m2,m3,m4,m5|6|2026-08-07');
  });

  // This used to assert the OPPOSITE, and that assertion encoded a real defect:
  // an unsigned username is free-form text on the printed receipt, so anyone
  // could take a colleague's receipt, swap the name for their own, and have it
  // validate — while the trainer panel reports "Valid — issued to <name>".
  it('INCLUDES the username — it is what the receipt attributes completion to', () => {
    expect(canonicalString(FIELDS)).toContain('j.doe');
  });

  it('changes when any signed field changes', () => {
    const base = canonicalString(FIELDS);
    expect(canonicalString({ ...FIELDS, userId: 43 })).not.toBe(base);
    expect(canonicalString({ ...FIELDS, username: 'e.vil' })).not.toBe(base);
    expect(canonicalString({ ...FIELDS, host: 'other.rossum.app' })).not.toBe(base);
    expect(canonicalString({ ...FIELDS, trackVersion: 2 })).not.toBe(base);
  });
});

describe('formatCode', () => {
  it('emits RSA1- plus three Crockford base32 groups of four', () => {
    const code = formatCode(new Uint8Array(32).fill(0xff));
    expect(code).toMatch(/^RSA1-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  });

  // The old version of this test filled all 32 bytes with ONE value, so each
  // generated code exercised a single alphabet slot and the assertion was
  // really about a constant that contains no I/L/O/U — no implementation change
  // could have failed it. Varying the bytes WITHIN each code covers all 32
  // alphabet indices (i*5 mod 32 is a full cycle), so adding one of the four
  // confusable characters to ALPHABET now fails here.
  it('emits only Crockford base32 — never I, L, O or U — for every byte value and alphabet slot', () => {
    const seen = new Set();
    for (let start = 0; start < 256; start++) {
      const bytes = Uint8Array.from({ length: 32 }, (_, i) => (start + i * 5) & 0xff);
      const body = formatCode(bytes).slice('RSA1-'.length).replace(/-/g, '');
      expect(body).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);
      expect(body).not.toMatch(/[ILOU]/);
      for (const ch of body) seen.add(ch);
    }
    // Guard against the loop degenerating: it must really reach every slot.
    expect(seen.size).toBe(32);
  });

  it('is deterministic', () => {
    const bytes = new Uint8Array(32).fill(9);
    expect(formatCode(bytes)).toBe(formatCode(bytes));
  });
});

describe('render and parse round-trip', () => {
  it('parses back exactly what was rendered', async () => {
    const code = await mintCode(FIELDS, fakeSign);
    const parsed = parseReceipt(renderReceipt(FIELDS, code));
    expect(parsed.fields).toEqual(FIELDS);
    expect(parsed.code).toBe(code);
  });

  it('prints the self-attested count so it cannot be read as verified', () => {
    const text = renderReceipt(FIELDS, 'RSA1-AAAA-BBBB-CCCC');
    expect(text).toContain('self-attested');
    expect(text).toContain('6');
  });

  it('returns null on a malformed receipt', () => {
    expect(parseReceipt('nonsense')).toBe(null);
    expect(parseReceipt('')).toBe(null);
  });

  it('tolerates leading and trailing whitespace only', async () => {
    const code = await mintCode(FIELDS, fakeSign);
    expect(parseReceipt(`\n  ${renderReceipt(FIELDS, code)}  \n`).code).toBe(code);
  });

  it('round-trips a username with a trailing space', async () => {
    const fields = { ...FIELDS, username: 'j.doe ' };
    const parsed = parseReceipt(renderReceipt(fields, await mintCode(fields, fakeSign)));
    expect(parsed.fields.username).toBe('j.doe ');
  });

  // The old assertion was `parsed === null || …every(m => !m.includes('|'))`:
  // it passed on EITHER branch, and an empty missions line parses to [] so
  // `.every()` on it was trivially true as well — no behaviour of parseReceipt
  // could have failed it. The property that actually matters is the one the
  // LINE comment states: `[ \t]*` rather than `\s*` means an empty field value
  // cannot let the match cross the newline and capture the NEXT line's content.
  // With `\s*` this test fails hard — missionsPassed becomes
  // ['self-attested  | 6'].
  it('an empty field value is read as empty, never as the next line', async () => {
    const fields = { ...FIELDS, missionsPassed: [] };
    const text = renderReceipt(fields, await mintCode(fields, fakeSign));
    expect(text).toMatch(/^missions\s+\|[ \t]*$/m);    // guard: the line really is value-less
    expect(text).toMatch(/^self-attested\s+\|\s*6$/m); // guard: the next line has content to swallow

    const parsed = parseReceipt(text);
    expect(parsed).not.toBe(null);
    expect(parsed.fields.missionsPassed).toEqual([]);
    expect(parsed.fields.selfCount).toBe(6);           // the next line still owns its own value
    expect(parsed.fields.dateUtc).toBe('2026-08-07');
    // And the whole thing still round-trips, so an empty field cannot quietly
    // change what the signature covers.
    expect((await verifyReceipt(text, fakeSign)).valid).toBe(true);
  });
});

describe('verifyReceipt', () => {
  it('accepts an untampered receipt', async () => {
    const text = renderReceipt(FIELDS, await mintCode(FIELDS, fakeSign));
    expect(await verifyReceipt(text, fakeSign)).toEqual({ valid: true, fields: FIELDS });
  });

  it('rejects a receipt whose org was edited', async () => {
    const text = renderReceipt(FIELDS, await mintCode(FIELDS, fakeSign))
      .replace('partner-sandbox.rossum.app', 'someone-else.rossum.app');
    expect((await verifyReceipt(text, fakeSign)).valid).toBe(false);
  });

  // C3. The attack this closes: take a colleague's genuine receipt, change only
  // the printed NAME to your own, hand it to a trainer. The id stays theirs,
  // but a trainer reads "Valid — issued to <you>" and has no reason to look up
  // an opaque number. With the username unsigned this passed.
  it('rejects a receipt whose printed username was swapped for someone else\'s', async () => {
    const text = renderReceipt(FIELDS, await mintCode(FIELDS, fakeSign)).replace('j.doe', 'e.vil');
    expect(text).toContain('e.vil');   // guard: a no-op replace would vacuously pass
    expect(text).toContain('(id 42)'); // the id is untouched — only the name was forged
    expect((await verifyReceipt(text, fakeSign)).valid).toBe(false);
  });

  it('rejects a receipt whose user was edited', async () => {
    const text = renderReceipt(FIELDS, await mintCode(FIELDS, fakeSign)).replace('(id 42)', '(id 43)');
    expect(text).toContain('(id 43)'); // guard: a no-op replace would vacuously pass
    expect((await verifyReceipt(text, fakeSign)).valid).toBe(false);
  });

  it('rejects unparseable input without throwing', async () => {
    expect(await verifyReceipt('garbage', fakeSign)).toEqual({ valid: false, fields: null });
  });
});

describe('hmacSha256', () => {
  it('produces 32 deterministic bytes', async () => {
    const a = await hmacSha256('k', 'message');
    const b = await hmacSha256('k', 'message');
    const c = await hmacSha256('k', 'message2');
    expect(a.length).toBe(32);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).not.toEqual(Array.from(c));
  });
});
