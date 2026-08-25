// @vitest-environment jsdom
// tests/devtools-requestbar.test.js
import { describe, it, expect, vi } from 'vitest';
import { h, render } from 'preact';
import RequestBar from '../src/devtools/RequestBar.jsx';

async function waitFor(fn: any, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('waitFor timed out');
}
function type(input: any, value: any) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('RequestBar', () => {
  it('renders an input and shows suggestions as you type', async () => {
    const root = document.createElement('div');
    render(<RequestBar onSubmit={() => null} />, root);
    const input = root.querySelector('.rawjson-reqbar-input');
    expect(input).not.toBeNull();
    type(input, 'ann');
    await waitFor(() => root.querySelector('.rawjson-reqbar-suggest'));
    expect(root.querySelector('.rawjson-reqbar-suggest')!.textContent.toLowerCase()).toContain(
      'annotation',
    );
  });
  it('submits the typed path on Enter', async () => {
    const onSubmit = vi.fn(() => ({ tab: { id: 't1' } }));
    const root = document.createElement('div');
    render(<RequestBar onSubmit={onSubmit} />, root);
    const input = root.querySelector('.rawjson-reqbar-input');
    type(input, '/api/v1/queues');
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await waitFor(() => onSubmit.mock.calls.length > 0);
    expect(onSubmit).toHaveBeenCalledWith('/api/v1/queues');
  });
  it('selects a highlighted suggestion on Enter without submitting', async () => {
    const onSubmit = vi.fn();
    const root = document.createElement('div');
    render(<RequestBar onSubmit={onSubmit} />, root);
    const input = root.querySelector<HTMLInputElement>('.rawjson-reqbar-input')!;
    type(input, 'ann');
    await waitFor(() => root.querySelector('.rawjson-reqbar-suggest'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await waitFor(() => root.querySelector('.rawjson-reqbar-item.active'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onSubmit).not.toHaveBeenCalled();
    await waitFor(() => input.value.includes('annotation'));
    expect(input.value).toContain('annotation');
  });
  it('ArrowUp highlights the last suggestion when none is selected (arrow-up works)', async () => {
    const root = document.createElement('div');
    render(<RequestBar onSubmit={() => null} />, root);
    const input = root.querySelector('.rawjson-reqbar-input');
    type(input, 'e'); // matches several endpoints
    await waitFor(() => root.querySelectorAll('.rawjson-reqbar-item').length > 1);
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await waitFor(() => root.querySelector('.rawjson-reqbar-item.active'));
    const items = [...root.querySelectorAll('.rawjson-reqbar-item')];
    expect(items.findIndex((el) => el.classList.contains('active'))).toBe(items.length - 1);
  });
  it('renders the assumed /api/v1/ prefix adornment (input stays prefix-free)', () => {
    const root = document.createElement('div');
    render(<RequestBar onSubmit={() => null} />, root);
    const p = root.querySelector('.rawjson-reqbar-prefix');
    expect(p).not.toBeNull();
    expect(p!.textContent).toBe('/api/v1/');
  });
  it('still shows suggestions while the /api/v1/ prefix is typed (v1 bug regression)', async () => {
    const root = document.createElement('div');
    render(<RequestBar onSubmit={() => null} />, root);
    type(root.querySelector('.rawjson-reqbar-input'), '/api/v1');
    await waitFor(() => root.querySelector('.rawjson-reqbar-suggest'));
    expect(root.querySelector('.rawjson-reqbar-suggest')).not.toBeNull();
  });
  it('inserts the short (prefix-free) path when a suggestion is picked', async () => {
    const root = document.createElement('div');
    render(<RequestBar onSubmit={() => null} />, root);
    const input = root.querySelector<HTMLInputElement>('.rawjson-reqbar-input')!;
    type(input, 'queu');
    await waitFor(() => root.querySelector('.rawjson-reqbar-suggest'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await waitFor(() => root.querySelector('.rawjson-reqbar-item.active'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await waitFor(() => input.value.includes('queues'));
    expect(input.value).not.toContain('/api/v1/');
  });
});
