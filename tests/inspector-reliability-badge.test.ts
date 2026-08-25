// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { h, render } from 'preact';
import ReliabilityBadge from '../src/inspector/components/ReliabilityBadge.jsx';

let root: any;
function mount(level: any) { root = document.createElement('div'); document.body.appendChild(root); render(h(ReliabilityBadge, { level }), root); return root; }
afterEach(() => { if (root) { render(null, root); root.remove(); } });

describe('ReliabilityBadge', () => {
  it('shows a confidence label for high/medium/low', () => {
    expect(mount('high').textContent).toMatch(/high confidence/i);
    expect(mount('low').textContent).toMatch(/low confidence/i);
  });
  it('still shows "Not recorded" for unavailable and nothing for verified/null', () => {
    expect(mount('unavailable').textContent).toMatch(/not recorded/i);
    expect(mount('verified').textContent).toBe('');
    expect(mount(null).textContent).toBe('');
  });
});
