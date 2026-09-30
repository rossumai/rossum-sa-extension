import { fetchRossumApi } from '../api.js';
import { trackOnce } from '../../usage/track.js';

// The organization's name in the navbar, immediately after the logo.
//
// Organizations in one organization group share a hostname, so the URL never
// says which one you are looking at, and the logo does not either — it is
// white-labelled per customer, so every org in a group shows the SAME logo. The
// name is the only thing that differs, which is why it goes right there, where a
// tenant name is normally read first.
//
// Anchored on the nav tabs (`[aria-label="nav-bar-tabs"]`, which MUI puts on the
// tablist rather than the Tabs root), because every organization has them. An
// earlier version hung off Rossum's "Developer mode" chip and was invisible on
// most orgs. That chip says the developer-mode toggle is on, revealing extra
// features — it is NOT an environment, and it is independent of
// `organization.sandbox` (owner, 2026-09-24). The bundle's tooltip calls it "a
// dev environment", which is misleading.
//
// `.closest('.MuiTabs-root').parentElement` is the badge row Stack — the one
// holding [Sandbox / Developer mode chips][Tabs] — so prepending puts the name
// before the chips and after the logo, with the row's own 16px gap on each side.
//
// Styling is inline and colourless on purpose: `currentColor` at reduced opacity
// takes whatever the navbar's own theme gives it, so this ships no stylesheet and
// cannot fall out of step with a Rossum palette change. The width is capped
// because the left group does NOT shrink (`flexShrink: 0` in NavBar.tsx), so an
// unbounded name pushes the tabs off the bar on a narrow window; 220px holds
// about 30 characters and the full name stays available on hover.
//
// A second line names the environment, always — SANDBOX as well as PRODUCTION.
// Saying nothing on a sandbox would leave silence meaning two different things,
// which is the defect this replaces: Rossum marks a sandbox with its own chip and
// marks production with NOTHING, so absence was the only signal for the dangerous
// case. The two states differ by WEIGHT, not only hue (owner, 2026-09-24):
// production is a filled red block with white text, a sandbox a hollow outline,
// so the heavier one is the dangerous one for a reader who cannot tell the
// colours apart. The red is fixed because the badge carries its own ground; the
// sandbox outline rides on `currentColor` so it follows the navbar's theme.
//
// Taking that over means hiding Rossum's OWN chips — both "Sandbox" and
// "Developer mode" — so there is exactly one environment statement in the bar.
// They are hidden only once ours is painted: if the lookup fails we must not
// leave the bar saying nothing at all, which would be strictly worse than what
// Rossum shipped. Developer mode is NOT an environment (it means the toggle is
// on, revealing extra features) and it is hidden because it is noise next to the
// one signal that costs something, not because it is being replaced.
//
// The navbar lives inside a Slide with unmountOnExit and genuinely remounts, so
// handleNode re-inserting is the job. init() covers the first paint: the observer
// only sees ADDED nodes and the SPA has usually mounted its navbar before a
// document_idle content script runs. Call it AFTER observe(), so a navbar
// rendered between the two is caught by one or the other.

const LABEL_ID = 'rossum-sa-extension-org-label';
const ENV_ID = 'rossum-sa-extension-org-env';
const DIVIDER_ID = 'rossum-sa-extension-org-divider';
const TABLIST = '[aria-label="nav-bar-tabs"]';
const MAX_WIDTH = '220px';
// MUI's light error red, used as the badge's own ground rather than as text, so
// its contrast is against the white label on it (4.5:1) and not against a navbar
// whose colour this feature never learns.
const DANGER = '#d32f2f';
// Rossum's own Sandbox chip, sampled from a screenshot of the live navbar: a
// #d5edf2 fill inside a #70cce1 border, with near-black text. Borrowing it keeps
// the calm state looking like the product's own rather than like a warning that
// failed to fire.
const SANDBOX_BG = '#d5edf2';
const SANDBOX_BORDER = '#70cce1';
const SANDBOX_FG = '#1b2126';
/** Rossum's own badges, replaced by ours. Matched on the label text they render. */
const REPLACED_CHIPS = ['Sandbox', 'Developer mode'];

export function handleNode(node: HTMLElement): void {
  if (node.matches(TABLIST)) {
    insert(node);
    return;
  }
  // Rossum's chips can arrive AFTER the navbar mounts — the features they depend
  // on resolve asynchronously — so hiding them once, when ours is painted, misses
  // a chip that turns up later. This is the path that catches it.
  if (node.matches('.MuiChip-root')) hideIfReplaced(node);
}

export function init(): void {
  const tablist = document.querySelector<HTMLElement>(TABLIST);
  if (tablist) insert(tablist);
}

