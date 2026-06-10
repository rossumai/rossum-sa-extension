// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { h, render } from 'preact';
import { opNotice } from '../src/mdh/store.js';
import OpNoticeBanner from '../src/mdh/components/OpNoticeBanner.jsx';

function mount() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(OpNoticeBanner, null), root);
  return root;
}

beforeEach(() => { opNotice.value = null; });

describe('OpNoticeBanner', () => {
  it('renders nothing when there is no notice', () => {
    const root = mount();
    expect(root.querySelector('.op-notice-banner')).toBeNull();
  });

  it('renders the message and applies the kind class', () => {
    opNotice.value = { message: 'Creating search index… (runs in the background)', kind: 'info' };
    const root = mount();
    const banner = root.querySelector('.op-notice-banner');
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain('Creating search index');
    expect(banner.classList.contains('info')).toBe(true);
  });

  it('applies the warning kind class', () => {
    opNotice.value = { message: 'still running', kind: 'warning' };
    const root = mount();
    expect(root.querySelector('.op-notice-banner').classList.contains('warning')).toBe(true);
  });

  it('dismiss clears the notice', () => {
    opNotice.value = { message: 'x', kind: 'info' };
    const root = mount();
    root.querySelector('.op-notice-banner .dismiss').click();
    expect(opNotice.value).toBeNull();
  });
});
