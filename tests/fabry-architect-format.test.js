import { describe, it, expect } from 'vitest';
import { deliverableTitle, relativeTime, summaryLine } from '../src/fabry/architect/format.js';

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

describe('relativeTime', () => {
  const now = 1_000_000_000_000;
  it('formats recent/min/hour/day', () => {
    expect(relativeTime(now - 10_000, now)).toBe('just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5m ago');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2d ago');
  });
  it('tolerates missing input', () => { expect(relativeTime(null, now)).toBe(''); });
});
