// tests/ui-fabry-input.test.js
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { h, render } from 'preact';
import FabryInput from '../src/ui/fabry/FabryInput.jsx';
import styles from '../src/ui/aiInput.module.css';

let root;
afterEach(() => { if (root) { render(null, root); root.remove(); } });
function mount(props) { root = document.createElement('div'); document.body.appendChild(root); render(h(FabryInput, props), root); return root; }
const fireInput = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
const fireKey = (el, key) => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

describe('FabryInput', () => {
  it('reflects value, calls onInput, and submits on Enter', () => {
    const onInput = vi.fn(); const onSubmit = vi.fn();
    const el = mount({ value: 'hi', onInput, onSubmit, busy: false, placeholder: 'Ask…', gerunds: ['G'] });
    const input = el.querySelector('input.' + styles.input);
    expect(input.value).toBe('hi');
    expect(el.querySelector('.' + styles.spark)).toBeTruthy();
    fireInput(input, 'who deleted users');
    expect(onInput).toHaveBeenCalledWith('who deleted users');
    fireKey(input, 'Enter');
    expect(onSubmit).toHaveBeenCalledWith('who deleted users');
  });
  it('Escape clears via onInput', () => {
    const onInput = vi.fn();
    const el = mount({ value: 'x', onInput, onSubmit: vi.fn(), busy: false, placeholder: '', gerunds: ['G'] });
    fireKey(el.querySelector('input'), 'Escape');
    expect(onInput).toHaveBeenCalledWith('');
  });
  it('busy hides the value, disables the input, and shows the loader', () => {
    const el = mount({ value: 'x', onInput: vi.fn(), onSubmit: vi.fn(), busy: true, placeholder: '', gerunds: ['G'] });
    const input = el.querySelector('input');
    expect(input.value).toBe('');
    expect(input.disabled).toBe(true);
    expect(el.querySelector('.' + styles.loader)).toBeTruthy();
    expect(el.querySelector('.' + styles.spark + '.' + styles.loading)).toBeTruthy();
  });
  it('size="sm" adds the compact variant class to the row', () => {
    const el = mount({ value: '', onInput: vi.fn(), onSubmit: vi.fn(), busy: false, placeholder: '', gerunds: ['G'], size: 'sm' });
    const row = el.querySelector('.' + styles.row);
    expect(row.classList.contains(styles.sm)).toBe(true);
  });
  it('appends an optional (global) className to the row; omitted leaves just the base class', () => {
    const withClass = mount({ value: '', onInput: vi.fn(), onSubmit: vi.fn(), busy: false, placeholder: '', gerunds: ['G'], className: 'inspector-ask' });
    const row = withClass.querySelector('.' + styles.row);
    expect(row.classList.contains('inspector-ask')).toBe(true);
    expect(row.className).toBe(styles.row + ' inspector-ask');
    render(null, root); root.remove(); // mount() reuses the module-level root; tear down before remounting

    const withoutClass = mount({ value: '', onInput: vi.fn(), onSubmit: vi.fn(), busy: false, placeholder: '', gerunds: ['G'] });
    expect(withoutClass.querySelector('.' + styles.row).className).toBe(styles.row);
  });
});
