// @vitest-environment jsdom
//
// The organization's name in the Rossum header, in a pill on the right, on every
// screen. jsdom has no layout, so every element the feature measures is given the box
// it had on a live Rossum page (2026-09-23).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rect } from './support/dom.js';

type Rect = [left: number, top: number, width: number, height: number];

// Measured boxes are written [left, top, width, height], as the live dump reported them.
function at<T extends Element>(el: T, [left, top, width, height]: Rect): T {
  const box = rect({ left, top, right: left + width, bottom: top + height });
  el.getBoundingClientRect = () => box;
  return el;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  rect: Rect,
  attrs: Record<string, string> = {},
) {
  const node = at(document.createElement(tag), rect);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function rightButtons(header: HTMLElement, chatLeft: number) {
  const buttons: [keyof HTMLElementTagNameMap, string, Rect][] = [
    ['button', 'chat-open-button', [chatLeft, 6, 36, 36]],
    ['button', 'help-panel-button', [1561, 6, 36, 36]],
    ['span', 'beamer-selector', [1613, 14, 20, 20]],
    ['button', 'userpanel', [1649, 4, 40, 40]],
  ];
  for (const [tag, cy, rect] of buttons) header.append(el(tag, rect, { 'data-cy': cy }));
}

// The documents list: logo and nav tabs on the left, then the right-hand buttons.
function documentsHeader({ chatLeft = 1517, poweredBy = false } = {}) {
  const header = el('header', [0, 0, 1705, 48]);
  const row = el('div', [100, 0, 685, 48]);
  const tabsRoot = el('div', [295, 0, 490, 48], { class: 'MuiTabs-root' });
  const tablist = el('div', [295, 0, 490, 48], { role: 'tablist', 'aria-label': 'nav-bar-tabs' });
  const tabs: [string, number, number][] = [
    ['documents', 295, 104],
    ['automation', 399, 105],
    ['extensions', 503, 101],
    ['statistics', 605, 90],
    ['settings', 695, 90],
  ];
  for (const [name, left, width] of tabs) {
    const tab = el('a', [left, 0, width, 48], { role: 'tab', 'data-cy': `${name}-navtab` });
    tab.textContent = name;
    tablist.append(tab);
  }
  tabsRoot.append(tablist);
  row.append(tabsRoot);
  header.append(row);
  if (poweredBy) {
    // Rossum's white-label branding, measured right beside the chat button.
    const brand = el('div', [1154, 13, 158, 22], { 'data-sentry-component': 'PoweredBy' });
    const logo = at(
      document.createElementNS('http://www.w3.org/2000/svg', 'svg'),
      [1154, 13, 22, 22],
    );
    const text = el('p', [1184, 14, 127, 19]);
    text.textContent = 'Powered by Rossum';
    brand.append(logo, text);
    header.append(brand);
  }
  rightButtons(header, chatLeft);
  document.body.append(header);
  return header;
}

// The document review screen: no nav tabs and no chip row — back button and file name
// on the left, paging in the centre, the same right-hand buttons.
function reviewHeader() {
  const header = el('header', [0, 0, 1516, 48]);
  const start = el('div', [8, 3, 574, 40], { 'data-cy': 'document-topbar-start' });
  start.append(el('button', [8, 5, 36, 36], { 'data-cy': 'exit-route-button' }));
  const fileName = el('span', [44, 11, 178, 24], { 'data-cy': 'file-name' });
  fileName.textContent = 'invoice.pdf';
  start.append(fileName);
  const center = el('div', [582, 3, 351, 40], { 'data-cy': 'document-topbar-center' });
  center.append(el('button', [749, 5, 36, 36]));
  header.append(start, center);
  const buttons: [keyof HTMLElementTagNameMap, string, Rect][] = [
    ['button', 'chat-open-button', [1336, 5, 36, 36]],
    ['button', 'help-panel-button', [1380, 5, 36, 36]],
    ['button', 'userpanel', [1468, 3, 40, 40]],
  ];
  for (const [tag, cy, rect] of buttons) header.append(el(tag, rect, { 'data-cy': cy }));
  document.body.append(header);
  return header;
}

// The API, per token. The organizations list holds the one organization the session
// is in; auth/user names the user's HOME organization, whose detail the session cannot
// read (404) — the shape of a service user on a dedicated cell, 2026-09-23.
let orgsByToken: Record<string, { id: number; name: string }[]> = {};
let holdList: Record<string, Promise<void>> = {};

function stubApi() {
  const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
  const orgUrl = (id: number) => `https://acme.rossum.app/api/v1/organizations/${id}`;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: any) => {
      const token = String(init?.headers?.Authorization ?? '').replace(/^Token /, '');
      const orgs = orgsByToken[token];
      if (!orgs) return { ok: false, status: 401, json: async () => ({}) };
      const path = new URL(url).pathname;
      if (path === '/api/v1/organizations') {
        await holdList[token];
        return json({ results: orgs.map((o) => ({ ...o, url: orgUrl(o.id) })) });
      }
      if (path === '/api/v1/auth/user') return json({ organization: orgUrl(3) });
      return { ok: false, status: 404, json: async () => ({ detail: 'Not found.' }) };
    }),
  );
}

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
  window.localStorage.setItem('secureToken', 'tok-a');
  orgsByToken = {
    'tok-a': [{ id: 7, name: 'Acme HQ - TEST' }],
    'tok-b': [{ id: 8, name: 'Acme HQ - PROD' }],
  };
  holdList = {};
  stubApi();
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
    expect(name.textContent).toBe('Acme HQ - TEST');
    expect(name.title).toBe('Acme HQ - TEST');
    // right = 1705 - 1517 + 12; maxWidth = (1517 - 12) - (785 + 12)
    expect(name.style.right).toBe('200px');
    expect(name.style.maxWidth).toBe('708px');
  });

  it("names the session's organization, not the user's home organization", async () => {
    // auth/user points at organization 3, which the session cannot read.
    documentsHeader();
    badge.init({ intervalMs: 0 });
    await flush();

    expect(pill()!.textContent).toBe('Acme HQ - TEST');
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
    // In a browser the pill's content is 150px wide: more than the 93px by the buttons.
    const name = pill()!;
    Object.defineProperty(name, 'scrollWidth', { configurable: true, value: 150 });
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

describe('Rossum branding', () => {
  it('gives "Powered by Rossum" room to the name once the name is known', async () => {
    documentsHeader({ poweredBy: true });
    badge.init({ intervalMs: 0 });
    await flush();

    expect(poweredBy().style.display).toBe('none');
    // The pill takes the gap the branding occupied: right = 1705 - 1517 + 12, as on an
    // unbranded header.
    const name = pill()!;
    expect(name.style.right).toBe('200px');
    expect(name.style.maxWidth).toBe('708px');
  });

  it('keeps the branding when the name would not fit even in its place', async () => {
    // The header never ends up saying less than Rossum shipped.
    const header = documentsHeader({ chatLeft: 800, poweredBy: true }); // 15px after the tabs
    header.append(el('img', [0, 0, 290, 48]));
    badge.init({ intervalMs: 0 });
    await flush();

    expect(shown(pill())).toBe(false);
    expect(poweredBy().style.display).toBe('');
  });

  it('leaves the branding alone while there is no name to replace it with', async () => {
    window.localStorage.setItem('secureToken', 'tok-unknown');
    documentsHeader({ poweredBy: true });
    badge.init({ intervalMs: 0 });
    await flush();

    expect(poweredBy().style.display).toBe('');
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
    expect(name.textContent).toBe('Acme HQ - TEST');
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
    expect(pill()!.textContent).toBe('Acme HQ - TEST');

    window.localStorage.setItem('secureToken', 'tok-b');
    await vi.advanceTimersByTimeAsync(1500);
    await flush();

    expect(pill()!.textContent).toBe('Acme HQ - PROD');
  });

  it('never lets a slow answer for the previous organization overwrite the current one', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    holdList['tok-a'] = new Promise<void>((r) => (release = r));
    documentsHeader();
    badge.init({ intervalMs: 1500 });
    await flush(); // the first organization is still in flight

    window.localStorage.setItem('secureToken', 'tok-b');
    await vi.advanceTimersByTimeAsync(1500);
    await flush();
    expect(pill()!.textContent).toBe('Acme HQ - PROD');

    release();
    await flush();
    expect(pill()!.textContent).toBe('Acme HQ - PROD');
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
