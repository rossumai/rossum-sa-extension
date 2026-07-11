import { describe, it, expect } from 'vitest';
import {
  isValidApp,
  pickInitialApp,
  resolveBootAuth,
  computeStaleAuthRemovals,
  appAfterGateChange,
} from '../src/console/boot.js';

describe('isValidApp', () => {
  it('accepts known apps only', () => {
    expect(isValidApp('mdh')).toBe(true);
    expect(isValidApp('audit')).toBe(true);
    expect(isValidApp('galaxy')).toBe(true);
    expect(isValidApp('nope')).toBe(false);
    expect(isValidApp(undefined)).toBe(false);
  });
});

describe('pickInitialApp', () => {
  it('prefers a valid staging app (popup button wins)', () => {
    expect(pickInitialApp({ stagingApp: 'audit', persistedApp: 'mdh' })).toBe('audit');
  });
  it('falls back to the persisted app when no staging app', () => {
    expect(pickInitialApp({ persistedApp: 'audit' })).toBe('audit');
  });
  it('defaults to mdh when neither is valid', () => {
    expect(pickInitialApp({ stagingApp: 'x', persistedApp: 'y' })).toBe('mdh');
    expect(pickInitialApp({})).toBe('mdh');
  });
});

describe('resolveBootAuth', () => {
  it('consumes a staging entry and carries app + pipeline prefill', () => {
    const out = resolveBootAuth({
      entry: { token: 't', domain: 'd', app: 'audit', pendingCollection: 'invoices', pendingPipeline: '[]' },
      session: { token: null, domain: null },
    });
    expect(out).toEqual({
      token: 't',
      domain: 'd',
      stagingApp: 'audit',
      consumeKey: true,
      pendingCtx: { pendingCollection: 'invoices', pendingPipeline: '[]', pendingVariables: undefined },
    });
  });
  it('resolveBootAuth carries pendingVariableTypes from the staging entry', () => {
    const entry = {
      token: 't', domain: 'd', app: 'mdh',
      pendingCollection: 'C', pendingPipeline: '[]',
      pendingVariables: { cust: '21199417' },
      pendingVariableTypes: { cust: 'string' },
    };
    const r = resolveBootAuth({ entry, session: {} });
    expect(r.pendingCtx.pendingVariableTypes).toEqual({ cust: 'string' });
  });
  it('falls back to the session token/domain on reload', () => {
    const out = resolveBootAuth({
      entry: null,
      session: { token: 'st', domain: 'sd' },
    });
    expect(out).toEqual({
      token: 'st',
      domain: 'sd',
      stagingApp: undefined,
      consumeKey: false,
      pendingCtx: {},
    });
  });
});

describe('computeStaleAuthRemovals', () => {
  const TTL = 24 * 60 * 60 * 1000;
  it('removes expired consoleAuth_ entries and keeps fresh ones', () => {
    const now = 1_000_000_000;
    const all = {
      consoleAuth_fresh: { createdAt: now - 1000 },
      consoleAuth_old: { createdAt: now - TTL - 1 },
      consoleAuth_bad: { token: 'x' }, // no createdAt
      consoleActiveApp: 'mdh',
    };
    expect(computeStaleAuthRemovals(all, now, TTL).sort()).toEqual(
      ['consoleAuth_bad', 'consoleAuth_old'],
    );
  });
  it('sweeps orphaned old-build keys', () => {
    const now = 1_000_000_000;
    const all = {
      mdhAuth_x: { token: 'a' },
      auditAuth_y: { token: 'b' },
      mdhToken: 'leaked',
      mdhDomain: 'leaked',
      consoleActiveApp: 'audit',
    };
    expect(computeStaleAuthRemovals(all, now, TTL).sort()).toEqual(
      ['auditAuth_y', 'mdhAuth_x', 'mdhDomain', 'mdhToken'],
    );
  });
});

describe('fabry experimental gate', () => {
  it('isValidApp accepts fabry', () => {
    expect(isValidApp('fabry')).toBe(true);
  });
  it('pickInitialApp only yields fabry when unlocked', () => {
    expect(pickInitialApp({ persistedApp: 'fabry', fabryUnlocked: true })).toBe('fabry');
    expect(pickInitialApp({ persistedApp: 'fabry', fabryUnlocked: false })).toBe('mdh');
    expect(pickInitialApp({ persistedApp: 'fabry' })).toBe('mdh'); // default locked (older callers)
    expect(pickInitialApp({ stagingApp: 'fabry', persistedApp: 'audit', fabryUnlocked: false })).toBe('audit');
  });
  it('appAfterGateChange kicks an active fabry back to mdh on re-lock', () => {
    expect(appAfterGateChange('fabry', false)).toBe('mdh');
    expect(appAfterGateChange('fabry', true)).toBe('fabry');
    expect(appAfterGateChange('audit', false)).toBe('audit');
  });
});
