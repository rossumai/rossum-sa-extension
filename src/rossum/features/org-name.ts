import { fetchRossumApiFresh } from '../api.js';
import { currentOrgName, pillSlot } from '../orgName.js';
import { trackOnce } from '../../usage/track.js';

// The organization's name in the Rossum header, on every screen — organizations in one
// group share a hostname and a white-labelled logo, and the user menu that names them
// is mounted only while it is open. A one-line pill sits just left of the header's
// buttons, placed by ../orgName.ts pillSlot. It carries its own ground and inherits no
// colour: the review screen's header is white but hands its children white text.
//
// Anchored on the `<header>` holding `[data-cy="userpanel"]`, the same on every screen.
// The pill is this extension's own node appended to it; React's children are never
// touched. "Powered by Rossum" makes way while the pill is on screen and comes back the
// moment it is not, so the header never says less than Rossum shipped. The token is
// re-read on an interval, so an organization switch re-resolves the name; a generation
// counter drops an answer for one already left behind.

const STYLE_ID = 'rossum-sa-extension-org-style';
const NAME_CLASS = 'rossum-sa-extension-org-name';
const POWERED_BY = '[data-sentry-component="PoweredBy"]';
// The header's right-hand buttons. Not all of them exist for every user, so the
// cluster's left edge is the leftmost one present.
const CLUSTER = ['chat-open-button', 'help-panel-button', 'beamer-selector', 'userpanel']
  .map((cy) => `[data-cy="${cy}"]`)
  .join(', ');
const CONTROL = 'a, button, input, select, textarea, img, svg, [role="tab"], [role="button"]';

let name: string | null = null;
let token: string | null = null;
let generation = 0;

function readToken(): string | null {
  try {
    return window.localStorage.getItem('secureToken');
  } catch {
    return null;
  }
}

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.${NAME_CLASS} {
  position: absolute; top: 50%; transform: translateY(-50%); z-index: 1;
  box-sizing: border-box; height: 24px; padding: 0 10px;
  border: 1px solid #c9ced6; border-radius: 12px; background: #f4f5f7;
  color: #1b2126; font-family: inherit; font-size: 12px; font-weight: 600; line-height: 22px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.${NAME_CLASS}[hidden] { display: none; }`;
  (document.head || document.documentElement)?.appendChild(style);
}

function headers(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`.${NAME_CLASS}`)]
    .map((pill) => pill.parentElement)
    .filter((h): h is HTMLElement => !!h);
}

const pillOf = (header: HTMLElement) =>
  header.querySelector<HTMLElement>(`:scope > .${NAME_CLASS}`);

function decorateHeader(header: HTMLElement) {
  if (!pillOf(header)) {
    // The pill is positioned against the header itself.
    const position = getComputedStyle(header).position;
    if (!position || position === 'static') header.style.position = 'relative';

    const pill = document.createElement('div');
    pill.className = NAME_CLASS;
    pill.hidden = true;
    header.append(pill);
  }
  renderHeader(header);
}

function renderHeader(header: HTMLElement) {
  const pill = pillOf(header);
  if (!pill) return;
  pill.textContent = name ?? '';
  pill.title = name ?? '';
  place(header, pill);
}

// Everything visible in the header that the pill must not cover: its controls, and any
// element carrying text of its own. The pill itself is excluded — it has a box right in
// its gap and would otherwise squeeze itself out — and so is the branding, whose gap is
// the pill's to take.
function obstacles(header: HTMLElement): DOMRect[] {
  const rects: DOMRect[] = [];
  for (const node of header.querySelectorAll('*')) {
    if (node.closest(`.${NAME_CLASS}, ${POWERED_BY}`)) continue;
    const ownText = [...node.childNodes].some(
      (n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim(),
    );
    if (ownText || node.matches(CONTROL)) rects.push(node.getBoundingClientRect());
  }
  return rects;
}

function place(header: HTMLElement, pill: HTMLElement) {
  const cluster = [...header.querySelectorAll(CLUSTER)]
    .map((b) => b.getBoundingClientRect())
    .filter((r) => r.width > 0);
  const slot =
    name && cluster.length
      ? pillSlot({
          header: header.getBoundingClientRect(),
          clusterLeft: Math.min(...cluster.map((r) => r.left)),
          obstacles: obstacles(header),
        })
      : null;
  pill.hidden = !slot;
  if (slot) {
    pill.style.right = `${slot.right}px`;
    pill.style.maxWidth = `${slot.maxWidth}px`;
  }
  // The branding makes way only for a pill that is actually on screen.
  for (const brand of header.querySelectorAll<HTMLElement>(POWERED_BY)) {
    brand.style.display = slot ? 'none' : '';
  }
}

function renderAll() {
  for (const header of headers()) renderHeader(header);
  if (name && headers().some((h) => !pillOf(h)!.hidden)) {
    // Once per page load, not per remount, and only when the name actually showed. The
    // event says the feature ran and nothing about the organization.
    trackOnce('sa_rossum_org_name');
  }
}

function placeAll() {
  for (const header of headers()) place(header, pillOf(header)!);
}

async function resolve() {
  token = readToken();
  const gen = ++generation;
  // The old name is wrong the moment the token changes; show nothing until the new one lands.
  name = null;
  renderAll();
  if (!token) return;
  let next: string | null = null;
  try {
    next = currentOrgName(await fetchRossumApiFresh('/api/v1/organizations', { ttlMs: 0 }));
  } catch {
    /* no name, no pill */
  }
  if (gen !== generation) return;
  name = next;
  renderAll();
}

function tick() {
  if (readToken() !== token) resolve();
  // The header's contents shift as the app renders (tabs, a late chat button).
  placeAll();
}

export function init({ intervalMs = 1500 } = {}) {
  injectStyle();
  const userpanel = document.querySelector<HTMLElement>('[data-cy="userpanel"]');
  if (userpanel) handleNode(userpanel);
  resolve();
  window.addEventListener('resize', placeAll);
  if (intervalMs > 0) setInterval(tick, intervalMs);
}

export function handleNode(node: HTMLElement): void {
  if (node.getAttribute?.('data-cy') === 'userpanel') {
    const header = node.closest('header');
    if (header) decorateHeader(header);
    return;
  }
  // The branding can render after the header: the setting behind it resolves late.
  if (node.matches?.(POWERED_BY)) {
    const header = node.closest('header');
    const pill = header && pillOf(header);
    if (header && pill) place(header, pill);
  }
}
