// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { h, render } from 'preact';
import FlashOnChange from '../src/mdh/components/FlashOnChange.jsx';

function flush() {
  // Microtasks + a macrotask so Preact's effect → setState → re-render chain
  // has time to run before the next assertion.
  return new Promise((r) => setTimeout(r, 16));
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('FlashOnChange', () => {
  it('renders the value without a flash class on first mount', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    render(h(FlashOnChange, { value: '42' }), root);
    await flush();
    expect(root.textContent).toBe('42');
    expect(root.querySelector('.flash-value')).toBeNull();
  });

  it('does not flash when re-rendering with the same value', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    render(h(FlashOnChange, { value: '42' }), root);
    await flush();
    render(h(FlashOnChange, { value: '42' }), root);
    await flush();
    expect(root.querySelector('.flash-value')).toBeNull();
  });

  it('applies the flash-value class when the value changes', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    render(h(FlashOnChange, { value: '42' }), root);
    await flush(); await flush();
    render(h(FlashOnChange, { value: '99' }), root);
    await flush(); await flush();
    expect(root.textContent).toBe('99');
    expect(root.querySelector('.flash-value')).not.toBeNull();
  });

  it('keeps flashing on every subsequent change', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    render(h(FlashOnChange, { value: 'a' }), root);
    await flush(); await flush();
    render(h(FlashOnChange, { value: 'b' }), root);
    await flush(); await flush();
    render(h(FlashOnChange, { value: 'c' }), root);
    await flush(); await flush();
    expect(root.querySelector('.flash-value')).not.toBeNull();
    expect(root.textContent).toBe('c');
  });
});
