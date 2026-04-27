// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';

globalThis.chrome = {
  storage: {
    local: {
      get: vi.fn(() => Promise.resolve({})),
      set: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
    },
  },
  runtime: { onMessage: { addListener: () => {} } },
};

vi.mock('../src/mdh/ai.js', () => ({
  getCached: vi.fn(),
  ask: vi.fn(),
}));

const AiInsight = (await import('../src/mdh/components/AiInsight.jsx')).default;
const ai = await import('../src/mdh/ai.js');
const store = await import('../src/mdh/store.js');

function flush() { return new Promise((r) => setTimeout(r, 0)); }

beforeEach(() => {
  store.aiEnabled.value = true;
  store.aiStatus.value = 'ready';
  document.body.innerHTML = '';
  ai.getCached.mockReset();
  ai.ask.mockReset();
});

describe('AiInsight loading-state race', () => {
  it('does not show "Thinking..." once a cached result replaces an in-flight load (regression)', async () => {
    let askResolve;
    ai.getCached.mockImplementation(async (input) => {
      if (input === 'second-error') return 'cached explanation for second';
      return null;
    });
    ai.ask.mockImplementation(() => new Promise((r) => { askResolve = r; }));

    const root = document.createElement('div');
    document.body.appendChild(root);

    // Mount with first input — cache miss → ai.ask is in-flight, loading=true
    render(h(AiInsight, { input: 'first-error', type: 'error' }), root);
    await flush(); await flush();

    // Switch to a different input that has a cached result — the previous
    // effect's cleanup cancels the in-flight ask. Before the fix, loading
    // stayed true because the cached-hit branch never reset it.
    render(h(AiInsight, { input: 'second-error', type: 'error' }), root);
    await flush(); await flush();

    // The original (now cancelled) ai.ask resolves late — must not flip state.
    askResolve('late stale result');
    await flush(); await flush();

    // Open the popover so the explanation content is in the DOM.
    const btn = root.querySelector('.ai-insight-btn');
    expect(btn).toBeTruthy();
    btn.click();
    await flush(); await flush();

    expect(root.textContent).toContain('cached explanation for second');
    expect(root.textContent).not.toContain('Thinking');
    expect(root.querySelector('.ai-thinking')).toBeNull();
  });

  it('still shows "Thinking..." while a fresh request is in-flight', async () => {
    ai.getCached.mockResolvedValue(null);
    ai.ask.mockImplementation(() => new Promise(() => {})); // never resolves

    const root = document.createElement('div');
    document.body.appendChild(root);
    render(h(AiInsight, { input: 'pending-error', type: 'error' }), root);
    await flush(); await flush();

    root.querySelector('.ai-insight-btn').click();
    await flush();

    expect(root.querySelector('.ai-thinking')).not.toBeNull();
    expect(root.textContent).toContain('Thinking');
  });

  it('renders an INPUT_TOO_LARGE failure in the info style and hides the AI footer', async () => {
    ai.getCached.mockResolvedValue(null);
    const tooLarge = Object.assign(new Error('This record is too large for the on-device AI to summarise.'), {
      code: 'INPUT_TOO_LARGE',
    });
    ai.ask.mockRejectedValue(tooLarge);

    const root = document.createElement('div');
    document.body.appendChild(root);
    render(h(AiInsight, { input: { huge: 'doc' }, type: 'record' }), root);
    await flush(); await flush();

    root.querySelector('.ai-insight-btn').click();
    await flush(); await flush();

    expect(root.querySelector('.ai-explain-info')).not.toBeNull();
    expect(root.querySelector('.ai-explain-error')).toBeNull();
    expect(root.textContent).toContain('too large for the on-device AI');
    expect(root.querySelector('.ai-insight-footer')).toBeNull();
  });

  it('renders a real failure in the error style with the AI footer', async () => {
    ai.getCached.mockResolvedValue(null);
    ai.ask.mockRejectedValue(new Error('model crashed'));

    const root = document.createElement('div');
    document.body.appendChild(root);
    render(h(AiInsight, { input: 'boom', type: 'error' }), root);
    await flush(); await flush();

    root.querySelector('.ai-insight-btn').click();
    await flush(); await flush();

    expect(root.querySelector('.ai-explain-error')).not.toBeNull();
    expect(root.querySelector('.ai-explain-info')).toBeNull();
    expect(root.querySelector('.ai-insight-footer')).not.toBeNull();
  });
});
