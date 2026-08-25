// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { parseNdjson } from '../src/mdh/ndjson.js';
import { buildNdjsonSerializer } from '../src/mdh/downloadCollection.js';

describe('parseNdjson', () => {
  it('parses one object per line, skipping blank lines', () => {
    const r = parseNdjson('{"a":1}\n\n{"a":2}\n');
    expect(r.error).toBeNull();
    expect(r.docs).toEqual([{ a: 1 }, { a: 2 }]);
    expect(r.warnings).toEqual([]);
  });
  it('handles CRLF line endings', () => {
    expect(parseNdjson('{"a":1}\r\n{"a":2}').docs).toEqual([{ a: 1 }, { a: 2 }]);
  });
  it('skips a malformed line with a warning but imports the rest', () => {
    const r = parseNdjson('{"a":1}\noops\n{"a":2}');
    expect(r.docs).toEqual([{ a: 1 }, { a: 2 }]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/Line 2/);
  });
  it('skips non-object lines (number / string / array) with warnings', () => {
    const r = parseNdjson('{"a":1}\n42\n"x"\n[1,2]');
    expect(r.docs).toEqual([{ a: 1 }]);
    expect(r.warnings).toHaveLength(3);
  });
  it('returns an error when nothing parses', () => {
    const r = parseNdjson('nope\nalso nope');
    expect(r.error).toBeTruthy();
    expect(r.docs).toEqual([]);
  });
});

describe('buildNdjsonSerializer', () => {
  it('emits one compact JSON object per line and streams (empty pre/postamble)', () => {
    const s = buildNdjsonSerializer();
    expect(s.ext).toBe('jsonl');
    expect(s.mimeType).toBe('application/x-ndjson');
    expect(s.preamble()).toBe('');
    expect(s.postamble()).toBe('');
    expect(s.separator).toBe('\n');
    expect(s.item({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}');
  });
  it('preserves EJSON shapes and round-trips through parseNdjson', () => {
    const s = buildNdjsonSerializer();
    const docs = [{ _id: { $oid: 'abc' }, n: 1 }, { _id: { $oid: 'def' }, n: 2 }];
    const text = docs.map((d) => s.item(d)).join(s.separator);
    expect(parseNdjson(text).docs).toEqual(docs);
  });
});
