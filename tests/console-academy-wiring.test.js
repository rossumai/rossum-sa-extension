import { describe, it, expect } from 'vitest';
import { isValidApp, pickInitialApp, appAfterGateChange } from '../src/console/boot.js';

describe('academy in the app registry', () => {
  it('is a valid app', () => {
    expect(isValidApp('academy')).toBe(true);
  });

  it('is only picked on boot when the experimental gate is unlocked', () => {
    expect(pickInitialApp({ persistedApp: 'academy', unlocked: true })).toBe('academy');
    expect(pickInitialApp({ persistedApp: 'academy', unlocked: false })).toBe('mdh');
  });

  // The default is LOCKED on purpose: a caller that forgets the flag must HIDE
  // the Academy, never reveal it. This is the whole reason the parameter has a
  // default at all.
  it('defaults to locked when the flag is omitted entirely', () => {
    expect(pickInitialApp({ persistedApp: 'academy' })).toBe('mdh');
    expect(pickInitialApp({ stagingApp: 'academy' })).toBe('mdh');
  });

  it('falls back to mdh when the gate re-locks while the Academy is open', () => {
    expect(appAfterGateChange('academy', false)).toBe('mdh');
    expect(appAfterGateChange('academy', true)).toBe('academy');
    expect(appAfterGateChange('mdh', false)).toBe('mdh');
  });

  it('leaves staging-app precedence intact', () => {
    expect(pickInitialApp({ stagingApp: 'audit', persistedApp: 'mdh' })).toBe('audit');
  });
});
