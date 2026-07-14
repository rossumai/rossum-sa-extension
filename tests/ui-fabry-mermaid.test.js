// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h, render } from 'preact';
import { renderMermaidSVG } from 'beautiful-mermaid';
import MermaidBlock from '../src/ui/fabry/MermaidBlock.jsx';
import styles from '../src/ui/fabry/FabryMarkdown.module.css';

// beautiful-mermaid's SVG renderer is synchronous and DOM-free, so these tests
// exercise the REAL library. In production the renderer arrives via the lazy
// script bundle; here we pre-register it the way the bundle does.
window.__fabryMermaidSvg = renderMermaidSVG;

function mount(props) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(MermaidBlock, props), root);
  return root;
}

describe('MermaidBlock (beautiful-mermaid SVG)', () => {
  it('renders a flowchart as an inline SVG diagram', () => {
    const root = mount({ code: 'graph TD\n  A[Upload] --> B[Review]' });
    const svg = root.querySelector('.' + styles.mermaid + ' .' + styles.mermaidBox + ' svg');
    expect(svg).toBeTruthy();
    expect(svg.textContent).toContain('Upload');
    expect(root.querySelector('.' + styles.mermaid + ' .' + styles.lang).textContent).toBe('mermaid');
  });

  it('escapes hostile label text (no element injection)', () => {
    const root = mount({ code: 'graph TD\n  A["<img src=x onerror=alert(1)>"] --> B[ok]' });
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('.' + styles.mermaid + ' svg')).toBeTruthy();
  });

  it('falls back to a plain code fence for invalid diagrams', () => {
    const root = mount({ code: 'not a diagram at all {{{' });
    expect(root.querySelector('.' + styles.mermaid)).toBeNull();
    expect(root.querySelector('.' + styles.codewrap + ' .' + styles.lang).textContent).toBe('mermaid');
    expect(root.querySelector('pre code').textContent).toContain('not a diagram');
  });

  it('shows the dimmed source while the bundle is loading', () => {
    const saved = window.__fabryMermaidSvg;
    delete window.__fabryMermaidSvg;
    try {
      const root = mount({ code: 'graph TD\n  A --> B' });
      const box = root.querySelector('.' + styles.mermaid + '.loading');
      expect(box).toBeTruthy();
      expect(box.querySelector('.' + styles.mermaidSrc).textContent).toContain('A --> B');
    } finally {
      window.__fabryMermaidSvg = saved;
    }
  });
});
