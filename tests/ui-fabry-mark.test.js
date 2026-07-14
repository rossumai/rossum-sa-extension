// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h, render } from 'preact';
import FabryMark from '../src/ui/FabryMark.jsx';
import styles from '../src/ui/FabryMark.module.css';

// Render via h() (repo test convention: only .jsx sources are transformed).
// Assert against the imported `styles` object, not literal class names — the CSS
// Module scopes the names, so `styles.mark`/`styles.animated` are the ground truth.
function mount(props) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(FabryMark, props || null), root);
  return root.querySelector('svg');
}

describe('FabryMark', () => {
  it('renders an inline SVG four-point star carrying the module mark class', () => {
    const svg = mount();
    expect(svg).toBeTruthy();
    expect(svg.classList.contains(styles.mark)).toBe(true);
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    const d = svg.querySelector('path').getAttribute('d'); // a centered, closed four-point star
    expect(d).toMatch(/^M12\b/);   // top point centered at x=12
    expect(d).toMatch(/[Zz]\s*$/); // closed path
  });

  it('is animated by default (adds the module animated class)', () => {
    expect(mount().classList.contains(styles.animated)).toBe(true);
  });

  it('omits the animation class when animated={false}', () => {
    expect(mount({ animated: false }).classList.contains(styles.animated)).toBe(false);
  });

  it('defaults to 1em sizing so the call-site font-size drives it', () => {
    const svg = mount();
    expect(svg.getAttribute('width')).toBe('1em');
    expect(svg.getAttribute('height')).toBe('1em');
  });

  it('accepts a numeric size (px)', () => {
    const svg = mount({ size: 20 });
    expect(svg.getAttribute('width')).toBe('20');
    expect(svg.getAttribute('height')).toBe('20');
  });

  it('merges an extra (global) class alongside the module class', () => {
    const svg = mount({ class: 'extra-class' });
    expect(svg.classList.contains('extra-class')).toBe(true);
    expect(svg.classList.contains(styles.mark)).toBe(true);
  });

  it('is decorative by default (aria-hidden), titled when a title is given', () => {
    const plain = mount();
    expect(plain.getAttribute('aria-hidden')).toBe('true');
    expect(plain.querySelector('title')).toBeNull();

    const titled = mount({ title: 'Mr. Fabry' });
    expect(titled.getAttribute('aria-hidden')).toBeNull();
    expect(titled.querySelector('title').textContent).toBe('Mr. Fabry');
  });
});
