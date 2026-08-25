// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { h, render } from 'preact';
import { placeHint } from '../src/popup/hintPlacement.js';
import QueryItem from '../src/popup/components/QueryItem.jsx';

// A 380px popup (the narrow default) at the 600px cap.
const VIEW = { width: 380, height: 600 };
const dot = (top: any) => ({ left: 10, right: 22, top, bottom: top + 12 });

describe('placeHint', () => {
  it('sits just below the dot, left edges aligned', () => {
    expect(placeHint(dot(100), { width: 200, height: 60 }, VIEW)).toEqual({ top: 118, left: 10 });
  });

  it('flips above when there is no room below', () => {
    // Dot near the bottom: 560+12+6+60 overflows 600, and there IS room above.
    expect(placeHint(dot(560), { width: 200, height: 60 }, VIEW)).toEqual({ top: 494, left: 10 });
  });

  it('keeps a tip taller than the space on either side fully in view', () => {
    // Taller than the room above AND below → clamp rather than flip off-screen.
    // Asserting the property that matters, not the arithmetic: the whole tip
    // lands inside the viewport with the gap respected on both edges.
    const tip = { width: 200, height: 580 };
    const p = placeHint(dot(560), tip, VIEW);
    expect(p.top).toBeGreaterThanOrEqual(6);
    expect(p.top + tip.height).toBeLessThanOrEqual(VIEW.height - 6);
  });

  it('pulls a wide tip left so it never runs off the right edge', () => {
    const p = placeHint(
      { left: 300, right: 312, top: 100, bottom: 112 } as any,
      { width: 300, height: 40 },
      VIEW,
    );
    expect(p.left).toBe(380 - 300 - 6);
    expect(p.left + 300).toBeLessThanOrEqual(380);
  });

  it('pins to the left edge when the tip is wider than the viewport', () => {
    expect(placeHint(dot(100), { width: 500, height: 40 }, VIEW).left).toBe(6);
  });

  it('never returns a negative coordinate', () => {
    const p = placeHint(
      { left: -50, right: -38, top: -20, bottom: -8 } as any,
      { width: 200, height: 40 },
      VIEW,
    );
    expect(p.left).toBeGreaterThanOrEqual(0);
    expect(p.top).toBeGreaterThanOrEqual(0);
  });
});

// Preact batches state updates from an event handler through a microtask, so a
// synchronous assertion right after dispatchEvent() sees the pre-update DOM.
const seen = (fn: any) => vi.waitFor(fn, { timeout: 5000, interval: 10 });
// "Open" is not the same as "ready": the scroll/Escape listeners are registered
// by an effect, so a tip can be in the DOM a frame before they exist. `placed`
// (which sets visibility) only flips after the measuring effect has run, so it
// is the honest signal that the popover is fully wired.
const opened = (r: any) =>
  seen(() => expect(r.querySelector('.mdh-q-hint')?.style.visibility).toBe('visible'));

let root: any = null;
afterEach(() => {
  if (root) render(null, root);
  root = null;
  document.body.innerHTML = '';
});
function mount(props: any) {
  root = document.createElement('div');
  document.body.appendChild(root);
  render(
    <QueryItem index={0} label="vendor lookup" onCopy={() => {}} onOpen={() => {}} {...props} />,
    root,
  );
  return root;
}

describe('QueryItem — the hint never occupies layout', () => {
  const ERR = {
    status: 'error',
    hint: '400: "compound.filter[0].queryString.query" cannot be empty',
  };

  it('renders no inline detail line for an error (this was the layout shift)', () => {
    const r = mount({ status: ERR });
    expect(r.querySelector('.mdh-q-detail')).toBeNull();
    expect(r.textContent).not.toContain('cannot be empty');
  });

  it('renders no inline detail for skipped or gated either', () => {
    expect(
      mount({ status: { status: 'skipped', hint: 'cascade short-circuited' } }).querySelector(
        '.mdh-q-detail',
      ),
    ).toBeNull();
    render(null, root);
    expect(
      mount({ status: { status: 'gated', hint: 'action_condition gates this' } }).querySelector(
        '.mdh-q-detail',
      ),
    ).toBeNull();
  });

  it('shows the hint in a popover on hover, and removes it on leave', async () => {
    const r = mount({ status: ERR });
    const status = r.querySelector('.mdh-q-status');
    expect(r.querySelector('.mdh-q-hint')).toBeNull();

    status.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    await seen(() => expect(r.querySelector('.mdh-q-hint')).toBeTruthy());
    const tip = r.querySelector('.mdh-q-hint');
    expect(tip.textContent).toContain('cannot be empty');
    expect(tip.textContent).toContain('Replay failed'); // the status title heads it
    expect(tip.getAttribute('role')).toBe('tooltip');

    status.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
    await seen(() => expect(r.querySelector('.mdh-q-hint')).toBeNull());
  });

  it('opens on keyboard focus too, so the hint is not mouse-only', async () => {
    const r = mount({ status: ERR });
    const status = r.querySelector('.mdh-q-status');
    expect(status.getAttribute('tabindex')).toBe('0');
    status.dispatchEvent(new FocusEvent('focus'));
    await seen(() => expect(r.querySelector('.mdh-q-hint')).toBeTruthy());
    status.dispatchEvent(new FocusEvent('blur'));
    await seen(() => expect(r.querySelector('.mdh-q-hint')).toBeNull());
  });

  it('drops the native title when a popover carries the hint (no double tooltip)', () => {
    const r = mount({ status: ERR });
    expect(r.querySelector('.mdh-q-status').getAttribute('title')).toBeNull();
  });

  it('keeps the plain title, and adds no tab stop, for a status with no hint', () => {
    const r = mount({ status: { status: 'winner' } });
    const status = r.querySelector('.mdh-q-status');
    expect(status.getAttribute('title')).toBe('Winning query');
    expect(status.getAttribute('tabindex')).toBeNull();
    status.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    expect(r.querySelector('.mdh-q-hint')).toBeNull();
  });

  it('carries inline coordinates, which is what the fixed rule positions', async () => {
    const r = mount({ status: ERR });
    r.querySelector('.mdh-q-status').dispatchEvent(
      new MouseEvent('mouseenter', { bubbles: false }),
    );
    // jsdom has no layout, so assert the contract that survives it: the element
    // carries inline top/left. `position: fixed` itself lives in popup.css.
    await seen(() => expect(r.querySelector('.mdh-q-hint')).toBeTruthy());
    const tip = r.querySelector('.mdh-q-hint');
    expect(tip.style.top).not.toBe('');
    expect(tip.style.left).not.toBe('');
  });

  it('closes on scroll, so a fixed tip is never stranded away from its dot', async () => {
    const r = mount({ status: ERR });
    r.querySelector('.mdh-q-status').dispatchEvent(
      new MouseEvent('mouseenter', { bubbles: false }),
    );
    await opened(r);
    document.dispatchEvent(new Event('scroll'));
    await seen(() => expect(r.querySelector('.mdh-q-hint')).toBeNull());
  });

  it('closes on Escape', async () => {
    const r = mount({ status: ERR });
    r.querySelector('.mdh-q-status').dispatchEvent(
      new MouseEvent('mouseenter', { bubbles: false }),
    );
    await opened(r);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await seen(() => expect(r.querySelector('.mdh-q-hint')).toBeNull());
  });
});
