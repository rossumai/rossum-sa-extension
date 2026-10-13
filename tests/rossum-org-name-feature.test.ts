// @vitest-environment jsdom
//
// The organization's name in the Rossum header, in a pill on the right, on every
// screen. jsdom has no layout, so every element the feature measures is given the box
// it had on a live Rossum page (2026-09-23).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  at,
  documentsHeader,
  el,
  reviewHeader,
  rossumApi,
  stubRossumApi,
} from './support/rossumHeader.js';
import { rect } from './support/dom.js';

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const pill = () => document.querySelector<HTMLElement>('.rossum-sa-extension-org-name');
const poweredBy = () => document.querySelector<HTMLElement>('[data-sentry-component="PoweredBy"]')!;
const shown = (node: HTMLElement | null) => !!node && !node.hidden;

let badge: typeof import('../src/rossum/features/org-name.js');
let sendMessage: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.localStorage.setItem('secureToken', 'tok-a');
  rossumApi.orgsByToken = {
    'tok-a': [{ id: 7, name: 'Acme HQ - TEST' }],
    'tok-b': [{ id: 8, name: 'Acme HQ - PROD' }],
  };
  rossumApi.holdList = {};
  rossumApi.groups = {};
  rossumApi.holdGroup = {};
  stubRossumApi();
  sendMessage = vi.fn();
  globalThis.chrome = { runtime: { sendMessage } } as any;
  // Fresh module per test: the feature and the API cache both keep module state.
  badge = await import('../src/rossum/features/org-name.js');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the name pill', () => {
  it('names the organization in the gap left of the header buttons', async () => {
    const header = documentsHeader();
    badge.init({ intervalMs: 0 });
    await flush();

    const name = pill()!;
    expect(name.parentElement).toBe(header);
    expect(shown(name)).toBe(true);
    expect(name.textContent).toBe('Acme HQ - TEST: 7');
    expect(name.title).toBe('Acme HQ - TEST: 7');
    // right = 1705 - 1517 + 12; maxWidth = (1517 - 12) - (785 + 12)
    expect(name.style.right).toBe('200px');
    expect(name.style.maxWidth).toBe('708px');
  });

  it("names the session's organization, not the user's home organization", async () => {
    // auth/user points at organization 3, which the session cannot read.
    documentsHeader();
    badge.init({ intervalMs: 0 });
    await flush();

    expect(pill()!.textContent).toBe('Acme HQ - TEST: 7');
  });

  it('sits in the same place on the document review screen', async () => {
    reviewHeader();
    badge.init({ intervalMs: 0 });
    await flush();

    const name = pill()!;
    expect(shown(name)).toBe(true);
    // right = 1516 - 1336 + 12; maxWidth = (1336 - 12) - (785 + 12)
    expect(name.style.right).toBe('192px');
    expect(name.style.maxWidth).toBe('527px');
  });

  it('adds nothing next to the file names, in the list or on the review screen', async () => {
    // The document list's rows carry the same `data-cy="file-name"` hook as the review
    // screen's top bar.
    reviewHeader();
    const row = el('div', [0, 120, 1516, 40], { 'data-cy': 'document-row' });
    const rowName = el('span', [40, 130, 200, 20], { 'data-cy': 'file-name' });
    row.append(rowName);
    document.body.append(row);
    badge.init({ intervalMs: 0 });
    await flush();

    for (const name of document.querySelectorAll('[data-cy="file-name"]')) {
      expect(name.nextElementSibling).toBeNull();
    }
  });

  it('does not count its own pill as something in the way', async () => {
    documentsHeader();
    badge.init({ intervalMs: 0 });
    await flush();

    // In a browser the pill has a box, right in the gap it was given.
    const name = at(pill()!, [1105, 12, 400, 24]);
    window.dispatchEvent(new Event('resize'));

    expect(shown(name)).toBe(true);
    expect(name.style.maxWidth).toBe('708px');
  });

  it('moves left to show the whole name rather than cut it by the buttons', async () => {
    const header = documentsHeader();
    header.append(el('button', [1300, 6, 100, 36])); // leaves 1400–1517 by the buttons
    badge.init({ intervalMs: 0 });
    await flush();
    // In a browser the name is 150px wide: more than the 93px by the buttons.
    const name = pill()!;
    const text = name.querySelector('.rossum-sa-extension-org-name-text')!;
    Object.defineProperty(text, 'scrollWidth', { configurable: true, value: 150 });
    window.dispatchEvent(new Event('resize'));

    // The gap 785–1300 holds it: right = 1705 - 1300 + 12; maxWidth = (1300 - 12) - (785 + 12)
    expect(name.style.right).toBe('417px');
    expect(name.style.maxWidth).toBe('491px');
  });

  it('hides when the header has no room for it', async () => {
    const header = documentsHeader({ chatLeft: 800 }); // 15px after the last tab
    header.append(el('img', [0, 0, 290, 48])); // logo up to the tabs
    badge.init({ intervalMs: 0 });
    await flush();

    expect(shown(pill())).toBe(false);
  });
});

