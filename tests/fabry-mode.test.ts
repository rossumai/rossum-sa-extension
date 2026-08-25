// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import * as store from '../src/fabry/store.js';
import { TAB_SCOPED_KEYS } from '../src/console/tabState.js';

beforeEach(() => {
  store.fabryMode.value = 'chat';
});

describe('fabryMode', () => {
  it('defaults to chat', () => {
    expect(store.fabryMode.value).toBe('chat');
  });
  it('setFabryMode accepts architect and coerces anything else to chat', () => {
    store.setFabryMode('architect');
    expect(store.fabryMode.value).toBe('architect');
    store.setFabryMode('nonsense');
    expect(store.fabryMode.value).toBe('chat');
    store.setFabryMode('architect');
    store.setFabryMode('chat');
    expect(store.fabryMode.value).toBe('chat');
  });
  it('is a per-tab navigation key', () => {
    expect(TAB_SCOPED_KEYS).toContain('fabryMode');
  });
});
