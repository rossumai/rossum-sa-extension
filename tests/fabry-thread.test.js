import { describe, it, expect } from 'vitest';
import { normalizeMessages, personaOf, serverMessageIndex } from '../src/fabry/thread.js';

describe('normalizeMessages', () => {
  it('maps string and content-part messages, marking slash turns as chips', () => {
    const turns = normalizeMessages([
      { role: 'user', content: '/persona cautious' },
      { role: 'assistant', content: 'Persona set.' },
      { role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image', media_type: 'image/png', data: 'AAA=' }] },
      { role: 'assistant', content: 'An invoice.', feedback: true },
    ]);
    expect(turns[0]).toMatchObject({ role: 'user', chip: true, command: true, text: '/persona cautious' });
    expect(turns[2]).toMatchObject({ role: 'user', chip: false, command: false, text: 'what is this?' });
    expect(turns[2].images).toEqual([{ media_type: 'image/png', data: 'AAA=' }]);
    expect(turns[3].feedback).toBe(true);
    expect(turns[1].feedback).toBe(null);
  });
});

describe('reviewer turns (deep verify)', () => {
  const msgs = [
    { role: 'user', content: '/persona cautious' },          // 0 command chip (stripped server-side)
    { role: 'assistant', content: 'Persona set.' },           // 1 command ack (stripped server-side)
    { role: 'user', content: 'question' },                    // 2 → server idx 0
    { role: 'assistant', content: 'answer v1' },              // 3 → server idx 1
    { role: 'user', content: '[deep-verify reviewer] fix:' }, // 4 → server idx 2 (STORED by server)
    { role: 'assistant', content: 'answer v2' },              // 5 → server idx 3
  ];
  it('reviewer messages are chips for display but NOT commands', () => {
    const t = normalizeMessages(msgs);
    expect(t[4]).toMatchObject({ chip: true, command: false });
    expect(t[0]).toMatchObject({ chip: true, command: true });
  });
  it('serverMessageIndex counts reviewer turns and their replies', () => {
    const t = normalizeMessages(msgs);
    expect(serverMessageIndex(t, 3)).toBe(1);
    expect(serverMessageIndex(t, 4)).toBe(2);  // reviewer turn is feedback-addressable
    expect(serverMessageIndex(t, 5)).toBe(3);  // the corrected answer
    expect(serverMessageIndex(t, 0)).toBe(-1); // command still excluded
    expect(serverMessageIndex(t, 1)).toBe(-1); // command ack still excluded
  });
});

describe('personaOf', () => {
  it('last /persona chip wins; null when none', () => {
    const t = normalizeMessages([
      { role: 'user', content: '/persona cautious' },
      { role: 'user', content: '/persona default' },
    ]);
    expect(personaOf(t)).toBe('default');
    expect(personaOf([])).toBe(null);
  });
});

describe('serverMessageIndex', () => {
  it('plain thread: client indices map 1:1 to server indices', () => {
    const t = normalizeMessages([
      { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' },
    ]);
    expect(serverMessageIndex(t, 1)).toBe(1);
    expect(serverMessageIndex(t, 3)).toBe(3);
  });

  it('primed thread: chip + ack are excluded, later turns shift down', () => {
    const t = normalizeMessages([
      { role: 'user', content: '/persona cautious' }, { role: 'assistant', content: 'Persona set.' },
      { role: 'user', content: 'q' }, { role: 'assistant', content: 'a' },
    ]);
    expect(serverMessageIndex(t, 3)).toBe(1);
    expect(serverMessageIndex(t, 1)).toBe(-1); // ack
    expect(serverMessageIndex(t, 0)).toBe(-1); // chip
  });

  it('chip mid-conversation: only the chip+ack pair is excluded', () => {
    const t = normalizeMessages([
      { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' },
      { role: 'user', content: '/persona cautious' }, { role: 'assistant', content: 'Persona set.' },
      { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' },
    ]);
    expect(serverMessageIndex(t, 5)).toBe(3);
  });
});
