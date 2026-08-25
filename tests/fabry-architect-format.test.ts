import { describe, it, expect } from 'vitest';
import {
  deliverableTitle,
  headingTitle,
  relativeTime,
  summaryLine,
} from '../src/fabry/architect/format.js';
import { EXAMPLE_DELIVERABLE } from '../src/fabry/architect/example.js';

describe('summaryLine', () => {
  it('takes the first non-empty, non-fence line stripped of markdown', () => {
    expect(summaryLine('# Heading\nbody text')).toBe('Heading');
    expect(summaryLine('```\ncode\n```\nreal summary')).toBe('code'); // first non-fence content line
    expect(summaryLine('- **bold** point')).toBe('bold point');
    expect(summaryLine('')).toBe('');
  });
  it('caps long lines with an ellipsis', () => {
    const long = 'x'.repeat(200);
    const out = summaryLine(long, 40);
    expect(out.length).toBe(40);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('deliverableTitle', () => {
  it('uses the first non-empty line, stripping leading # and inline marks', () => {
    expect(deliverableTitle('# VAT extraction\nbody')).toBe('VAT extraction');
    expect(deliverableTitle('\n\n  ## **Bold** title  \nx')).toBe('Bold title');
    expect(deliverableTitle('plain first line')).toBe('plain first line');
  });
  it('falls back to Untitled for empty content', () => {
    expect(deliverableTitle('')).toBe('Untitled');
    expect(deliverableTitle('   \n  ')).toBe('Untitled');
  });
});

// headingTitle answers "does this deliverable declare its own name?" — and it
// must answer it the same way the PREVIEW tab does, or a deliverable could be
// named after a line the user sees rendered as plain text. Every negative case
// below is a line src/ui/fabry/markdown.js:76 (`^(#{1,4})\s+`, untrimmed) does
// NOT render as a heading.
describe('headingTitle', () => {
  it('takes an ATX heading on the first non-empty line', () => {
    expect(headingTitle('# VAT extraction\nbody')).toBe('VAT extraction');
    expect(headingTitle('\n\n#### Deep heading\nbody')).toBe('Deep heading');
  });
  it('strips inline marks and caps at 80 characters', () => {
    expect(headingTitle('## **Bold** `code` title')).toBe('Bold code title');
    expect(headingTitle('# ' + 'x'.repeat(120))).toBe('x'.repeat(80));
  });
  it('matches only what the Fabry markdown renderer renders as a heading', () => {
    expect(headingTitle('##### Five hashes')).toBe(''); // renderer stops at ####
    expect(headingTitle('#NoSpace')).toBe(''); // renderer requires the space
    expect(headingTitle('  # Indented')).toBe(''); // renderer matches column 0 only
  });
  it('returns empty when the first non-empty line is not a heading', () => {
    expect(headingTitle('> banner line\n# Heading below')).toBe('');
    expect(headingTitle('plain first line\n# later heading')).toBe('');
    expect(headingTitle('')).toBe('');
    expect(headingTitle('   \n  ')).toBe('');
  });
  it('returns empty when nothing survives the mark stripping', () => {
    expect(headingTitle('# **')).toBe('');
  });
  it('names the seeded example deliverable — the demo must demonstrate the rule', () => {
    // The example's heading has to LEAD it; behind the "> 👋 Example" banner the
    // first non-empty line is a blockquote and the demo would get an AI title.
    expect(headingTitle(EXAMPLE_DELIVERABLE)).toBe('Invoices queue is set up for automation');
  });
});

describe('relativeTime', () => {
  const now = 1_000_000_000_000;
  it('formats recent/min/hour/day', () => {
    expect(relativeTime(now - 10_000, now)).toBe('just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5m ago');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2d ago');
  });
  it('tolerates missing input', () => {
    expect(relativeTime(null, now)).toBe('');
  });
});