function insert(tablist: HTMLElement): void {
  const row = tablist.closest('.MuiTabs-root')?.parentElement;
  if (!row || row.querySelector(`#${LABEL_ID}`)) return;
  // The dashboard's token is scoped to the organization being viewed, so this
  // lists exactly that one. /auth/user would not: it answers with the signed-in
  // user's HOME org, which is org 1 for a system user. fetchRossumApi caches per
  // path, so repeated navbar remounts cost one request per tab.
  fetchRossumApi('/api/v1/organizations/?page_size=1')
    .then((data) => {
      const org = data?.results?.[0];
      if (org?.name) paint(row, org.name, !org.sandbox);
    })
    .catch(() => {});
}

function paint(row: HTMLElement, name: string, production: boolean): void {
  // Re-checked here rather than trusting insert's check: the same row can be
  // reached twice before the (cached) lookup resolves.
  if (row.querySelector(`#${LABEL_ID}`)) return;

  const divider = document.createElement('span');
  divider.id = DIVIDER_ID;
  divider.style.width = '1px';
  divider.style.height = '28px'; // spans the two-line label, which measures ~33px
  divider.style.background = 'currentColor';
  divider.style.opacity = '0.2';
  divider.style.flexShrink = '0';

  const label = document.createElement('span');
  label.id = LABEL_ID;
  label.title = name;
  label.style.display = 'flex';
  label.style.flexDirection = 'column';
  label.style.lineHeight = '1.15';
  label.style.maxWidth = MAX_WIDTH;
  label.style.minWidth = '0';
  label.style.flexShrink = '0';

  const orgName = document.createElement('span');
  orgName.textContent = name;
  orgName.style.fontSize = '12.5px';
  orgName.style.opacity = '0.7';
  orgName.style.overflow = 'hidden';
  orgName.style.textOverflow = 'ellipsis';
  orgName.style.whiteSpace = 'nowrap';
  label.append(orgName);

  const env = document.createElement('span');
  env.id = ENV_ID;
  env.textContent = production ? 'PRODUCTION' : 'SANDBOX';
  env.style.alignSelf = 'flex-start'; // hug the text: the column stretches children
  env.style.marginTop = '3px'; // the two lines sat too close at line-height alone
  // Vertical centring here is a PIXEL problem, not a metrics one: measure it by
  // reading rendered rows out of a screenshot, because font metrics say the ink
  // is centred when it is not. Two rules keep it true. `line-height: 1` pins the
  // line box to the font size, and the padding leaves an EVEN number of spare
  // pixels — 8 rows of capitals inside a 12px content box gives 2 above and 2
  // below, where 13px could only ever be 2 and 3.
  env.style.lineHeight = '1';
  env.style.padding = '1px 6px';
  // The same weight in both states, so both have the same ink height and one
  // padding centres both. The states differ by fill against outline, which is
  // the distinction that carries meaning; a heavier weight on one of them only
  // moved its ink a pixel and broke the centring.
  env.style.fontWeight = '700';
  env.style.borderRadius = '3px';
  env.style.fontSize = '10px';
  env.style.letterSpacing = '0.08em';
  if (production) {
    env.style.background = DANGER;
    env.style.border = `1px solid ${DANGER}`;
    env.style.color = '#fff';
  } else {
    // Filled like production, so both states are built the same way and the ink
    // stays centred; they differ in loudness — white on red against near-black on
    // pale blue — rather than in construction.
    env.style.background = SANDBOX_BG;
    env.style.border = `1px solid ${SANDBOX_BORDER}`;
    env.style.color = SANDBOX_FG;
  }
  label.append(env);

  row.prepend(label);
  row.prepend(divider);
  hideReplacedChips(row);
  // Once per page load, not per navbar remount, and only when the badge actually
  // painted. The name says the feature ran and nothing about the organization —
  // not even which environment it was, which an earlier pair of names did report.
  trackOnce('sa_rossum_org_badge');
}

function hideReplacedChips(row: HTMLElement): void {
  for (const chip of row.querySelectorAll<HTMLElement>('.MuiChip-root')) hideIfReplaced(chip);
}

// Hides one of Rossum's badges, but ONLY once ours is in the same row: hiding
// them after a failed lookup would leave the bar with no environment statement at
// all, which is strictly worse than what Rossum shipped. A chip that arrives
// before ours is simply left alone — paint() sweeps the row when it lands.
function hideIfReplaced(chip: HTMLElement): void {
  const text = chip.querySelector('.MuiChip-label')?.textContent?.trim();
  if (!text || !REPLACED_CHIPS.includes(text)) return;
  const row = chip.parentElement;
  if (!row?.querySelector(`#${ENV_ID}`)) return;
  chip.style.display = 'none';
}
