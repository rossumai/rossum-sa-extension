// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initDevFlags } from '../src/rossum/features/dev-flags.js';

function installChromeMock() {
  const listeners = [];
  globalThis.chrome = {
    runtime: {
      onMessage: {
        addListener: (fn) => listeners.push(fn),
      },
    },
  };
  return {
    dispatch(message) {
      return new Promise((resolve) => {
        // Emulate the Chrome extension message bus: invoke each registered
        // listener with (message, sender, sendResponse).
        for (const fn of listeners) fn(message, {}, resolve);
      });
    },
  };
}

describe('dev-flags message handlers', () => {
  let bus;

  beforeEach(() => {
    window.localStorage.clear();
    bus = installChromeMock();
    // Rewrite window.location.origin only if supported; jsdom default is fine.
    initDevFlags();
  });

  it('get-auth-info returns token and origin', async () => {
    window.localStorage.setItem('secureToken', 'xyz');
    const response = await bus.dispatch('get-auth-info');
    expect(response.token).toBe('xyz');
    expect(typeof response.domain).toBe('string');
    expect(response.domain).toBe(window.location.origin);
  });

  it('get-auth-info returns null token when not set', async () => {
    const response = await bus.dispatch('get-auth-info');
    expect(response.token).toBeNull();
  });

  it('get-dev-features-enabled-value reports false by default', async () => {
    const response = await bus.dispatch('get-dev-features-enabled-value');
    expect(response).toBe(false);
  });

  it('toggle-dev-features-enabled flips the localStorage flag on and off', async () => {
    await bus.dispatch('toggle-dev-features-enabled');
    expect(window.localStorage.getItem('devFeaturesEnabled')).toBe('true');
    expect(await bus.dispatch('get-dev-features-enabled-value')).toBe(true);

    await bus.dispatch('toggle-dev-features-enabled');
    expect(window.localStorage.getItem('devFeaturesEnabled')).toBeNull();
    expect(await bus.dispatch('get-dev-features-enabled-value')).toBe(false);
  });

  it('toggle-dev-debug-enabled flips the dev debug flag independently', async () => {
    await bus.dispatch('toggle-dev-debug-enabled');
    expect(window.localStorage.getItem('devDebugEnabled')).toBe('true');
    expect(await bus.dispatch('get-dev-debug-enabled-value')).toBe(true);

    await bus.dispatch('toggle-dev-debug-enabled');
    expect(await bus.dispatch('get-dev-debug-enabled-value')).toBe(false);
    // Toggling debug must not flip dev-features.
    expect(await bus.dispatch('get-dev-features-enabled-value')).toBe(false);
  });

  it('ignores unknown messages without throwing', async () => {
    // No handler; sendResponse is never called, so dispatch resolves never —
    // we just verify the synchronous listener loop does not throw.
    expect(() => {
      const listeners = [];
      globalThis.chrome = { runtime: { onMessage: { addListener: (fn) => listeners.push(fn) } } };
      initDevFlags();
      listeners[0]('unknown-message', {}, () => {});
    }).not.toThrow();
  });
});
