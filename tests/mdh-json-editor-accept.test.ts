// Pure unit tests for JsonEditor's `isAcceptable` validation helper. The
// clipboard import stage's copy promises JSON-lines support and its Next path
// accepts NDJSON via a line-wise fallback, so the editor's validation must
// agree instead of flashing a JSON5 parse error on perfectly importable
// JSON-lines input. See .superpowers/sdd/task-11-brief.md.
import { describe, it, expect } from 'vitest';
import { isAcceptable } from '../src/mdh/components/JsonEditor.jsx';

describe('JsonEditor isAcceptable', () => {
  it('accepts JSON5 everywhere', () => {
    expect(isAcceptable('{a: 1}', {})).toBe(true);
    expect(isAcceptable('{a: 1}', { jsonLines: true })).toBe(true);
  });

  it('accepts JSON-lines only when jsonLines is set', () => {
    const nd = '{"a":1}\n{"b":1}\n{"c":1}';
    expect(isAcceptable(nd, {})).toBe(false);
    expect(isAcceptable(nd, { jsonLines: true })).toBe(true);
  });

  it('rejects garbage in both modes', () => {
    expect(isAcceptable('{"a":1}\nnot json', { jsonLines: true })).toBe(false);
    expect(isAcceptable('', { jsonLines: true })).toBe(false);
  });

  it('defaults jsonLines to false when options are omitted', () => {
    expect(isAcceptable('{"a":1}\n{"b":1}')).toBe(false);
  });

  it('tolerates blank lines between JSON-lines records', () => {
    const nd = '{"a":1}\n\n{"b":1}\n';
    expect(isAcceptable(nd, { jsonLines: true })).toBe(true);
  });
});
