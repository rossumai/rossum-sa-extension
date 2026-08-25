// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
globalThis.requestAnimationFrame = (cb) => {
  cb(0);
  return 0;
};
globalThis.cancelAnimationFrame = () => {};
vi.mock('../src/fabry/architect/actions.js', () => ({
  loadArchitect: vi.fn().mockResolvedValue(undefined),
  updateDeliverable: vi.fn(),
  deleteDeliverable: vi.fn(),
  reRun: vi.fn(),
  stopRun: vi.fn(),
  refineTurn: vi.fn(),
  answerRefine: vi.fn(),
  renameDeliverable: vi.fn(),
  reImplement: vi.fn(),
  stopImplement: vi.fn(),
  setDeliverableState: vi.fn(),
  loadRevisions: vi.fn().mockResolvedValue(undefined),
  openRevision: vi.fn().mockResolvedValue(undefined),
  ensureRevisionText: vi.fn().mockResolvedValue(''),
  restoreRevision: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/fabry/chat.js', () => ({ openChat: vi.fn() }));
vi.mock('../src/ui/Modal.jsx', () => ({ promptModal: vi.fn() }));
import * as astore from '../src/fabry/architect/store.js';
import * as fstore from '../src/fabry/store.js';
import ArchitectApp from '../src/fabry/architect/components/ArchitectApp.jsx';
import { deliverable } from './support/architect.js';

// The per-deliverable pane was replaced by the unified specification view (2026-08-19), so what this
// file covers is the SHELL: the placeholder, the document column plus the rail, and the legacy notice.
// The view itself is covered by fabry-architect-spec-view / -spec-edit, the rail by -rail, and the
// list by -sidebar.
function mount() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  act(() => {
    render(<ArchitectApp />, root);
  });
  return root;
}
beforeEach(() => {
  vi.clearAllMocks();
  window.Element.prototype.scrollIntoView = function stub() {};
  document.body.innerHTML = '';
  astore.deliverables.value = [];
  astore.results.value = {};
  astore.activeId.value = null;
  astore.loaded.value = true;
  astore.running.value = false;
  astore.loadError.value = null;
  astore.docView.value = 'preview';
  astore.railOpen.value = true;
  astore.spyTarget.value = null;
  astore.pinnedTarget.value = null;
  astore.reviewTarget.value = null;
  astore.legacyNotice.value = null;
  astore.implement.value = {};
  astore.implementRunning.value = false;
  fstore.fabryMode.value = 'architect';
  fstore.implementAllowed.value = true;
});

describe('ArchitectApp shell', () => {
  it('shows a placeholder, and no document or rail, when there are no deliverables', () => {
    const root = mount();
    expect(root.querySelector('.fabry-arch-placeholder')).toBeTruthy();
    expect(root.querySelector('.fabry-spec')).toBe(null);
    expect(root.querySelector('.fabry-rail')).toBe(null);
  });

  it('renders the whole specification plus the inspector rail once there are deliverables', async () => {
    astore.deliverables.value = [
      deliverable({ id: 'a', text: '# A\n\nalpha\n', order: 1 }),
      deliverable({ id: 'b', text: '# B\n\nbeta\n', order: 2 }),
    ];
    const root = mount();
    expect(root.querySelector('.fabry-spec')).toBeTruthy();
    expect(root.querySelector('.fabry-rail')).toBeTruthy();
    await vi.waitFor(() => expect(root.querySelectorAll('[data-deliverable]').length).toBe(2));
    // Both deliverables are on screen at once — the point of the view.
    await vi.waitFor(() => expect(root.textContent).toMatch(/alpha/));
    expect(root.textContent).toMatch(/beta/);
  });

  it('hides the rail when it is collapsed, keeping the document', () => {
    astore.deliverables.value = [deliverable({ id: 'a', text: '# A', order: 1 })];
    astore.railOpen.value = false;
    const root = mount();
    expect(root.querySelector('.fabry-rail')).toBe(null);
    expect(root.querySelector('.fabry-spec')).toBeTruthy();
  });
});

describe('legacy collection notice', () => {
  it('says how many deliverables are still under the previous collection name', () => {
    astore.deliverables.value = [deliverable({ id: 'a', text: '# A', order: 1 })];
    astore.legacyNotice.value = { count: 2, collection: '__mrfabry_architect' };
    const note = mount().querySelector('.fabry-arch-legacy')!;
    expect(note.textContent).toMatch(/2 deliverables still stored/i);
    // The collection NAME is not shown: it means nothing to a reader, and the message is about
    // their documents, not our storage.
    expect(note.textContent).not.toMatch(/mrfabry/);
  });

  it('renders nothing at all in the ordinary single-collection case', () => {
    astore.deliverables.value = [deliverable({ id: 'a', text: '# A', order: 1 })];
    expect(mount().querySelector('.fabry-arch-legacy')).toBe(null);
  });
});
