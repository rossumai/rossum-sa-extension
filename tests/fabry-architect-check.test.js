import { describe, it, expect } from 'vitest';
import { buildCheckPrompt, parseCheckVerdict } from '../src/fabry/architect/check.js';

describe('buildCheckPrompt', () => {
  it('includes read-only framing, the verdict contract, and the requirement', () => {
    const p = buildCheckPrompt('Every invoice queue must have a duplicate-detection hook.');
    expect(p).toMatch(/read-only/i);
    expect(p).toMatch(/VERDICT: PASS/);
    expect(p).toMatch(/VERDICT: FAIL/);
    expect(p).toMatch(/VERDICT: UNCERTAIN/);
    expect(p).toContain('Every invoice queue must have a duplicate-detection hook.');
  });
});

describe('parseCheckVerdict', () => {
  it('parses a first-line PASS', () => {
    const r = parseCheckVerdict('VERDICT: PASS\nAll three queues have the hook.');
    expect(r.verdict).toBe('pass');
    expect(r.evidence).toContain('All three queues');
  });
  it('parses FAIL and UNCERTAIN case-insensitively', () => {
    expect(parseCheckVerdict('verdict: fail\n- missing on Q2').verdict).toBe('fail');
    expect(parseCheckVerdict('Verdict: Uncertain\ncould not read logs').verdict).toBe('uncertain');
  });
  it('finds a verdict line that is not the first line', () => {
    expect(parseCheckVerdict('Let me check...\nVERDICT: PASS\ndone').verdict).toBe('pass');
  });
  it('defaults to uncertain when no verdict line is present', () => {
    const r = parseCheckVerdict('I looked but the answer is unclear.');
    expect(r.verdict).toBe('uncertain');
    expect(r.evidence).toBe('I looked but the answer is unclear.');
  });
  it('tolerates null/undefined', () => {
    expect(parseCheckVerdict(undefined).verdict).toBe('uncertain');
    expect(parseCheckVerdict(null).evidence).toBe('');
  });
});
