// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TAB_SCOPED_KEYS, resolveTabState, writeTabState } from '../src/console/tabState.js';

let store: any;
beforeEach(() => {
  sessionStorage.clear();
  store = {};
  globalThis.chrome = ({
    storage: { local: { set: vi.fn((obj) => { Object.assign(store, obj); return Promise.resolve(); }) } } as any,
  } as any);
});

describe('TAB_SCOPED_KEYS', () => {
  it('lists exactly the eight navigation keys', () => {
    expect([...TAB_SCOPED_KEYS].sort()).toEqual(
      ['consoleActiveApp', 'fabryActiveChat', 'fabryArchitectActive', 'fabryMode', 'mdhActivePanel', 'mdhActiveView', 'mdhOpsSearch', 'mdhSelectedCollection'],
    );
  });
});

describe('resolveTabState', () => {
  it('prefers the sessionStorage value over the local seed', () => {
    sessionStorage.setItem('mdhSelectedCollection', JSON.stringify('B'));
    const out = resolveTabState(['mdhSelectedCollection'], { mdhSelectedCollection: 'A' });
    expect(out.mdhSelectedCollection).toBe('B');
  });

  it('falls back to the local seed when no session value', () => {
    const out = resolveTabState(['mdhActiveView'], { mdhActiveView: 'overview' });
    expect(out.mdhActiveView).toBe('overview');
  });

  it('returns undefined when neither session nor local has the key', () => {
    const out = resolveTabState(['mdhActivePanel'], {});
    expect(out.mdhActivePanel).toBeUndefined();
  });

  it('falls back to local when the session value is corrupt JSON', () => {
    sessionStorage.setItem('mdhOpsSearch', '{not json');
    const out = resolveTabState(['mdhOpsSearch'], { mdhOpsSearch: 'seed' });
    expect(out.mdhOpsSearch).toBe('seed');
  });
});

describe('writeTabState', () => {
  it('writes the value to BOTH sessionStorage (JSON) and chrome.storage.local (native)', () => {
    writeTabState('consoleActiveApp', 'galaxy');
    expect(JSON.parse(sessionStorage.getItem('consoleActiveApp')!)).toBe('galaxy');
    expect(store.consoleActiveApp).toBe('galaxy');
  });

  it('never throws when chrome.storage is unavailable', () => {
    delete (globalThis as any).chrome;
    expect(() => writeTabState('mdhActiveView', 'collection')).not.toThrow();
    expect(JSON.parse(sessionStorage.getItem('mdhActiveView')!)).toBe('collection');
  });
});
