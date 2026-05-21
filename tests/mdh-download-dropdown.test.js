// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';
import DownloadSplitButton from '../src/mdh/components/DownloadSplitButton.jsx';

function mount(props) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(DownloadSplitButton, props), root);
  return root;
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const flushEffects = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => { document.body.innerHTML = ''; });

describe('DownloadSplitButton', () => {
  it('renders a single "Download" toggle button when closed', () => {
    const root = mount({ onAll: () => {}, onFiltered: () => {} });
    const buttons = root.querySelectorAll('button');
    expect(buttons.length).toBe(1);
    expect(buttons[0].textContent).toContain('Download');
    expect(root.querySelector('.toolbar-more-menu')).toBeNull();
  });

  it('opens a menu with both options when the toggle is clicked', async () => {
    const root = mount({ onAll: () => {}, onFiltered: () => {} });
    root.querySelector('button').click();
    await flush();
    const menu = root.querySelector('.toolbar-more-menu');
    expect(menu).not.toBeNull();
    const items = menu.querySelectorAll('.toolbar-menu-item');
    expect(items.length).toBe(2);
    expect(items[0].textContent).toContain('Download all');
    expect(items[1].textContent).toContain('Download filtered');
  });

  it('invokes onAll and closes the menu when "Download all" is clicked', async () => {
    const onAll = vi.fn();
    const onFiltered = vi.fn();
    const root = mount({ onAll, onFiltered });
    root.querySelector('button').click();
    await flush();
    root.querySelectorAll('.toolbar-menu-item')[0].click();
    await flush();
    expect(onAll).toHaveBeenCalledOnce();
    expect(onFiltered).not.toHaveBeenCalled();
    expect(root.querySelector('.toolbar-more-menu')).toBeNull();
  });

  it('invokes onFiltered and closes the menu when "Download filtered" is clicked', async () => {
    const onAll = vi.fn();
    const onFiltered = vi.fn();
    const root = mount({ onAll, onFiltered });
    root.querySelector('button').click();
    await flush();
    root.querySelectorAll('.toolbar-menu-item')[1].click();
    await flush();
    expect(onFiltered).toHaveBeenCalledOnce();
    expect(onAll).not.toHaveBeenCalled();
    expect(root.querySelector('.toolbar-more-menu')).toBeNull();
  });

  it('toggles the menu shut when the toggle is clicked again', async () => {
    const root = mount({ onAll: () => {}, onFiltered: () => {} });
    const btn = root.querySelector('button');
    btn.click();
    await flush();
    expect(root.querySelector('.toolbar-more-menu')).not.toBeNull();
    btn.click();
    await flush();
    expect(root.querySelector('.toolbar-more-menu')).toBeNull();
  });

  it('closes when a mousedown happens outside the dropdown', async () => {
    const root = mount({ onAll: () => {}, onFiltered: () => {} });
    const outside = document.createElement('button');
    document.body.appendChild(outside);

    root.querySelector('button').click();
    await flushEffects();
    expect(root.querySelector('.toolbar-more-menu')).not.toBeNull();

    outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await flushEffects();
    expect(root.querySelector('.toolbar-more-menu')).toBeNull();
  });

  it('stays open when a mousedown happens inside the dropdown', async () => {
    const root = mount({ onAll: () => {}, onFiltered: () => {} });
    root.querySelector('button').click();
    await flushEffects();
    const menu = root.querySelector('.toolbar-more-menu');
    expect(menu).not.toBeNull();

    menu.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await flushEffects();
    expect(root.querySelector('.toolbar-more-menu')).not.toBeNull();
  });
});
