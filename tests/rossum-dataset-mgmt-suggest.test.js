// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isMdhWebApp, init } from '../src/rossum/features/dataset-mgmt-suggest.js';

const BANNER = '#rossum-sa-extension-dm-suggest-banner';
const MDH_PATH = '/svc/master-data-hub/web/management';

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  window.localStorage.clear();
  window.sessionStorage.clear();
  globalThis.chrome = { runtime: { sendMessage: vi.fn() } };
});

describe('isMdhWebApp', () => {
  it('matches the legacy MDH web app path only', () => {
    expect(isMdhWebApp('/svc/master-data-hub/web/management')).toBe(true);
    expect(isMdhWebApp('/svc/master-data-hub/web/datasets/x')).toBe(true);
    expect(isMdhWebApp('/document/123')).toBe(false);
    expect(isMdhWebApp('/svc/master-data-hub/api/v2/operation/')).toBe(false);
    expect(isMdhWebApp('')).toBe(false);
    expect(isMdhWebApp(null)).toBe(false);
  });
});

describe('dataset-mgmt-suggest banner', () => {
  it('injects the banner on the MDH web app path', () => {
    init({ pathname: MDH_PATH });
    expect(document.querySelector(BANNER)).not.toBeNull();
    expect(document.querySelector(BANNER).textContent).toContain('Dataset Management');
    expect(document.querySelector(BANNER).textContent).not.toMatch(/deprecat/i);
  });

  it('does nothing on non-MDH pages', () => {
    init({ pathname: '/document/123' });
    expect(document.querySelector(BANNER)).toBeNull();
  });

  it('does not inject twice', () => {
    init({ pathname: MDH_PATH });
    init({ pathname: MDH_PATH });
    expect(document.querySelectorAll(BANNER)).toHaveLength(1);
  });

  it('the Open button sends the token + origin to the background worker', () => {
    window.localStorage.setItem('secureToken', 'tok123');
    init({ pathname: MDH_PATH });

    document.querySelector('.rossum-sa-extension-dm-open').click();

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'openDatasetManagement',
      token: 'tok123',
      domain: window.location.origin,
    });
  });

  it('has a close button that removes the banner', () => {
    init({ pathname: MDH_PATH });
    const close = document.querySelector('.rossum-sa-extension-dm-close');
    expect(close).not.toBeNull();
    close.click();
    expect(document.querySelector(BANNER)).toBeNull();
  });

  it('stays dismissed for the session — does not re-inject after closing', () => {
    init({ pathname: MDH_PATH });
    document.querySelector('.rossum-sa-extension-dm-close').click();
    expect(window.sessionStorage.getItem('rossum-sa-extension-dm-suggest-dismissed')).toBe('1');
    // Re-running init (e.g. another page load this session) must not bring it back.
    init({ pathname: MDH_PATH });
    expect(document.querySelector(BANNER)).toBeNull();
  });

  it('shows again in a fresh session (sessionStorage cleared)', () => {
    window.sessionStorage.setItem('rossum-sa-extension-dm-suggest-dismissed', '1');
    init({ pathname: MDH_PATH });
    expect(document.querySelector(BANNER)).toBeNull(); // suppressed while flag set
    window.sessionStorage.clear();
    init({ pathname: MDH_PATH });
    expect(document.querySelector(BANNER)).not.toBeNull(); // returns once the flag is gone
  });
});
