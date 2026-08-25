import { describe, it, expect } from 'vitest';
import { budgetedJoin, MAX_PROMPT } from '../src/inspector/promptBudget.js';

describe('budgetedJoin', () => {
  it('keeps head and tail always, budgets the middle, notes omissions', () => {
    const head = ['H'];
    const tail = ['T'];
    const middle = ['a'.repeat(300), 'b'.repeat(300), 'c'.repeat(300)];
    const out = budgetedJoin(head, middle, tail, 700);
    expect(out.startsWith('H\n\n')).toBe(true);
    expect(out.endsWith('\n\nT')).toBe(true);
    expect(out).toContain('a'.repeat(300));
    expect(out).toContain('more candidate'); // omission note
    expect(out).not.toContain('c'.repeat(300));
  });
  it('exports the 48k cap', () => {
    expect(MAX_PROMPT).toBe(48000);
  });
});
