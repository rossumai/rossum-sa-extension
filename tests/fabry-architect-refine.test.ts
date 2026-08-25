import { describe, it, expect } from 'vitest';
import { buildRefineFirst, buildRefineNext, parseRefinedText } from '../src/fabry/architect/refine.js';

describe('refine.buildRefineFirst', () => {
  const p = buildRefineFirst('the invoices Q should be automatic', 'add an 80% automation threshold');
  it('carries the rules (clarity, preserve-meaning, read-only, return-only), the requirement, and the instruction', () => {
    expect(p).toMatch(/clarity/i);
    expect(p).toMatch(/preserve the requirement's meaning/i);
    expect(p).toMatch(/read-only/i);
    expect(p).toMatch(/never create, update, or delete/i);
    expect(p).toMatch(/return only the complete revised requirement/i);
    expect(p).toContain('the invoices Q should be automatic');
    expect(p).toContain('add an 80% automation threshold');
  });
});

describe('refine.buildRefineNext', () => {
  it('is just the next instruction (rules/proposals live in the chat context)', () => {
    const p = buildRefineNext('also name the real queue');
    expect(p).toContain('also name the real queue');
    expect(p).not.toMatch(/REQUIREMENT:/); // no requirement re-sent on follow-ups
  });
});

describe('refine.parseRefinedText', () => {
  it('trims and unwraps a surrounding code fence', () => {
    expect(parseRefinedText('  # Clear  ')).toBe('# Clear');
    expect(parseRefinedText('```markdown\n# Clear\n\nBody.\n```')).toBe('# Clear\n\nBody.');
  });
  it('leaves inline code / normal markdown alone', () => {
    const md = '# Title\n\nUse `document_id` here.';
    expect(parseRefinedText(md)).toBe(md);
  });
});
