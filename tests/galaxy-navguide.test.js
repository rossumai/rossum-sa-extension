// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h, render } from 'preact';
import NavGuide from '../src/galaxy/components/NavGuide.jsx';

describe('NavGuide', () => {
  it('renders 5 .galaxy-help-row rows', () => {
    const root = document.createElement('div');
    render(h(NavGuide, null), root);
    expect(root.querySelectorAll('.galaxy-help-row').length).toBe(5);
  });

  it('contains "Rotate" and "Zoom" in the output', () => {
    const root = document.createElement('div');
    render(h(NavGuide, null), root);
    expect(root.textContent).toContain('Rotate');
    expect(root.textContent).toContain('Zoom');
  });
});