describe('the deployment location', () => {
  beforeEach(() => {
    rossumApi.orgsByToken['tok-a'] = [{ id: 7, name: 'Acme HQ - TEST', group: 12 }];
    rossumApi.orgsByToken['tok-b'] = [{ id: 8, name: 'Acme HQ - PROD', group: 13 }];
    rossumApi.groups = {
      12: { deployment_location: 'prod-eu2' },
      13: { deployment_location: 'prod-us2' },
    };
  });

  it('follows the id in brackets', async () => {
    documentsHeader();
    badge.init({ intervalMs: 0 });
    await flush();

    expect(pill()!.textContent).toBe('Acme HQ - TEST: 7 [eu2]');
  });

  it('is left out when the group cannot be read', async () => {
    rossumApi.groups = {};
    documentsHeader();
    badge.init({ intervalMs: 0 });
    await flush();

    expect(pill()!.textContent).toBe('Acme HQ - TEST: 7');
  });

  it('shows the name without waiting for the group', async () => {
    let release!: () => void;
    rossumApi.holdGroup[12] = new Promise<void>((r) => (release = r));
    documentsHeader();
    badge.init({ intervalMs: 0 });
    await flush();
    expect(pill()!.textContent).toBe('Acme HQ - TEST: 7');

    release();
    await flush();
    expect(pill()!.textContent).toBe('Acme HQ - TEST: 7 [eu2]');
  });

  it('is not asked for when the name is switched off', async () => {
    documentsHeader();
    badge.init({ intervalMs: 0, name: false, env: true });
    await flush();

    const paths = vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url)).pathname);
    expect(paths).toEqual(['/api/v1/organizations']);
  });

  it('never lets a slow answer for the previous organization label the current one', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    rossumApi.holdGroup[12] = new Promise<void>((r) => (release = r));
    documentsHeader();
    badge.init({ intervalMs: 1500 });
    await flush();

    window.localStorage.setItem('secureToken', 'tok-b');
    await vi.advanceTimersByTimeAsync(1500);
    await flush();
    release();
    await flush();

    expect(pill()!.textContent).toBe('Acme HQ - PROD: 8 [us2]');
  });
});

describe('the session cache', () => {
  // A full page reload: a fresh content script on the same tab, so the same sessionStorage.
  async function reload() {
    vi.resetModules();
    vi.mocked(fetch).mockClear();
    document.body.innerHTML = '';
    badge = await import('../src/rossum/features/org-name.js');
    documentsHeader();
    badge.init({ intervalMs: 0 });
    await flush();
  }

  beforeEach(() => {
    rossumApi.orgsByToken['tok-a'] = [{ id: 7, name: 'Acme HQ - TEST', group: 12 }];
    rossumApi.groups = { 12: { deployment_location: 'prod-eu2' } };
  });

  it('names the organization after a reload without asking the API again', async () => {
    documentsHeader();
    badge.init({ intervalMs: 0 });
    await flush();

    await reload();

    expect(fetch).not.toHaveBeenCalled();
    expect(pill()!.textContent).toBe('Acme HQ - TEST: 7 [eu2]');
  });

  it('asks again for another session token', async () => {
    documentsHeader();
    badge.init({ intervalMs: 0 });
    await flush();

    window.localStorage.setItem('secureToken', 'tok-b');
    await reload();

    expect(fetch).toHaveBeenCalled();
    expect(pill()!.textContent).toBe('Acme HQ - PROD: 8');
  });

  it('never keeps the token itself', async () => {
    documentsHeader();
    badge.init({ intervalMs: 0 });
    await flush();

    const stored = Object.entries(window.sessionStorage).flat().join(' ');
    expect(stored).toContain('Acme HQ - TEST');
    expect(stored).not.toContain('tok-a');
  });

  it('asks again after a day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    documentsHeader();
    badge.init({ intervalMs: 0 });
    await flush();

    vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
    await reload();

    expect(fetch).toHaveBeenCalled();
  });

  it('counts the day from the request, not from each reload', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    documentsHeader();
    badge.init({ intervalMs: 0 });
    await flush();

    vi.setSystemTime(start + 20 * 60 * 60 * 1000);
    await reload(); // served from the cache, and must not renew it
    expect(fetch).not.toHaveBeenCalled();

    vi.setSystemTime(start + 24 * 60 * 60 * 1000);
    await reload();
    expect(fetch).toHaveBeenCalled();
  });

  it('keeps one entry per tab, the current session’s', async () => {
    documentsHeader();
    badge.init({ intervalMs: 0 });
    await flush();

    window.localStorage.setItem('secureToken', 'tok-b');
    await reload();

    const keys = Object.keys(window.sessionStorage).filter((k) =>
      k.startsWith('rossum-sa-extension-org:'),
    );
    expect(keys).toHaveLength(1);
  });

  it('reads the cell once when the cache was written without it', async () => {
    // Cached while only the environment was on, which does not need the cell.
    documentsHeader();
    badge.init({ intervalMs: 0, name: false, env: true });
    await flush();

    await reload(); // the name is on now: the group is read, once
    expect(vi.mocked(fetch).mock.calls.map(([u]) => new URL(String(u)).pathname)).toEqual([
      '/api/v1/organization_groups/12',
    ]);
    expect(pill()!.textContent).toBe('Acme HQ - TEST: 7 [eu2]');

    await reload();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not ask again for a group that has no location', async () => {
    rossumApi.groups = { 12: {} };
    documentsHeader();
    badge.init({ intervalMs: 0 });
    await flush();

    await reload();
    expect(fetch).not.toHaveBeenCalled();
    expect(pill()!.textContent).toBe('Acme HQ - TEST: 7');
  });

  it('keeps the day of the first request when the cell is added later', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    documentsHeader();
    badge.init({ intervalMs: 0, name: false, env: true });
    await flush();

    vi.setSystemTime(start + 20 * 60 * 60 * 1000);
    await reload(); // adds the cell, and must not restart the day

    vi.setSystemTime(start + 24 * 60 * 60 * 1000);
    await reload();
    expect(vi.mocked(fetch).mock.calls.map(([u]) => new URL(String(u)).pathname)).toContain(
      '/api/v1/organizations',
    );
  });

  it('does not keep an organization whose name could not be read', async () => {
    window.localStorage.setItem('secureToken', 'tok-unknown');
    documentsHeader();
    badge.init({ intervalMs: 0 });
    await flush();

    expect(window.sessionStorage.length).toBe(0);
  });
});

