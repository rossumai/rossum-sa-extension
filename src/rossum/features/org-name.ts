import { fetchRossumApiFresh } from '../api.js';
import { CHIP_GAP, currentOrg, orgLabel, pillMinWidth, pillSlot, type Org } from '../orgName.js';
import { trackOnce } from '../../usage/track.js';

// The organization's name in the Rossum header, on every screen — organizations in one
// group share a hostname and a white-labelled logo, and the user menu that names them
// is mounted only while it is open. A one-line pill sits just left of the header's
// buttons, placed by ../orgName.ts pillSlot. It carries its own ground and inherits no
// colour: the review screen's header is white but hands its children white text.
//
// The environment is a second, independent switch drawn by the same pill: a Sandbox /
// Production chip before the name (or alone, with the name off), and a 2px line under the
// header in the chip's colour. Rossum draws its own Sandbox chip in the navbar's badge row
// and nothing for production; while ours says Sandbox, Rossum's is hidden — never moved,
// React owns that node — and it comes back whenever ours is not on screen.
//
// Anchored on the `<header>` holding `[data-cy="userpanel"]`, the same on every screen.
// The pill and the line are this extension's own nodes appended to it; React's children
// are never touched. "Powered by Rossum" makes way while the pill is on screen and comes
// back the moment it is not, so the header never says less than Rossum shipped. The
// token is re-read on an interval, so an organization switch re-resolves; a generation
// counter drops an answer for one already left behind.

const STYLE_ID = 'rossum-sa-extension-org-style';
const PILL_CLASS = 'rossum-sa-extension-org-name';
const TEXT_CLASS = 'rossum-sa-extension-org-name-text';
const CHIP_CLASS = 'rossum-sa-extension-org-chip';
const BAND_CLASS = 'rossum-sa-extension-org-band';
const POWERED_BY = '[data-sentry-component="PoweredBy"]';
const MUI_CHIP = '.MuiChip-root';
// The header's right-hand buttons. Not all of them exist for every user, so the
// cluster's left edge is the leftmost one present.
const CLUSTER = ['chat-open-button', 'help-panel-button', 'beamer-selector', 'userpanel']
  .map((cy) => `[data-cy="${cy}"]`)
  .join(', ');
const CONTROL = 'a, button, input, select, textarea, img, svg, [role="tab"], [role="button"]';

let org: Org | null = null;
let showName = true;
let showEnv = false;
let token: string | null = null;
let generation = 0;

function readToken(): string | null {
  try {
    return window.localStorage.getItem('secureToken');
  } catch {
    return null;
  }
}

