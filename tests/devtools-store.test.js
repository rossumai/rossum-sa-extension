import { describe, it, expect, beforeEach } from 'vitest';
import * as store from '../src/devtools/store.js';

const R = (type, id) => ({ type, id, apiPath: `/api/v1/${type}s/${id}`, label: type });
beforeEach(() => { store.tabs.value = []; store.activeId.value = null; });

describe('store tabs', () => {
  it('openTab adds + activates, dedups by key on second open', () => {
    const a = store.openTab(R('queue', '1'), 'link');
    expect(store.tabs.value.length).toBe(1);
    expect(store.activeId.value).toBe(a.id);
    const again = store.openTab(R('queue', '1'), 'link');
    expect(again.id).toBe(a.id);
    expect(store.tabs.value.length).toBe(1); // deduped
  });
  it('closeTab activates a neighbor', () => {
    const a = store.openTab(R('queue', '1')); const b = store.openTab(R('queue', '2'));
    store.setActive(a.id);
    store.closeTab(a.id);
    expect(store.tabs.value.length).toBe(1);
    expect(store.activeId.value).toBe(b.id);
  });
  it('patchTab immutably updates a tab', () => {
    const a = store.openTab(R('queue', '1'));
    store.patchTab(a.id, { dirty: true });
    expect(store.activeTab().dirty).toBe(true);
  });
  it('syncPageTab creates a page tab, then updates it when the resource key changes', () => {
    const s1 = store.syncPageTab(R('queue', '1'));
    expect(s1.changed).toBe(true);
    expect(store.tabs.value[0].source).toBe('page');
    const s2 = store.syncPageTab(R('queue', '1'));
    expect(s2.changed).toBe(false); // same key
    const s3 = store.syncPageTab(R('queue', '2'));
    expect(s3.changed).toBe(true);
    expect(store.tabs.value.filter((t) => t.source === 'page').length).toBe(1); // still one page tab
  });
  it('keyOf handles a via:queue descriptor', () => {
    expect(store.keyOf({ via: 'queue', queueId: '9' })).toBe('schema-via-queue:9');
    expect(store.keyOf(R('schema', '3'))).toBe('/api/v1/schemas/3');
  });
  it('keyOf handles a via:queue-inbox descriptor', () => {
    expect(store.keyOf({ via: 'queue-inbox', queueId: '5' })).toBe('inbox-via-queue:5');
  });
  it('keyOf handles a via:org descriptor', () => {
    expect(store.keyOf({ via: 'org' })).toBe('org:current');
  });
  it('parent and sub-resource have distinct keys and openTab does not dedup them', () => {
    const parent = { type: 'annotations', id: '123', apiPath: '/api/v1/annotations/123', label: 'Annotation' };
    const sub = { type: 'annotations', id: '123', apiPath: '/api/v1/annotations/123/content', label: 'Content', readOnly: true };
    const t1 = store.openTab(parent, 'link');
    expect(store.tabs.value.length).toBe(1);
    const t2 = store.openTab(sub, 'link');
    expect(store.tabs.value.length).toBe(2); // NOT deduped
    expect(t1.id).not.toBe(t2.id);
    expect(store.keyOf(parent)).not.toBe(store.keyOf(sub));
  });
  it('syncPageTab(null) keeps the page tab but clears its resource (non-resource page)', () => {
    store.syncPageTab({ type: 'queue', id: '1', apiPath: '/api/v1/queues/1', label: 'Queue' });
    expect(store.tabs.value.some((t) => t.source === 'page' && t.resource)).toBe(true);
    const r = store.syncPageTab(null);
    const pageTab = store.tabs.value.find((t) => t.source === 'page');
    expect(pageTab).toBeTruthy();
    expect(pageTab.resource).toBeNull();
    expect(r.changed).toBe(true);
    expect(r.tab.id).toBe(pageTab.id);
  });
  it('syncPageTab(null) twice is a no-op on the second call', () => {
    store.syncPageTab(null);
    const r = store.syncPageTab(null);
    expect(r.changed).toBe(false);
    expect(store.tabs.value.filter((t) => t.source === 'page').length).toBe(1);
  });
  it('syncPageTab(null) with no page tab creates a resource-less default tab', () => {
    const r = store.syncPageTab(null);
    expect(store.tabs.value.length).toBe(1);
    expect(store.tabs.value[0].source).toBe('page');
    expect(store.tabs.value[0].resource).toBeNull();
    expect(r.changed).toBe(true);
  });
  it('the default page tab remains after navigating to a non-resource page', () => {
    store.syncPageTab({ type: 'queue', id: '1', apiPath: '/api/v1/queues/1', label: 'Queue' });
    store.syncPageTab(null);
    const pageTabs = store.tabs.value.filter((t) => t.source === 'page');
    expect(pageTabs.length).toBe(1);
    expect(pageTabs[0].resource).toBeNull();
  });
  it('ensurePageTab creates the default tab once and is idempotent', () => {
    store.ensurePageTab();
    expect(store.tabs.value.filter((t) => t.source === 'page').length).toBe(1);
    expect(store.activeId.value).toBe(store.tabs.value[0].id);
    store.ensurePageTab();
    expect(store.tabs.value.filter((t) => t.source === 'page').length).toBe(1);
  });
  it('closeTab refuses to close the default (page) tab', () => {
    store.syncPageTab(R('queue', '1'));
    const page = store.tabs.value.find((t) => t.source === 'page');
    store.setActive(page.id);
    store.closeTab(page.id);
    expect(store.tabs.value.some((t) => t.id === page.id)).toBe(true);
    expect(store.activeId.value).toBe(page.id);
  });
  it('closeOtherTabs keeps the page tab as well as the clicked tab', () => {
    store.syncPageTab(R('queue', '1'));
    const page = store.tabs.value.find((t) => t.source === 'page');
    const b = store.openTab(R('hook', '2'), 'link');
    store.openTab(R('user', '3'), 'link');
    store.closeOtherTabs(b.id);
    expect(store.tabs.value.some((t) => t.id === page.id)).toBe(true);
    expect(store.tabs.value.some((t) => t.id === b.id)).toBe(true);
    expect(store.tabs.value.length).toBe(2);
    expect(store.activeId.value).toBe(b.id);
  });
  it('closeOtherTabs(id) keeps only that tab, sets activeId, clears menus', () => {
    const a = store.openTab(R('queue', '1'));
    const b = store.openTab(R('queue', '2'));
    const c = store.openTab(R('queue', '3'));
    store.linkMenu.value = { url: 'https://test', x: 1, y: 1 };
    store.tabMenu.value = { id: b.id, x: 5, y: 5 };
    store.closeOtherTabs(b.id);
    expect(store.tabs.value.length).toBe(1);
    expect(store.tabs.value[0].id).toBe(b.id);
    expect(store.activeId.value).toBe(b.id);
    expect(store.linkMenu.value).toBeNull();
    expect(store.tabMenu.value).toBeNull();
  });

  describe('moveTab', () => {
    it('reorders link tabs when dragging one before another', () => {
      const a = store.openTab(R('queue', '1'), 'link');
      const b = store.openTab(R('queue', '2'), 'link');
      const c = store.openTab(R('queue', '3'), 'link');
      expect(store.tabs.value.map((t) => t.id)).toEqual([a.id, b.id, c.id]);
      store.moveTab(c.id, a.id);
      expect(store.tabs.value.map((t) => t.id)).toEqual([c.id, a.id, b.id]);
    });

    it('is a no-op when either id is missing', () => {
      const a = store.openTab(R('queue', '1'), 'link');
      store.moveTab(a.id, null);
      expect(store.tabs.value.map((t) => t.id)).toEqual([a.id]);
      store.moveTab(null, a.id);
      expect(store.tabs.value.map((t) => t.id)).toEqual([a.id]);
    });

    it('is a no-op when dragId === dropId', () => {
      const a = store.openTab(R('queue', '1'), 'link');
      const b = store.openTab(R('queue', '2'), 'link');
      store.moveTab(a.id, a.id);
      expect(store.tabs.value.map((t) => t.id)).toEqual([a.id, b.id]);
    });

    it('is a no-op when either tab is the page tab', () => {
      const page = store.openTab(R('queue', '1'), 'page');
      const link = store.openTab(R('queue', '2'), 'link');
      store.moveTab(link.id, page.id);
      expect(store.tabs.value.map((t) => t.id)).toEqual([page.id, link.id]);
      store.moveTab(page.id, link.id);
      expect(store.tabs.value.map((t) => t.id)).toEqual([page.id, link.id]);
    });

    it('page tab always stays first', () => {
      const page = store.openTab(R('queue', '1'), 'page');
      const a = store.openTab(R('queue', '2'), 'link');
      const b = store.openTab(R('queue', '3'), 'link');
      const c = store.openTab(R('queue', '4'), 'link');
      expect(store.tabs.value[0].source).toBe('page');
      store.moveTab(c.id, a.id);
      expect(store.tabs.value[0].id).toBe(page.id);
      expect(store.tabs.value.map((t) => t.id)).toEqual([page.id, c.id, a.id, b.id]);
    });
  });
});
