import { describe, it, expect, beforeEach } from 'vitest';
import * as store from '../src/galaxy/store.js';

describe('galaxy store', () => {
  it('exposes the shell-driven connection signals with safe defaults', () => {
    expect(store.domain.value).toBe('');
    expect(store.token.value).toBe('');
    expect(store.connected.value).toBe(null); // tri-state: null = not yet probed
  });
  it('starts with an empty graph and idle UI state', () => {
    expect(store.graph.value).toEqual({ nodes: [], links: [] });
    expect(store.loading.value).toBe(false);
    expect(store.loadedCount.value).toBe(0);
    expect(store.error.value).toBe(null);
    expect(store.selectedNodeId.value).toBe(null);
    expect(store.hoveredNodeId.value).toBe(null);
  });

  describe('visibleTypes', () => {
    beforeEach(() => {
      // Reset to all-visible before each test.
      store.visibleTypes.value = {
        organization: true,
        workspace: true,
        queue: true,
        hook: true,
        engine: true,
      };
    });

    it('defaults to all five types visible', () => {
      const vis = store.visibleTypes.value;
      expect(vis.organization).toBe(true);
      expect(vis.workspace).toBe(true);
      expect(vis.queue).toBe(true);
      expect(vis.hook).toBe(true);
      expect(vis.engine).toBe(true);
    });

    it('toggleType flips one type to false without mutating others', () => {
      store.toggleType('queue');
      const vis = store.visibleTypes.value;
      expect(vis.queue).toBe(false);
      expect(vis.organization).toBe(true);
      expect(vis.workspace).toBe(true);
      expect(vis.hook).toBe(true);
      expect(vis.engine).toBe(true);
    });

    it('toggleType flips false back to true on a second call', () => {
      store.toggleType('queue');
      expect(store.visibleTypes.value.queue).toBe(false);
      store.toggleType('queue');
      expect(store.visibleTypes.value.queue).toBe(true);
    });
  });
});
