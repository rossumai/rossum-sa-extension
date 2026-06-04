// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { h, render } from 'preact';
import Rail from '../src/console/components/Rail.jsx';
import { activeApp } from '../src/console/store.js';

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
  });

  it('renders one button per app', () => {
    const root = mount();
    expect(root.querySelectorAll('.app-rail-item').length).toBe(2);
  });

  it('marks the active app with its full name as the tooltip', () => {
    const root = mount();
    const active = root.querySelector('.app-rail-item.active');
    expect(active.getAttribute('title')).toBe('Dataset Management');
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
