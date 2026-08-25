// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h } from 'preact';
import { render } from 'preact';
import { act } from 'preact/test-utils';

vi.mock('../src/fabry/architect/actions.js', () => ({
  loadRevisions: vi.fn().mockResolvedValue(undefined),
  openRevision: vi.fn().mockResolvedValue(undefined),
  ensureRevisionText: vi.fn().mockResolvedValue(''),
  restoreRevision: vi.fn().mockResolvedValue(undefined),
}));

import * as actions from '../src/fabry/architect/actions.js';
import * as store from '../src/fabry/architect/store.js';
import HistoryPanel from '../src/fabry/architect/components/HistoryPanel.jsx';
import { deliverable } from './support/architect.js';

const D = deliverable({ id: 'd1', text: 'current text here', editedAt: Date.now() - 60_000 });
function mount(deliverable = D) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  act(() => { render(h(HistoryPanel, { deliverable }), root); });
  return root;
}
const rows = (root: any) => [...root.querySelectorAll('.fabry-arch-hist-btn')];

beforeEach(() => {
  vi.clearAllMocks();
  store.revisions.value = {};
  store.revisionTexts.value = {};
  store.selectedRevision.value = null;
});

describe('HistoryPanel', () => {
  it('asks for the versions of the deliverable it is given', () => {
    mount();
    expect(actions.loadRevisions).toHaveBeenCalledWith('d1');
  });

  it('says so plainly when there is no history yet', () => {
    store.revisions.value = { d1: { loading: false, items: [] } };
    const root = mount();
    expect(root.textContent).toMatch(/No earlier versions yet/i);
    expect(rows(root)).toHaveLength(0);
  });

  it('distinguishes loading from empty', () => {
    store.revisions.value = { d1: { loading: true, items: null } };
    expect(mount().textContent).toMatch(/Loading versions/i);
  });

  it('surfaces a load error instead of an empty state', () => {
    store.revisions.value = { d1: { loading: false, error: 'Session expired.' } };
    const root = mount();
    expect(root.querySelector('.fabry-arch-hist-error')!.textContent).toMatch(/Session expired/);
  });

  it('lists a row per version with its kind of change, newest first, plus the live text as a landmark', () => {
    const now = Date.now();
    store.revisions.value = { d1: { loading: false, items: [
      { id: 'r2', at: now - 120_000, source: 'refine' },
      { id: 'r1', at: now - 7_200_000, source: 'edit' },
    ] } };
    const root = mount();
    const labels = rows(root).map((b) => b.textContent);
    expect(labels[0]).toMatch(/Refine accepted/);
    expect(labels[0]).toMatch(/2m ago/);
    expect(labels[1]).toMatch(/Edited/);
    expect(labels[1]).toMatch(/2h ago/);
    // The current text is shown but is not a version: no button, nothing to restore.
    const current = root.querySelector('.fabry-arch-hist-current')!;
    expect(current.textContent).toMatch(/Current/);
    expect(current.tagName).not.toBe('BUTTON');
  });

  it('opens the newest version on its own, so the panel shows a diff rather than a prompt', () => {
    store.revisions.value = { d1: { loading: false, items: [{ id: 'r2', at: 2, source: 'edit' }, { id: 'r1', at: 1, source: 'edit' }] } };
    mount();
    expect(actions.openRevision).toHaveBeenCalledWith('d1', 'r2');
  });

  it('selecting a row asks for that version', () => {
    store.revisions.value = { d1: { loading: false, items: [{ id: 'r2', at: 2, source: 'edit' }, { id: 'r1', at: 1, source: 'edit' }] } };
    store.selectedRevision.value = 'r2';
    const root = mount();
    act(() => { rows(root)[1].click(); });
    expect(actions.openRevision).toHaveBeenCalledWith('d1', 'r1');
  });

  it('diffs the selected version against the live text once its text is in hand', () => {
    store.revisions.value = { d1: { loading: false, items: [{ id: 'r1', at: 1, source: 'edit' }] } };
    const root = mount();
    // Selection is set AFTER mount: the panel is keyed per deliverable and clears the
    // selection when it mounts, which is how switching deliverable is handled.
    act(() => { store.revisionTexts.value = { r1: 'current text gone' }; store.selectedRevision.value = 'r1'; });
    const diff = root.querySelector('.fabry-arch-hist-diff')!;
    expect(diff).toBeTruthy();
    expect(diff.querySelector('del')).toBeTruthy();   // 'gone' removed
    expect(diff.querySelector('ins')).toBeTruthy();   // 'here' added
  });

  it('waits for the text rather than diffing against nothing', () => {
    store.revisions.value = { d1: { loading: false, items: [{ id: 'r1', at: 1, source: 'edit' }] } };
    const root = mount();
    act(() => { store.selectedRevision.value = 'r1'; });
    expect(root.querySelector('.fabry-arch-hist-diff')).toBe(null);
    expect(root.textContent).toMatch(/Loading version/i);
  });

  it('compares against the next version when asked, fetching that side without moving the selection', () => {
    store.revisions.value = { d1: { loading: false, items: [
      { id: 'r2', at: 2, source: 'edit' }, { id: 'r1', at: 1, source: 'edit' },
    ] } };
    const root = mount();
    act(() => { store.revisionTexts.value = { r1: 'one' }; store.selectedRevision.value = 'r1'; });
    const vsNext = [...root.querySelectorAll('.fabry-arch-hist-cmp button')].find((b) => /vs next/i.test(b.textContent));
    act(() => { (vsNext as HTMLElement).click(); });
    expect(actions.ensureRevisionText).toHaveBeenCalledWith('d1', 'r2');
    // and the selection is untouched
    expect(store.selectedRevision.value).toBe('r1');
  });

  it('restores the selected version, and cannot restore before its text is loaded', () => {
    store.revisions.value = { d1: { loading: false, items: [{ id: 'r1', at: 1, source: 'edit' }] } };
    const root = mount();
    act(() => { store.selectedRevision.value = 'r1'; });
    expect(root.querySelector<HTMLButtonElement>('.fabry-arch-hist-restore')!.disabled).toBe(true);

    act(() => { store.revisionTexts.value = { r1: 'old' }; });
    const btn = root.querySelector<HTMLButtonElement>('.fabry-arch-hist-restore')!;
    expect(btn.disabled).toBe(false);
    act(() => { btn.click(); });
    expect(actions.restoreRevision).toHaveBeenCalledWith('d1', 'r1');
  });

  // The flip side of setting selection after mount: mounting for a different deliverable is
  // exactly what clears a stale selection.
  it('drops a selection that belongs to another deliverable', () => {
    store.revisions.value = { d1: { loading: false, items: [] } };
    store.selectedRevision.value = 'r-from-elsewhere';
    mount();
    expect(store.selectedRevision.value).toBe(null);
  });
});
