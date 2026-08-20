import { describe, it, expect } from 'vitest';
import { chatTitle, sanitizeTitle } from '../src/fabry/format.js';

describe('chatTitle', () => {
  it('summary > preview > first_message > placeholder', () => {
    expect(chatTitle({ summary: 's', preview: 'p', first_message: 'f' })).toBe('s');
    expect(chatTitle({ preview: 'p', first_message: 'f' })).toBe('p');
    expect(chatTitle({ first_message: 'f' })).toBe('f');
    expect(chatTitle({})).toBe('(empty chat)');
  });
});



describe('sanitizeTitle', () => {
  it('strips markdown noise from server summaries', () => {
    expect(sanitizeTitle('# Summary Cannot summarize without data')).toBe('Summary Cannot summarize without data');
    expect(sanitizeTitle('**Bold** `code` snake_case')).toBe('Bold code snake_case');
    expect(sanitizeTitle('  ## spaced   out  ')).toBe('spaced out');
  });
  it('chatTitle applies sanitization to the fallback chain', () => {
    expect(chatTitle({ summary: '# Summary X' })).toBe('Summary X');
  });
});