describe('Rossum branding', () => {
  it('gives "Powered by Rossum" up to the name, closing its space', async () => {
    documentsHeader({ poweredBy: true });
    badge.init({ intervalMs: 0 });
    await flush();

    // Removed from the layout, so no hole is left between Rossum's buttons.
    expect(poweredBy().style.display).toBe('none');
    expect(poweredBy().style.visibility).toBe('');
    // right = 1705 - 1517 + 12, as on an unbranded header.
    const name = pill()!;
    expect(name.style.right).toBe('200px');
    expect(name.style.maxWidth).toBe('708px');
  });

  it('keeps the branding’s space when closing it would leave the name no room', async () => {
    // On a narrow header the right-hand buttons follow the branding rather than sit at
    // the edge: removing it slides them left, into the pill's gap. Measured that way there
    // is no room, so the branding keeps its space and the pill covers it — every tick
    // decides the same, where toggling `display` made the two swap each tick.
    const header = documentsHeader({ poweredBy: true });
    const brand = poweredBy();
    const chat = header.querySelector<HTMLElement>('[data-cy="chat-open-button"]')!;
    const collapsed = rect({ left: 790, top: 6, right: 826, bottom: 42 });
    const open = rect({ left: 1517, top: 6, right: 1553, bottom: 42 });
    chat.getBoundingClientRect = () => (brand.style.display === 'none' ? collapsed : open);
    badge.init({ intervalMs: 1500 });
    await flush();

    for (let tick = 0; tick < 3; tick++) {
      expect(shown(pill())).toBe(true);
      expect(brand.style.display).toBe('');
      expect(brand.style.visibility).toBe('hidden');
      window.dispatchEvent(new Event('resize'));
    }
  });

  it('keeps the branding when the name would not fit even in its place', async () => {
    // The header never ends up saying less than Rossum shipped.
    const header = documentsHeader({ chatLeft: 800, poweredBy: true }); // 15px after the tabs
    header.append(el('img', [0, 0, 290, 48]));
    badge.init({ intervalMs: 0 });
    await flush();

    expect(shown(pill())).toBe(false);
    expect(poweredBy().style.display).toBe('');
    expect(poweredBy().style.visibility).toBe('');
  });

  it('leaves the branding alone while there is no name to replace it with', async () => {
    window.localStorage.setItem('secureToken', 'tok-unknown');
    documentsHeader({ poweredBy: true });
    badge.init({ intervalMs: 0 });
    await flush();

    expect(poweredBy().style.display).toBe('');
    expect(poweredBy().style.visibility).toBe('');
  });

  it('gives the branding back when the name is lost', async () => {
    vi.useFakeTimers();
    documentsHeader({ poweredBy: true });
    badge.init({ intervalMs: 1500 });
    await flush();
    expect(poweredBy().style.display).toBe('none');

    window.localStorage.setItem('secureToken', 'tok-unknown');
    await vi.advanceTimersByTimeAsync(1500);
    await flush();

    expect(poweredBy().style.display).toBe('');
    expect(shown(pill())).toBe(false);
  });

  it('hides branding that renders after the name is known', async () => {
    const header = documentsHeader();
    badge.init({ intervalMs: 0 });
    await flush();

    const brand = el('div', [1154, 13, 158, 22], { 'data-sentry-component': 'PoweredBy' });
    header.append(brand);
    badge.handleNode(brand);

    expect(brand.style.display).toBe('none');
  });
});

