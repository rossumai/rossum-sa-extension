// Pure tests for the AI-generated deliverable title prompt/parser (title.js)
// and the displayTitle fallback helper (format.js). No mocking needed — see
// tests/fabry-architect-api.test.js and tests/fabry-architect-actions.test.js
// for the impure loadDeliverables/saveTitle + renameDeliverable/generateTitle/
// backfillTitles coverage.
import { describe, it, expect } from 'vitest';
import { buildTitlePrompt, parseTitle } from '../src/fabry/architect/title.js';
import { displayTitle } from '../src/fabry/architect/format.js';

describe('buildTitlePrompt', () => {
  it('asks for a short, title-only reply and includes the requirement text', () => {
    const prompt = buildTitlePrompt('Add a VAT rule');
    expect(prompt).toContain('at most 6 words');
    expect(prompt).toContain('ONLY the title');
    expect(prompt).toContain('Add a VAT rule');
  });
});

describe('parseTitle', () => {
  it('strips surrounding quotes', () => {
    expect(parseTitle('"Add VAT Rule"')).toBe('Add VAT Rule');
  });
  it('takes the first non-empty line and strips a heading marker', () => {
    expect(parseTitle('## Foo\nbar')).toBe('Foo');
  });
  it('returns an empty string for empty/blank/missing input', () => {
    expect(parseTitle('')).toBe('');
    expect(parseTitle(undefined)).toBe('');
    expect(parseTitle('   \n  ')).toBe('');
  });
});

describe('format.displayTitle', () => {
  it('prefers an explicit title over the derived one', () => {
    expect(displayTitle({ title: 'Nice', text: 'x' })).toBe('Nice');
  });
  it('prefers a heading the text declares over an AI-generated title', () => {
    expect(displayTitle({ title: 'AI Title', titleSource: 'ai', text: '# Heading Wins\nbody' })).toBe('Heading Wins');
  });
  it('prefers a heading over a legacy stored title that carries no source marker', () => {
    // Every title written before titleSource existed reads as AI-generated —
    // which is what lets the new rule reach deliverables that already exist.
    expect(displayTitle({ title: 'Legacy Title', text: '# Heading Wins' })).toBe('Heading Wins');
  });
  it('lets a manual rename beat the heading', () => {
    expect(displayTitle({ title: 'Renamed', titleSource: 'manual', text: '# Heading' })).toBe('Renamed');
  });
  it('falls back to the heading when a manual rename is blanked out', () => {
    expect(displayTitle({ title: '  ', titleSource: 'manual', text: '# Heading' })).toBe('Heading');
  });
  it('keeps the stored title when the text declares no heading', () => {
    expect(displayTitle({ title: 'AI Title', titleSource: 'ai', text: '> banner\n# not the first line' })).toBe('AI Title');
  });
  it('falls back to the derived title when the title is blank/whitespace', () => {
    expect(displayTitle({ title: '  ', text: '# Derived' })).toBe('Derived');
  });
  it('falls back to the derived title when title is missing entirely', () => {
    expect(displayTitle({ text: '# Derived' })).toBe('Derived');
  });
});
