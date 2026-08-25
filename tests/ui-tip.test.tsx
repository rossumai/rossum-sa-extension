// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import Tip from '../src/ui/Tip.jsx';
import styles from '../src/ui/Tip.module.css';

let root: any;
afterEach(() => { if (root) { render(null, root); root.remove(); } });
function mount(props: any, child: any) { root = document.createElement('div'); document.body.appendChild(root); render(<Tip {...props}>{child}</Tip>, root); return root; }

describe('Tip', () => {
  it('shows the popup on hover and hides on leave', () => {
    const el = mount({ text: 'Explains the thing' }, <button>trigger</button>);
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
    const el = mount({ text: <b>bold tip</b> }, <button>t</button>);
    act(() => { el.querySelector('.' + styles.trigger).dispatchEvent(new MouseEvent('mouseenter')); });
    expect(el.querySelector('.' + styles.pop + ' b').textContent).toBe('bold tip');
  });
  it('shows nothing when text is empty', () => {
    const el = mount({ text: '' }, <button>t</button>);
    act(() => { el.querySelector('.' + styles.trigger).dispatchEvent(new MouseEvent('mouseenter')); });
    expect(el.querySelector('.' + styles.pop)).toBeNull();
  });
  it('block mode renders a <div> trigger with the block class', () => {
    const el = mount({ text: 'x', block: true }, <span>c</span>);
    const t = el.querySelector('.' + styles.trigger);
    expect(t.tagName).toBe('DIV');
    expect(t.classList.contains(styles.block)).toBe(true);
  });
});