describe('lifecycle', () => {
  it('decorates a header that renders after init', async () => {
    badge.init({ intervalMs: 0 });
    await flush();
    expect(pill()).toBeNull();

    const header = documentsHeader();
    // What the content script's MutationObserver does for an added subtree.
    for (const node of [header, ...header.querySelectorAll('*')])
      badge.handleNode(node as HTMLElement);

    const name = pill()!;
    expect(name.parentElement).toBe(header);
    expect(name.textContent).toBe('Acme HQ - TEST: 7');
  });

  it('comes back when the header remounts', async () => {
    documentsHeader();
    badge.init({ intervalMs: 0 });
    await flush();

    document.body.innerHTML = '';
    const header = documentsHeader();
    for (const node of [header, ...header.querySelectorAll('*')])
      badge.handleNode(node as HTMLElement);

    expect(shown(pill())).toBe(true);
  });

  it('decorates once, however often it is seen', async () => {
    const header = documentsHeader();
    badge.init({ intervalMs: 0 });
    for (let i = 0; i < 2; i++) {
      for (const node of [header, ...header.querySelectorAll('*')])
        badge.handleNode(node as HTMLElement);
    }
    await flush();

    expect(document.querySelectorAll('.rossum-sa-extension-org-name')).toHaveLength(1);
  });

  it('leaves alone a header that has no user panel', async () => {
    const other = document.createElement('header');
    other.append(document.createElement('button'));
    document.body.append(other);
    badge.init({ intervalMs: 0 });
    for (const node of [other, ...other.querySelectorAll('*')])
      badge.handleNode(node as HTMLElement);
    await flush();

    expect(pill()).toBeNull();
  });

  it('gives a static header a containing block for the pill', () => {
    const header = documentsHeader();
    badge.init({ intervalMs: 0 });

    expect(header.style.position).toBe('relative');
  });

  it('leaves an already positioned header as it is', () => {
    const header = documentsHeader();
    header.style.position = 'sticky';
    badge.init({ intervalMs: 0 });

    expect(header.style.position).toBe('sticky');
  });

  it('follows a switch to another organization', async () => {
    vi.useFakeTimers();
    documentsHeader();
    badge.init({ intervalMs: 1500 });
    await flush();
    expect(pill()!.textContent).toBe('Acme HQ - TEST: 7');

    window.localStorage.setItem('secureToken', 'tok-b');
    await vi.advanceTimersByTimeAsync(1500);
    await flush();

    expect(pill()!.textContent).toBe('Acme HQ - PROD: 8');
  });

  it('never lets a slow answer for the previous organization overwrite the current one', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    rossumApi.holdList['tok-a'] = new Promise<void>((r) => (release = r));
    documentsHeader();
    badge.init({ intervalMs: 1500 });
    await flush(); // the first organization is still in flight

    window.localStorage.setItem('secureToken', 'tok-b');
    await vi.advanceTimersByTimeAsync(1500);
    await flush();
    expect(pill()!.textContent).toBe('Acme HQ - PROD: 8');

    release();
    await flush();
    expect(pill()!.textContent).toBe('Acme HQ - PROD: 8');
  });

  it('draws nothing when the organization cannot be read', async () => {
    window.localStorage.setItem('secureToken', 'tok-unknown');
    documentsHeader();
    badge.init({ intervalMs: 0 });
    await flush();

    expect(shown(pill())).toBe(false);
  });

  it('makes no request without a session token', async () => {
    window.localStorage.removeItem('secureToken');
    documentsHeader();
    badge.init({ intervalMs: 0 });
    await flush();

    expect(fetch).not.toHaveBeenCalled();
    expect(shown(pill())).toBe(false);
  });

  it('reports the badge once per page, naming nothing about the organization', async () => {
    documentsHeader();
    badge.init({ intervalMs: 0 });
    await flush();
    window.dispatchEvent(new Event('resize'));
    await flush();

    const events = sendMessage.mock.calls.map(([m]) => m);
    expect(events).toEqual([{ type: 'sa-usage', name: 'sa_rossum_org_name' }]);
  });
});
