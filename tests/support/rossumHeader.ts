// The Rossum header as the org-name and org-env features see it, measured on a live
// page (2026-09-23), plus a stub of the one API they call. jsdom has no layout, so
// every element the features measure carries the box it had in the browser.
import { vi } from 'vitest';
import { rect } from './dom.js';

type Rect = [left: number, top: number, width: number, height: number];

// Measured boxes are written [left, top, width, height], as the live dump reported them.
export function at<T extends Element>(el: T, [left, top, width, height]: Rect): T {
  const box = rect({ left, top, right: left + width, bottom: top + height });
  el.getBoundingClientRect = () => box;
  return el;
}

export function el<K extends keyof HTMLElementTagNameMap>(
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

// The documents list: logo, the badge row (Rossum's own chips, by label, then the nav
// tabs), and the right-hand buttons.
export function documentsHeader({
  chatLeft = 1517,
  poweredBy = false,
  chips = [] as string[],
} = {}) {
  const header = el('header', [0, 0, 1705, 48]);
  const row = el('div', [100, 0, 685, 48], { class: 'badge-row' });
  for (const label of chips) {
    // MUI renders Rossum's Sandbox chip in `info`, its Developer mode chip in `warning`.
    const colour = label === 'Developer mode' ? 'MuiChip-colorWarning' : 'MuiChip-colorInfo';
    const chip = el('div', [110, 12, 80, 24], { class: `MuiChip-root ${colour}` });
    const text = document.createElement('span');
    text.className = 'MuiChip-label';
    text.textContent = label;
    chip.append(text);
    row.append(chip);
  }
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
export function reviewHeader() {
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
// Set per test; `holdList[token]` delays that token's answer until the promise settles.
export const rossumApi: {
  orgsByToken: Record<string, { id: number; name: string; sandbox?: boolean }[]>;
  holdList: Record<string, Promise<void>>;
} = { orgsByToken: {}, holdList: {} };

export function stubRossumApi() {
  const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
  const orgUrl = (id: number) => `https://acme.rossum.app/api/v1/organizations/${id}`;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: any) => {
      const token = String(init?.headers?.Authorization ?? '').replace(/^Token /, '');
      const orgs = rossumApi.orgsByToken[token];
      if (!orgs) return { ok: false, status: 401, json: async () => ({}) };
      const path = new URL(url).pathname;
      if (path === '/api/v1/organizations') {
        await rossumApi.holdList[token];
        return json({ results: orgs.map((o) => ({ ...o, url: orgUrl(o.id) })) });
      }
      if (path === '/api/v1/auth/user') return json({ organization: orgUrl(3) });
      return { ok: false, status: 404, json: async () => ({ detail: 'Not found.' }) };
    }),
  );
}
