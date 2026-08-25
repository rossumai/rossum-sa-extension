import { describe, it, expect } from 'vitest';
import { createUnlockCounter } from '../src/popup/experimental.js';

// Deterministic clock: each call to tick(ms) advances; now() reads it.
function clock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    tick: (ms: any) => {
      t += ms;
    },
  };
}

describe('createUnlockCounter', () => {
  it('returns true on the 5th quick click, then resets', () => {
    const c = clock();
    const u = createUnlockCounter({ now: c.now });
    for (let i = 0; i < 4; i++) {
      expect(u.click()).toBe(false);
      c.tick(200);
    }
    expect(u.click()).toBe(true); // 5th click flips
    expect(u.click()).toBe(false); // streak restarted — 1st of the next round
  });

  it('resets the streak after the inactivity window', () => {
    const c = clock();
    const u = createUnlockCounter({ now: c.now });
    for (let i = 0; i < 4; i++) {
      u.click();
      c.tick(200);
    }
    c.tick(2500); // > 2s pause — streak is stale
    expect(u.click()).toBe(false); // this is click 1, not click 5
    for (let i = 0; i < 3; i++) {
      c.tick(200);
      expect(u.click()).toBe(false);
    }
    c.tick(200);
    expect(u.click()).toBe(true);
  });

  it('supports flipping again (re-lock) with another full streak', () => {
    const c = clock();
    const u = createUnlockCounter({ now: c.now });
    const flips = [];
    for (let i = 0; i < 10; i++) {
      if (u.click()) flips.push(i);
      c.tick(100);
    }
    expect(flips).toEqual([4, 9]); // 5th and 10th clicks
  });

  it('honors custom threshold and window', () => {
    const c = clock();
    const u = createUnlockCounter({ threshold: 2, windowMs: 50, now: c.now });
    expect(u.click()).toBe(false);
    c.tick(60); // outside the window — streak reset
    expect(u.click()).toBe(false);
    c.tick(10);
    expect(u.click()).toBe(true);
  });
});