// The chip copies Rossum's own: a 24px chip with a 13px mixed-case label. Sandbox takes
// Rossum's colours, sampled from the live navbar (#d5edf2 inside #70cce1); Production the
// same construction in red (#fde2e1 inside #f44336), with the same near-black text. The
// line takes each chip's border colour, the stronger of the two, so 2px still reads.
function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.${PILL_CLASS} {
  position: absolute; top: 50%; transform: translateY(-50%); z-index: 1;
  display: flex; align-items: center; gap: ${CHIP_GAP}px; min-width: 0;
}
.${TEXT_CLASS} {
  min-width: 0; box-sizing: border-box; height: 24px; padding: 0 10px;
  border: 1px solid #c9ced6; border-radius: 12px; background: #f4f5f7;
  color: #1b2126; font-family: inherit; font-size: 12px; font-weight: 600; line-height: 22px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.${CHIP_CLASS} {
  flex: none; display: inline-flex; align-items: center;
  box-sizing: border-box; height: 24px; padding: 0 8px; border: 1px solid; border-radius: 12px;
  color: #1b2126; font-family: inherit; font-size: 13px; line-height: 1; white-space: nowrap;
}
.${CHIP_CLASS}[data-env='sandbox'] { background: #d5edf2; border-color: #70cce1; }
.${CHIP_CLASS}[data-env='production'] { background: #fde2e1; border-color: #f44336; }
.${BAND_CLASS} {
  position: absolute; left: 0; right: 0; top: 100%; height: 2px; z-index: 1;
  pointer-events: none;
}
.${BAND_CLASS}[data-env='sandbox'] { background: #70cce1; }
.${BAND_CLASS}[data-env='production'] { background: #f44336; }
.${PILL_CLASS}[hidden], .${TEXT_CLASS}[hidden], .${CHIP_CLASS}[hidden],
.${BAND_CLASS}[hidden] { display: none; }`;
  (document.head || document.documentElement)?.appendChild(style);
}

function headers(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`.${PILL_CLASS}`)]
    .map((pill) => pill.parentElement)
    .filter((h): h is HTMLElement => !!h);
}

const pillOf = (header: HTMLElement) =>
  header.querySelector<HTMLElement>(`:scope > .${PILL_CLASS}`);

function decorateHeader(header: HTMLElement) {
  if (!pillOf(header)) {
    // The pill and the line are positioned against the header itself.
    const position = getComputedStyle(header).position;
    if (!position || position === 'static') header.style.position = 'relative';

    const pill = document.createElement('div');
    pill.className = PILL_CLASS;
    pill.hidden = true;
    const text = document.createElement('span');
    text.className = TEXT_CLASS;
    const chip = document.createElement('span');
    chip.className = CHIP_CLASS;
    pill.append(chip, text);

    const band = document.createElement('div');
    band.className = BAND_CLASS;
    band.hidden = true;
    header.append(pill, band);
  }
  renderHeader(header);
}

function renderHeader(header: HTMLElement) {
  const pill = pillOf(header);
  const band = header.querySelector<HTMLElement>(`:scope > .${BAND_CLASS}`);
  if (!pill || !band) return;
  const text = pill.querySelector<HTMLElement>(`.${TEXT_CLASS}`)!;
  const chip = pill.querySelector<HTMLElement>(`.${CHIP_CLASS}`)!;
  const env = org && showEnv ? (org.sandbox ? 'sandbox' : 'production') : null;
  text.hidden = !showName;
  text.textContent = org && showName ? orgLabel(org) : '';
  pill.title = text.textContent;
  chip.hidden = !env;
  chip.textContent = env === 'sandbox' ? 'Sandbox' : env ? 'Production' : '';
  band.hidden = !env;
  for (const node of [chip, band]) {
    if (env) node.dataset.env = env;
    else delete node.dataset.env;
  }
  place(header, pill);
}

// Rossum's own Sandbox chip: an MUI chip in the navbar's badge row — beside the nav tabs —
// labelled "Sandbox", or in MUI's info colour, since the label is translated in other UI
// languages (Developer mode is `colorWarning`). The row keeps other info chips out.
function isRossumSandboxChip(node: Element): boolean {
  if (!node.parentElement?.querySelector(':scope > .MuiTabs-root')) return false;
  const label = node.querySelector('.MuiChip-label')?.textContent?.trim();
  return label === 'Sandbox' || node.classList.contains('MuiChip-colorInfo');
}

// Hidden exactly while our pill is on screen saying Sandbox, and only then.
function renderRossumChip(node: HTMLElement) {
  const header = node.closest('header');
  const pill = header && pillOf(header);
  const ours = !!pill && !pill.hidden && !!org?.sandbox && showEnv;
  node.style.display = ours ? 'none' : '';
}

// Everything visible in the header that the pill must not cover: its controls, and any
// element carrying text of its own. The pill itself is excluded — it has a box right in
// its gap and would otherwise squeeze itself out — and so is the branding, whose gap is
// the pill's to take.
function obstacles(header: HTMLElement): DOMRect[] {
  const rects: DOMRect[] = [];
  for (const node of header.querySelectorAll('*')) {
    if (node.closest(`.${PILL_CLASS}, .${BAND_CLASS}, ${POWERED_BY}`)) continue;
    const ownText = [...node.childNodes].some(
      (n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim(),
    );
    if (ownText || node.matches(CONTROL)) rects.push(node.getBoundingClientRect());
  }
  return rects;
}

// The pill's width with the whole name shown. The name's scrollWidth measures the text
// past a max-width cut but not its border, so that is added back. Hidden parts measure 0,
// so the pill is shown for the (synchronous, unpainted) measurement.
function naturalWidth(pill: HTMLElement): { whole: number; least: number } {
  pill.hidden = false;
  const text = pill.querySelector<HTMLElement>(`.${TEXT_CLASS}`)!;
  const chip = pill.querySelector<HTMLElement>(`.${CHIP_CLASS}`)!;
  const chipWidth = chip.hidden ? 0 : chip.getBoundingClientRect().width;
  const name = text.hidden ? 0 : text.scrollWidth + (text.offsetWidth - text.clientWidth);
  const whole = name + (name && chipWidth ? CHIP_GAP : 0) + chipWidth;
  return { whole, least: pillMinWidth({ nameShown: !text.hidden, chipWidth, whole }) };
}

function findSlot(header: HTMLElement, pill: HTMLElement) {
  const cluster = [...header.querySelectorAll(CLUSTER)]
    .map((b) => b.getBoundingClientRect())
    .filter((r) => r.width > 0);
  if (!cluster.length) return null;
  const width = naturalWidth(pill);
  return pillSlot({
    header: header.getBoundingClientRect(),
    clusterLeft: Math.min(...cluster.map((r) => r.left)),
    obstacles: obstacles(header),
    nameWidth: width.whole,
    minWidth: width.least,
  });
}

// "Powered by Rossum" makes way only for a pill that is actually on screen. Each placement
// first measures with the branding REMOVED (`display: none`), so its space closes and no
// hole is left between Rossum's buttons. On a narrow header the buttons follow the
// branding instead of sitting at the edge, and removing it slides them into the pill's
// gap; when that leaves no room, the branding keeps its space (`visibility: hidden`) and
// the pill covers it. Every placement measures in this same order, so the result is
// stable — toggling one of the two by the other's outcome made them swap each tick.
function place(header: HTMLElement, pill: HTMLElement) {
  const brands = [...header.querySelectorAll<HTMLElement>(POWERED_BY)];
  const style = (display: string, visibility: string) => {
    for (const brand of brands) {
      brand.style.display = display;
      brand.style.visibility = visibility;
    }
  };
  // Nothing to show: no pill, and no layout to measure.
  const shows = !!org && (showName || showEnv);
  style(shows ? 'none' : '', '');
  let slot = shows ? findSlot(header, pill) : null;
  if (shows && !slot && brands.length) {
    style('', '');
    slot = findSlot(header, pill);
    if (slot) style('', 'hidden');
  }
  pill.hidden = !slot;
  if (slot) {
    pill.style.right = `${slot.right}px`;
    pill.style.maxWidth = `${slot.maxWidth}px`;
  }
  if (!showEnv) return;
  for (const chip of header.querySelectorAll<HTMLElement>(MUI_CHIP)) {
    if (isRossumSandboxChip(chip)) renderRossumChip(chip);
  }
}

function renderAll() {
  for (const header of headers()) renderHeader(header);
  // Once per page load, not per remount, and only when something actually showed: the
  // name in the pill, the environment in the chip or the line, which draws even when the
  // pill has no room. The events say which feature ran and nothing about the organization.
  if (!org || !headers().length) return;
  if (showName && headers().some((h) => !pillOf(h)!.hidden)) trackOnce('sa_rossum_org_name');
  if (showEnv) trackOnce('sa_rossum_org_env');
}

function placeAll() {
  for (const header of headers()) place(header, pillOf(header)!);
}

async function resolve() {
  token = readToken();
  const gen = ++generation;
  // The old organization is wrong the moment the token changes; show nothing until the
  // new one lands.
  org = null;
  renderAll();
  if (!token) return;
  let next: Org | null = null;
  try {
    next = currentOrg(await fetchRossumApiFresh('/api/v1/organizations', { ttlMs: 0 }));
  } catch {
    /* no organization, no pill */
  }
  if (gen !== generation) return;
  org = next;
  renderAll();
}

function tick() {
  if (readToken() !== token) resolve();
  // The header's contents shift as the app renders (tabs, a late chat button).
  placeAll();
}

export function init({ intervalMs = 1500, name = true, env = false } = {}) {
  showName = name;
  showEnv = env;
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
  // Both can render after the header: the settings behind them resolve late.
  if (showEnv && node.matches?.(MUI_CHIP) && node.closest('header') && isRossumSandboxChip(node)) {
    renderRossumChip(node);
    return;
  }
  if (node.matches?.(POWERED_BY)) {
    const header = node.closest('header');
    const pill = header && pillOf(header);
    if (header && pill) place(header, pill);
  }
}
