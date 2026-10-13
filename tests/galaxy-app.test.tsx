// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';

const sceneCalls = {
  created: 0,
  lastData: null as any,
  destroyed: 0,
  hoverCb: null as any,
  clickCb: null as any,
};
vi.mock('../src/galaxy/scene.js', () => ({
  createScene: () => {
    sceneCalls.created++;
    return {
      setData: (d: any) => {
        sceneCalls.lastData = d;
      },
      onHover: (cb: any) => {
        sceneCalls.hoverCb = cb;
      },
      onClick: (cb: any) => {
        sceneCalls.clickCb = cb;
      },
      focus: () => {},
      setIdleSpin: () => {},
      setVisibleTypes: () => {},
      destroy: () => {
        sceneCalls.destroyed++;
      },
    };
  },
}));

const initGalaxy = vi.hoisted(() => vi.fn());
vi.mock('../src/galaxy/index.jsx', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/galaxy/index.jsx')>()),
  initGalaxy,
}));

import App from '../src/galaxy/components/App.jsx';
import * as store from '../src/galaxy/store.js';

function mount(connected: any) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(<App connected={connected} />, root);
  return root;
}

beforeEach(() => {
  sceneCalls.created = 0;
  sceneCalls.lastData = null;
  sceneCalls.destroyed = 0;
  sceneCalls.hoverCb = null;
  sceneCalls.clickCb = null;
  store.graph.value = { nodes: [], links: [] };
  store.loading.value = false;
  store.loadedCount.value = 0;
  store.error.value = null;
  store.retryable.value = false;
  store.hoveredNodeId.value = null;
  store.selectedNodeId.value = null;
  store.visibleTypes.value = {
    organization: true,
    workspace: true,
    queue: true,
    hook: true,
    engine: true,
  };
});

describe('Galaxy App', () => {
  it('shows a not-connected message when connected=false', () => {
    const root = mount(false);
    expect(root.querySelector('.empty-state')).not.toBe(null);
    expect(root.textContent).toMatch(/not connected/i);
    expect(root.querySelector('.empty-state button')).toBeNull();
    expect(sceneCalls.created).toBe(0);
  });
  it('not connected because of a 429: shows the error and a Retry that re-checks the session', () => {
    store.error.value = 'Rossum is rate-limiting requests. Try again in 8 s.';
    store.retryable.value = true;
    const root = mount(false);
    expect(root.textContent).toContain('Rossum is rate-limiting requests. Try again in 8 s.');
    expect(root.textContent).not.toMatch(/not connected/i);
    const btn = root.querySelector<HTMLButtonElement>('.empty-state button.btn')!;
    expect(btn.textContent).toBe('Retry');
    initGalaxy.mockClear();
    btn.click();
    expect(initGalaxy).toHaveBeenCalledTimes(1);
  });
  it('not connected with a non-retryable error: shows the error, no Retry', () => {
    store.error.value = 'Session expired';
    const root = mount(false);
    expect(root.textContent).toContain('Session expired');
    expect(root.querySelector('.empty-state button')).toBeNull();
  });
  it('mounts the scene and pushes graph data when connected', async () => {
    store.graph.value = {
      nodes: [
        {
          detail: [],
          id: 'queue:1',
          type: 'queue',
          rawId: '1',
          name: 'Q',
          color: '#29d4c5',
          val: 5,
        },
      ],
      links: [],
    };
    mount(true);
    await Promise.resolve();
    expect(sceneCalls.created).toBe(1);
    expect(sceneCalls.lastData.nodes.length).toBe(1);
  });
  it('shows a loading overlay while loading', () => {
    store.loading.value = true;
    const root = mount(true);
    expect(root.querySelector('.galaxy-loading')).not.toBe(null);
  });
  it('shows the objects-loaded count when loadedCount > 0', () => {
    store.loading.value = true;
    store.loadedCount.value = 42;
    const root = mount(true);
    const countEl = root.querySelector('.galaxy-loading-count');
    expect(countEl).not.toBe(null);
    expect(countEl!.textContent).toContain('42 objects loaded');
  });
  it('does not render the count span when loadedCount is 0', () => {
    store.loading.value = true;
    store.loadedCount.value = 0;
    const root = mount(true);
    expect(root.querySelector('.galaxy-loading-count')).toBe(null);
    expect(root.querySelector('.galaxy-loading')).not.toBe(null);
  });
  it('shows the error overlay with the store error message', () => {
    store.error.value = 'Boom';
    const root = mount(true);
    expect(root.querySelector('.galaxy-error')!.textContent).toContain('Boom');
  });
  it('wires scene hover/click callbacks to the store signals', () => {
    mount(true);
    sceneCalls.hoverCb('hook:9');
    expect(store.hoveredNodeId.value).toBe('hook:9');
    sceneCalls.clickCb('queue:1');
    expect(store.selectedNodeId.value).toBe('queue:1');
    sceneCalls.hoverCb(null);
    expect(store.hoveredNodeId.value).toBe(null);
  });
  it('destroys the scene on unmount', () => {
    const root = mount(true);
    render(null, root);
    expect(sceneCalls.destroyed).toBe(1);
  });
  it('pushes graph changes into the live scene after mount', async () => {
    mount(true);
    store.graph.value = {
      nodes: [
        {
          detail: [],
          id: 'queue:2',
          type: 'queue',
          rawId: '2',
          name: 'Q2',
          color: '#29d4c5',
          val: 5,
        },
      ],
      links: [],
    };
    await vi.waitFor(() => {
      expect(sceneCalls.lastData.nodes.some((n: any) => n.id === 'queue:2')).toBe(true);
    });
  });

  it('shows a Retry button for a retryable error', () => {
    store.error.value = 'Rossum is rate-limiting requests. Try again shortly.';
    store.retryable.value = true;
    const root = mount(true);
    expect(root.querySelector('.galaxy-error button')!.textContent).toBe('Retry');
  });

  it('shows no Retry button for other errors', () => {
    store.error.value = 'Boom';
    const root = mount(true);
    expect(root.querySelector('.galaxy-error button')).toBeNull();
  });
});
