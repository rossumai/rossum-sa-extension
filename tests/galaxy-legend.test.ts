// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { h, render } from 'preact';
import Legend from '../src/galaxy/components/Legend.jsx';
import * as store from '../src/galaxy/store.js';

beforeEach(() => {
  // Reset visibility to all-visible before each test.
  store.visibleTypes.value = { organization: true, workspace: true, queue: true, hook: true, engine: true };
});

describe('Legend', () => {
  it('renders one swatch per resource type', () => {
    const root = document.createElement('div');
    render(h(Legend, null), root);
    expect(root.querySelectorAll('.galaxy-legend-item').length).toBe(5);
    expect(root.textContent).toContain('Organization');
    expect(root.textContent).toContain('Queue');
  });

  it('clicking the Queue button toggles visibleTypes.queue to false', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    render(h(Legend, null), root);

    const buttons = root.querySelectorAll('.galaxy-legend-item');
    // The buttons are in LABELS order: organization, workspace, queue, hook, engine.
    // Queue is index 2.
    const queueBtn = [...buttons].find((b) => b.textContent.trim() === 'Queue');
    expect(queueBtn).not.toBe(null);
    expect(store.visibleTypes.value.queue).toBe(true);

    (queueBtn as HTMLElement).click();
    expect(store.visibleTypes.value.queue).toBe(false);
    document.body.removeChild(root);
  });

  it('the Queue button gains the hidden class after toggling', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    // First render: all visible.
    render(h(Legend, null), root);
    const queueBtnBefore = [...root.querySelectorAll('.galaxy-legend-item')].find((b) => b.textContent.trim() === 'Queue');
    expect(queueBtnBefore!.classList.contains('hidden')).toBe(false);

    // Toggle queue hidden via the store signal directly (simulates the click effect).
    store.toggleType('queue');
    // Re-render with updated signal.
    render(h(Legend, null), root);

    const queueBtnAfter = [...root.querySelectorAll('.galaxy-legend-item')].find((b) => b.textContent.trim() === 'Queue');
    expect(queueBtnAfter!.classList.contains('hidden')).toBe(true);

    document.body.removeChild(root);
  });
});
