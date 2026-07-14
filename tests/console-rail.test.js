// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { h, render } from 'preact';
import Rail from '../src/console/components/Rail.jsx';
import { activeApp, experimentalUnlocked } from '../src/console/store.js';
import markStyles from '../src/ui/FabryMark.module.css';

// Render via h() rather than JSX literals: the repo's test discovery only
// transforms .jsx sources, and every other .test.js renders components with
// h(Component, null). This keeps the test in the established convention.
function mount() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(Rail, null), root);
  return root;
}

describe('Rail', () => {
  beforeEach(() => {
    activeApp.value = 'mdh';
    experimentalUnlocked.value = false;
  });

  it('renders one button per app', () => {
    const root = mount();
    expect(root.querySelectorAll('.app-rail-item').length).toBe(4);
  });

  it('renders the Inspector app button and switches to it on click', () => {
    const root = mount();
    const btn = [...root.querySelectorAll('.app-rail-item')]
      .find((b) => b.getAttribute('title') === 'Annotation Inspector');
    expect(btn).toBeTruthy();
    btn.click();
    expect(activeApp.value).toBe('inspector');
  });

  it('renders the Inspector as a normal (non-muted) rail item, positioned above Galaxy', () => {
    const root = mount();
    const items = [...root.querySelectorAll('.app-rail-item')];
    const idx = (title) => items.findIndex((b) => b.getAttribute('title') === title);
    const inspector = items[idx('Annotation Inspector')];
    expect(inspector.classList.contains('muted')).toBe(false);            // no dimming
    expect(items.some((b) => b.classList.contains('muted'))).toBe(false); // nothing is muted now
    expect(idx('Annotation Inspector')).toBeLessThan(idx('Org Galaxy'));  // above Galaxy
  });

  it('renders Galaxy as the last rail item, after the experimental Fabry item when unlocked', () => {
    // Assert in the UNLOCKED state: Fabry (exp-gated) is the only item that sits
    // between Inspector and Galaxy, so under the locked default it is filtered out
    // and Galaxy is trivially last regardless of ordering. Only with Fabry visible
    // does this exercise the "Galaxy positioned after Fabry" placement.
    experimentalUnlocked.value = true;
    const items = [...mount().querySelectorAll('.app-rail-item')];
    const title = (b) => b.getAttribute('title');
    const idx = (t) => items.findIndex((b) => title(b) === t);
    expect(title(items[items.length - 1])).toBe('Org Galaxy');
    expect(idx('Mr. Fabry')).toBeLessThan(idx('Org Galaxy'));
  });

  it('renders the Galaxy app button and switches to it on click', () => {
    const root = mount();
    const btn = [...root.querySelectorAll('.app-rail-item')]
      .find((b) => b.getAttribute('title') === 'Org Galaxy');
    expect(btn).toBeTruthy();
    btn.click();
    expect(activeApp.value).toBe('galaxy');
  });

  it('marks the active app with its full name as the tooltip', () => {
    const root = mount();
    const active = root.querySelector('.app-rail-item.active');
    expect(active.getAttribute('title')).toBe('Dataset Management');
  });

  it('renders the Fabry rail icon as a STATIC shared FabryMark (no color cycle)', () => {
    experimentalUnlocked.value = true;
    const root = mount();
    const btn = [...root.querySelectorAll('.app-rail-item')]
      .find((b) => b.getAttribute('title') === 'Mr. Fabry');
    const svg = btn.querySelector('svg');
    expect(svg.classList.contains(markStyles.mark)).toBe(true);      // it's the shared mark
    expect(svg.classList.contains(markStyles.animated)).toBe(false); // rail is static
  });

  it('Galaxy rail item has no beta badge', () => {
    const root = mount();
    const btn = [...root.querySelectorAll('.app-rail-item')]
      .find((b) => b.getAttribute('title') === 'Org Galaxy');
    expect(btn.querySelector('.app-rail-beta')).toBeNull();
  });

  it('clicking the Audit button sets activeApp to audit', () => {
    const root = mount();
    const auditBtn = [...root.querySelectorAll('.app-rail-item')]
      .find((b) => b.getAttribute('title') === 'Audit Log Viewer');
    auditBtn.click();
    expect(activeApp.value).toBe('audit');
  });

  it('re-renders the active marker after activeApp changes', () => {
    const root = mount();
    activeApp.value = 'audit';
    render(h(Rail, null), root);
    expect(root.querySelector('.app-rail-item.active').getAttribute('title')).toBe('Audit Log Viewer');
  });
});

describe('Rail — fabry gate', () => {
  it('hides Fabry while locked', () => {
    experimentalUnlocked.value = false;
    const root = mount();
    expect(root.querySelectorAll('.app-rail-item').length).toBe(4);
    expect([...root.querySelectorAll('.app-rail-item')].some((b) => b.getAttribute('title') === 'Mr. Fabry')).toBe(false);
  });
  it('shows Fabry with a beta badge when unlocked, and switches on click', () => {
    experimentalUnlocked.value = true;
    const root = mount();
    const btn = [...root.querySelectorAll('.app-rail-item')].find((b) => b.getAttribute('title') === 'Mr. Fabry');
    expect(btn).toBeTruthy();
    expect(btn.querySelector('.app-rail-beta').textContent).toBe('beta');
    expect(btn.querySelector('.app-rail-exp')).toBeNull(); // badge is beta; exp only gates
    btn.click();
    expect(activeApp.value).toBe('fabry');
  });
});
