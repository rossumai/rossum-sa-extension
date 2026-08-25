// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { h, render } from 'preact';
import Rail from '../src/console/components/Rail.jsx';
import { activeApp, experimentalUnlocked } from '../src/console/store.js';
import markStyles from '../src/ui/FabryMark.module.css';

// Component tests are .test.tsx and render with JSX, matching src/. Only .tsx is
// JSX-transformed, which is why the suite's non-component tests stay .test.ts.
function mount() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(<Rail />, root);
  return root;
}

describe('Rail', () => {
  beforeEach(() => {
    activeApp.value = 'mdh';
    experimentalUnlocked.value = false;
  });

  it('renders one button per app', () => {
    const root = mount();
    expect(root.querySelectorAll('.app-rail-item').length).toBe(5);
  });

  it('renders the Inspector app button and switches to it on click', () => {
    const root = mount();
    const btn = [...root.querySelectorAll('.app-rail-item')].find(
      (b) => b.getAttribute('title') === 'Annotation Inspector',
    );
    expect(btn).toBeTruthy();
    (btn as HTMLElement).click();
    expect(activeApp.value).toBe('inspector');
  });

  it('renders the Inspector as a normal (non-muted) rail item, positioned above Galaxy', () => {
    const root = mount();
    const items = [...root.querySelectorAll('.app-rail-item')];
    const idx = (title: any) => items.findIndex((b) => b.getAttribute('title') === title);
    const inspector = items[idx('Annotation Inspector')];
    expect(inspector.classList.contains('muted')).toBe(false); // no dimming
    expect(items.some((b) => b.classList.contains('muted'))).toBe(false); // nothing is muted now
    expect(idx('Annotation Inspector')).toBeLessThan(idx('Org Galaxy')); // above Galaxy
  });

  it('renders Galaxy as the last rail item, after the now-public Fabry item', () => {
    // Assert with the gate LOCKED. Fabry is public, so it is on the rail either
    // way, while the Academy — which sits after Galaxy — is hidden, which is
    // what makes "Galaxy is last" a real assertion rather than a trivial one.
    experimentalUnlocked.value = false;
    const items = [...mount().querySelectorAll('.app-rail-item')];
    const title = (b: any) => b.getAttribute('title');
    const idx = (t: any) => items.findIndex((b) => title(b) === t);
    expect(title(items[items.length - 1])).toBe('Org Galaxy');
    expect(idx('Mr. Fabry')).toBeLessThan(idx('Org Galaxy'));
  });

  it('renders the Galaxy app button and switches to it on click', () => {
    const root = mount();
    const btn = [...root.querySelectorAll('.app-rail-item')].find(
      (b) => b.getAttribute('title') === 'Org Galaxy',
    );
    expect(btn).toBeTruthy();
    (btn as HTMLElement).click();
    expect(activeApp.value).toBe('galaxy');
  });

  it('marks the active app with its full name as the tooltip', () => {
    const root = mount();
    const active = root.querySelector('.app-rail-item.active');
    expect(active!.getAttribute('title')).toBe('Dataset Management');
  });

  it('renders the Fabry rail icon as a STATIC shared FabryMark (no color cycle)', () => {
    const root = mount();
    const btn = [...root.querySelectorAll('.app-rail-item')].find(
      (b) => b.getAttribute('title') === 'Mr. Fabry',
    );
    const svg = btn!.querySelector('svg')!;
    expect(svg.classList.contains(markStyles.mark)).toBe(true); // it's the shared mark
    expect(svg.classList.contains(markStyles.animated)).toBe(false); // rail is static
  });

  it('Galaxy rail item has no beta badge', () => {
    const root = mount();
    const btn = [...root.querySelectorAll('.app-rail-item')].find(
      (b) => b.getAttribute('title') === 'Org Galaxy',
    );
    expect(btn!.querySelector('.app-rail-beta')).toBeNull();
  });

  it('clicking the Audit button sets activeApp to audit', () => {
    const root = mount();
    const auditBtn = [...root.querySelectorAll('.app-rail-item')].find(
      (b) => b.getAttribute('title') === 'Audit Log Viewer',
    );
    (auditBtn as HTMLElement).click();
    expect(activeApp.value).toBe('audit');
  });

  it('re-renders the active marker after activeApp changes', () => {
    const root = mount();
    activeApp.value = 'audit';
    render(<Rail />, root);
    expect(root.querySelector('.app-rail-item.active')!.getAttribute('title')).toBe(
      'Audit Log Viewer',
    );
  });
});

describe('Rail — fabry is public', () => {
  it('shows Fabry with its beta badge while the experimental gate is LOCKED', () => {
    experimentalUnlocked.value = false;
    const root = mount();
    const btn = [...root.querySelectorAll('.app-rail-item')].find(
      (b) => b.getAttribute('title') === 'Mr. Fabry',
    )!;
    expect(btn).toBeTruthy();
    expect(btn.querySelector('.app-rail-beta')!.textContent).toBe('beta');
    expect(btn.querySelector('.app-rail-exp')).toBeNull(); // public: beta, never exp
    (btn as HTMLElement).click();
    expect(activeApp.value).toBe('fabry');
  });
});

describe('Rail — academy (experimental) gate', () => {
  const ACADEMY_TITLE = 'Onboarding training — experimental';

  it('hides Academy while the gate is locked', () => {
    experimentalUnlocked.value = false;
    const root = mount();
    expect(root.querySelectorAll('.app-rail-item').length).toBe(5);
    expect(
      [...root.querySelectorAll('.app-rail-item')].some(
        (b) => b.getAttribute('title') === ACADEMY_TITLE,
      ),
    ).toBe(false);
  });

  it('shows Academy with an EXP badge when unlocked, and switches on click', () => {
    experimentalUnlocked.value = true;
    const root = mount();
    const btn = [...root.querySelectorAll('.app-rail-item')].find(
      (b) => b.getAttribute('title') === ACADEMY_TITLE,
    )!;
    expect(btn).toBeTruthy();
    // exp REPLACES beta on a gated app: the badge names the gate it sits behind.
    expect(btn.querySelector('.app-rail-exp')!.textContent).toBe('exp');
    expect(btn.querySelector('.app-rail-beta')).toBeNull();
    (btn as HTMLElement).click();
    expect(activeApp.value).toBe('academy');
  });

  // The consolidation itself: ONE key now drives the Academy and nothing else.
  // Before 2026-08-11 two keys drove two apps, and the pair of tests here
  // asserted they could not cross-unlock. The risk now runs the other way — that
  // the surviving gate quietly re-acquires Fabry — so that is what this pins.
  it('drives the Academy alone; Fabry is present in both gate states', () => {
    experimentalUnlocked.value = false;
    let titles = [...mount().querySelectorAll('.app-rail-item')].map((b) =>
      b.getAttribute('title'),
    );
    expect(titles).toContain('Mr. Fabry');
    expect(titles).not.toContain(ACADEMY_TITLE);

    experimentalUnlocked.value = true;
    titles = [...mount().querySelectorAll('.app-rail-item')].map((b) => b.getAttribute('title'));
    expect(titles).toContain('Mr. Fabry');
    expect(titles).toContain(ACADEMY_TITLE);
  });
});
