// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { h, render } from 'preact';
import MatchKeyPicker from '../src/mdh/components/MatchKeyPicker.jsx';

function mount(node: any) { const r = document.createElement('div'); document.body.appendChild(r); render(node, r); return r; }
async function waitFor(fn: any, { timeout = 2000, interval = 10 } = {}) {
  const s = Date.now();
  for (;;) { let v: any; try { v = fn(); } catch { v = null; } if (v) return v; if (Date.now() - s > timeout) throw new Error('timeout'); await new Promise((r) => setTimeout(r, interval)); }
}
const PATHS = ['_id', 'sku', 'address.zip', 'address.country', 'vendor.id'];
const focus = (el: any) => el.dispatchEvent(new Event('focus', { bubbles: true }));
const keydown = (el: any, key: any) => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

describe('MatchKeyPicker', () => {
  it('renders selected keys as chips', () => {
    const root = mount(h(MatchKeyPicker, { paths: PATHS, keys: ['_id'], setKeys() {} }));
    expect(root.querySelector('[data-testid="match-keys"]')).toBeTruthy();
    expect([...root.querySelectorAll('.match-key-chip')].some((c) => c.textContent.includes('_id'))).toBe(true);
  });

  it('shows all available suggestions on focus, before typing', async () => {
    const root = mount(h(MatchKeyPicker, { paths: PATHS, keys: [], setKeys() {} }));
    focus(root.querySelector('[data-testid="match-key-input"]'));
    await waitFor(() => root.querySelector('[data-testid="match-key-suggest"]'));
    expect([...root.querySelectorAll('.match-key-suggest-item')].map((b) => b.textContent)).toEqual(PATHS);
  });

  it('excludes already-selected paths', async () => {
    const root = mount(h(MatchKeyPicker, { paths: PATHS, keys: ['sku'], setKeys() {} }));
    focus(root.querySelector('[data-testid="match-key-input"]'));
    await waitFor(() => root.querySelector('[data-testid="match-key-suggest"]'));
    expect([...root.querySelectorAll('.match-key-suggest-item')].map((b) => b.textContent)).not.toContain('sku');
  });

  it('ArrowDown moves the active option and Enter adds it', async () => {
    const setKeys = vi.fn();
    const root = mount(h(MatchKeyPicker, { paths: PATHS, keys: [], setKeys }));
    const input = root.querySelector('[data-testid="match-key-input"]');
    focus(input);
    await waitFor(() => root.querySelector('.match-key-suggest-item.active'));
    keydown(input, 'ArrowDown');
    await waitFor(() => { const items = [...root.querySelectorAll('.match-key-suggest-item')]; return items[1]?.classList.contains('active'); });
    keydown(input, 'Enter');
    expect(setKeys).toHaveBeenCalledWith([PATHS[1]]); // 'sku'
  });

  it('Escape closes the dropdown', async () => {
    const root = mount(h(MatchKeyPicker, { paths: PATHS, keys: [], setKeys() {} }));
    const input = root.querySelector('[data-testid="match-key-input"]');
    focus(input);
    await waitFor(() => root.querySelector('[data-testid="match-key-suggest"]'));
    keydown(input, 'Escape');
    await waitFor(() => !root.querySelector('[data-testid="match-key-suggest"]'));
    expect(root.querySelector('[data-testid="match-key-suggest"]')).toBeNull();
  });

  it('filters by query and clicking a suggestion adds it (mousedown-safe)', async () => {
    const setKeys = vi.fn();
    const root = mount(h(MatchKeyPicker, { paths: PATHS, keys: ['_id'], setKeys }));
    const input = root.querySelector<HTMLInputElement>('[data-testid="match-key-input"]')!;
    input.value = 'address'; input.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => root.querySelectorAll('.match-key-suggest-item').length >= 2);
    const first = root.querySelector<HTMLElement>('.match-key-suggest-item')!;
    first.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    first.click();
    expect(setKeys).toHaveBeenCalledWith(['_id', 'address.zip']);
  });

  it('Backspace on empty input removes the last chip', () => {
    const setKeys = vi.fn();
    const root = mount(h(MatchKeyPicker, { paths: PATHS, keys: ['_id', 'sku'], setKeys }));
    keydown(root.querySelector('[data-testid="match-key-input"]'), 'Backspace');
    expect(setKeys).toHaveBeenCalledWith(['_id']);
  });

  it('positions the open dropdown as an anchored popup (escapes modal clip)', async () => {
    const root = mount(h(MatchKeyPicker, { paths: PATHS, keys: [], setKeys() {} }));
    focus(root.querySelector('[data-testid="match-key-input"]'));
    const sugg = await waitFor(() => root.querySelector('[data-testid="match-key-suggest"]'));
    const style = sugg.getAttribute('style') || '';
    expect(style).toMatch(/max-height:/);
    expect(/top:|bottom:/.test(style)).toBe(true);
    expect(style).toMatch(/width:/);
  });
});
