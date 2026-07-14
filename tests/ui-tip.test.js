// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import Tip from '../src/ui/Tip.jsx';
import styles from '../src/ui/Tip.module.css';

let root;
afterEach(() => { if (root) { render(null, root); root.remove(); } });
function mount(props, child) { root = document.createElement('div'); document.body.appendChild(root); render(h(Tip, props, child), root); return root; }

describe('Tip', () => {
  it('shows the popup on hover and hides on leave', () => {
    const el = mount({ text: 'Explains the thing' }, h('button', null, 'trigger'));
    const trigger = el.querySelector('.' + styles.trigger);
    expect(trigger).toBeTruthy();
    expect(el.querySelector('.' + styles.pop)).toBeNull();
    act(() => { trigger.dispatchEvent(new MouseEvent('mouseenter')); });
    const pop = el.querySelector('.' + styles.pop);
    expect(pop).toBeTruthy();
    expect(pop.textContent).toContain('Explains the thing');
    act(() => { trigger.dispatchEvent(new MouseEvent('mouseleave')); });
    expect(el.querySelector('.' + styles.pop)).toBeNull();
  });
  it('renders a vnode as popup content', () => {
    const el = mount({ text: h('b', null, 'bold tip') }, h('button', null, 't'));
    act(() => { el.querySelector('.' + styles.trigger).dispatchEvent(new MouseEvent('mouseenter')); });
    expect(el.querySelector('.' + styles.pop + ' b').textContent).toBe('bold tip');
  });
  it('shows nothing when text is empty', () => {
    const el = mount({ text: '' }, h('button', null, 't'));
    act(() => { el.querySelector('.' + styles.trigger).dispatchEvent(new MouseEvent('mouseenter')); });
    expect(el.querySelector('.' + styles.pop)).toBeNull();
  });
  it('block mode renders a <div> trigger with the block class', () => {
    const el = mount({ text: 'x', block: true }, h('span', null, 'c'));
    const t = el.querySelector('.' + styles.trigger);
    expect(t.tagName).toBe('DIV');
    expect(t.classList.contains(styles.block)).toBe(true);
  });
});
