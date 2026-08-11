import { describe, it, expect } from 'vitest';
import { isValidApp, pickInitialApp, appAfterGateChange } from '../src/console/boot.js';

describe('academy in the app registry', () => {
  it('is a valid app', () => {
    expect(isValidApp('academy')).toBe(true);
  });

  it('is only picked on boot when training is unlocked', () => {
    expect(pickInitialApp({ persistedApp: 'academy', academyUnlocked: true })).toBe('academy');
    expect(pickInitialApp({ persistedApp: 'academy', academyUnlocked: false })).toBe('mdh');
    expect(pickInitialApp({ persistedApp: 'academy' })).toBe('mdh'); // default locked
  });

  it('keeps the existing fabry behaviour untouched', () => {
    expect(pickInitialApp({ persistedApp: 'fabry', fabryUnlocked: true })).toBe('fabry');
    expect(pickInitialApp({ persistedApp: 'fabry' })).toBe('mdh');
    expect(pickInitialApp({ stagingApp: 'audit', persistedApp: 'mdh' })).toBe('audit');
  });

  it('falls back to mdh when training re-locks while the Academy is open', () => {
    expect(appAfterGateChange('academy', false, false)).toBe('mdh');
    expect(appAfterGateChange('academy', false, true)).toBe('academy');
    expect(appAfterGateChange('fabry', false, true)).toBe('mdh');
    expect(appAfterGateChange('mdh', false, false)).toBe('mdh');
  });
});
