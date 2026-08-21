// src/devtools/store.ts
import { signal } from '@preact/signals';
import type { ResourceDescriptor } from './resourceFromApiUrl.js';

/** One panel tab. `source: 'page'` is the permanent default tab, pinned first and never closeable. */
export type Tab = {
  id: string;
  source: 'page' | 'link';
  resource: ResourceDescriptor | null;
  original: any;
  buffer: string;
  loading: boolean;
  saving: boolean;
  error: string | null;
  readOnly: boolean;
  dirty: boolean;
  diffPreview: any;
  preview: any;
};

export type Toast = { id: number; message: string };

// Each tab owns its full state (single source of truth). The active tab renders;
// actions operate on a tab by id.
export const tabs = signal<Tab[]>([]);
export const activeId = signal<string | null>(null);
export const linkMenu = signal<any>(null);
export const tabMenu = signal<any>(null);

// Transient toast (e.g. "Live token copied"). null = hidden.
export const toast = signal<Toast | null>(null);

const TOAST_MS = 2_500;

let toastId = 0;
let toastTimer: number | null = null;

function clearToastTimer() {
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
}

// At most one toast at a time. The previous toast's timer is cancelled (and the
// id guarded) so a stale expiry can never wipe a newer message.
export function showToast(message: string): void {
  clearToastTimer();
  const id = ++toastId;
  toast.value = { id, message };
  toastTimer = setTimeout(() => {
    if (toast.value?.id === id) toast.value = null;
    toastTimer = null;
  }, TOAST_MS);
}

// Test helper — reset module state.
export function _resetToast() {
  clearToastTimer();
  toast.value = null;
}

// The copy-curl split-button's "more options" menu (live-token variant). false = closed.
export const curlMenu = signal(false);

let seq = 0;
export function nextTabId() { seq += 1; return `t${seq}`; }

export function keyOf(resource: ResourceDescriptor | null | undefined): string {
  if (!resource) return '';
  if (resource.via === 'queue') return `schema-via-queue:${resource.queueId}`;
  if (resource.via === 'queue-inbox') return `inbox-via-queue:${resource.queueId}`;
  if (resource.via === 'org') return 'org:current';
  return resource.apiPath || `${resource.type}:${resource.id}`;
}

function blankTab(id: string, source: Tab['source'], resource: ResourceDescriptor | null): Tab {
  return { id, source, resource: resource || null, original: null, buffer: '', loading: false, saving: false, error: null, readOnly: false, dirty: false, diffPreview: null, preview: null };
}

export function activeTab() { return tabs.value.find((t) => t.id === activeId.value) || null; }
export function patchTab(id: string, patch: Partial<Tab>) { tabs.value = tabs.value.map((t) => (t.id === id ? { ...t, ...patch } : t)); }
export function setActive(id: string | null) { linkMenu.value = null; tabMenu.value = null; activeId.value = id; }

// The default (page) tab is permanent: always present, never closeable. When no
// resource is detected it stays as a resource-less tab that shows the hint.
export function ensurePageTab() {
  if (tabs.value.some((t) => t.source === 'page')) return;
  const tab = blankTab(nextTabId(), 'page', null);
  tabs.value = [tab, ...tabs.value];
  if (activeId.value === null) activeId.value = tab.id;
}

export function openTab(resource: ResourceDescriptor, source: Tab['source'] = 'link') {
  const k = keyOf(resource);
  const existing = tabs.value.find((t) => keyOf(t.resource) === k);
  if (existing) { activeId.value = existing.id; return existing; }
  const tab = blankTab(nextTabId(), source, resource);
  tabs.value = [...tabs.value, tab];
  activeId.value = tab.id;
  return tab;
}

export function closeTab(id: string) {
  linkMenu.value = null;
  tabMenu.value = null;
  const idx = tabs.value.findIndex((t) => t.id === id);
  if (idx === -1) return;
  if (tabs.value[idx].source === 'page') return; // the default tab is never closeable
  const next = tabs.value.filter((t) => t.id !== id);
  tabs.value = next;
  if (activeId.value === id) activeId.value = (next[idx] || next[idx - 1] || null)?.id ?? null;
}

export function closeOtherTabs(id: string) {
  // Keep the clicked tab AND the permanent page (default) tab.
  tabs.value = tabs.value.filter((t) => t.id === id || t.source === 'page');
  // Point at the clicked tab if it survived; otherwise fall back to a real tab
  // (the page tab always survives, so this never lands on a dangling id).
  activeId.value = tabs.value.some((t) => t.id === id) ? id : (tabs.value[0] ? tabs.value[0].id : null);
  linkMenu.value = null;
  tabMenu.value = null;
}

// The single page (default) tab follows the inspected page and is never dropped.
// With no detected resource it becomes resource-less (its body shows the hint).
export function syncPageTab(resource: ResourceDescriptor | null) {
  const pageTab = tabs.value.find((t) => t.source === 'page');
  if (!pageTab) {
    const tab = blankTab(nextTabId(), 'page', resource || null);
    tabs.value = [tab, ...tabs.value];
    if (activeId.value === null) activeId.value = tab.id;
    return { tab, changed: true };
  }
  if (!resource) {
    if (pageTab.resource === null) return { tab: pageTab, changed: false };
    const reset = blankTab(pageTab.id, 'page', null);
    tabs.value = tabs.value.map((t) => (t.id === pageTab.id ? reset : t));
    return { tab: reset, changed: true };
  }
  if (keyOf(pageTab.resource) !== keyOf(resource)) {
    const reset = blankTab(pageTab.id, 'page', resource);
    tabs.value = tabs.value.map((t) => (t.id === pageTab.id ? reset : t));
    return { tab: reset, changed: true };
  }
  return { tab: pageTab, changed: false };
}

export function moveTab(dragId: string, dropId: string) {
  if (!dragId || !dropId || dragId === dropId) return;
  const arr = tabs.value;
  const drag = arr.find((t) => t.id === dragId);
  const drop = arr.find((t) => t.id === dropId);
  if (!drag || !drop || drag.source === 'page' || drop.source === 'page') return; // root stays pinned first
  const without = arr.filter((t) => t.id !== dragId);
  const idx = without.findIndex((t) => t.id === dropId);
  without.splice(idx, 0, drag);
  tabs.value = without;
}

// Non-signal holder for the active CodeMirror view (for search integration). `any` because
// the only consumer calls into CodeMirror's own API, which this module does not import.
export const views: { active: any } = { active: null };

// Seed the permanent default tab so it's visible from the panel's first paint.
ensurePageTab();
