// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';

vi.mock('../src/fabry/architect/actions.js', () => ({
  reRun: vi.fn(),
  stopRun: vi.fn(),
  reImplement: vi.fn(),
  stopImplement: vi.fn(),
  refineTurn: vi.fn(),
  answerRefine: vi.fn(),
  updateDeliverable: vi.fn(),
  setDeliverableState: vi.fn(),
  loadRevisions: vi.fn().mockResolvedValue(undefined),
  openRevision: vi.fn().mockResolvedValue(undefined),
  ensureRevisionText: vi.fn().mockResolvedValue(''),
  restoreRevision: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/fabry/chat.js', () => ({ openChat: vi.fn() }));
vi.mock('../src/fabry/architect/components/ArmDialog.jsx', () => ({ openArmDialog: vi.fn() }));

import * as store from '../src/fabry/architect/store.js';
import * as fstore from '../src/fabry/store.js';
import InspectorRail from '../src/fabry/architect/components/InspectorRail.jsx';
import { deliverable } from './support/architect.js';

const D = [
  deliverable({ id: 'd1', text: '# One', order: 1, title: 'One', titleSource: 'manual' }),
  deliverable({ id: 'd2', text: '# Two', order: 2, title: 'Two', titleSource: 'manual' }),
];
function mount() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  act(() => {
    render(<InspectorRail />, root);
  });
  return root;
}
beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
  store.deliverables.value = D;
  store.results.value = {
    d1: { chatId: null, verdict: 'pass', evidence: 'ok', stale: false },
    d2: { chatId: null, verdict: 'fail', evidence: 'no rule', stale: false },
  };
  store.implement.value = {};
  store.implementRunning.value = false;
  store.running.value = false;
  store.spyTarget.value = 'd1';
  store.settledTarget.value = 'd1';
  store.pinnedTarget.value = null;
  store.reviewTarget.value = null;
  fstore.implementAllowed.value = true;
});

describe('InspectorRail', () => {
  it('names the deliverable it is inspecting and follows the scroll once it settles', () => {
    const root = mount();
    expect(root.querySelector('.fabry-rail-name')!.textContent).toMatch(/One/);
    // The rail follows the SETTLED target, not the live one — a fast scroll must not re-render this
    // panel on every frame (store.setSettledTarget explains the measurement behind that).
    act(() => {
      store.setSpyTarget('d2');
    });
    expect(root.querySelector('.fabry-rail-name')!.textContent).toMatch(/One/);
    act(() => {
      store.setSettledTarget('d2', { immediate: true });
    });
    expect(root.querySelector('.fabry-rail-name')!.textContent).toMatch(/Two/);
    expect(root.querySelector('.fabry-rail-for')!.textContent).toMatch(/Inspecting/);
  });

  it('pinning stops it following, and says so', () => {
    const root = mount();
    act(() => {
      root.querySelector<HTMLElement>('.fabry-rail-pin')!.click();
    });
    expect(store.pinnedTarget.value).toBe('d1');
    act(() => {
      store.setSettledTarget('d2', { immediate: true });
    });
    expect(root.querySelector('.fabry-rail-name')!.textContent).toMatch(/One/);
    expect(root.querySelector('.fabry-rail-for')!.textContent).toMatch(/Pinned/i);
  });

  it('HOLDS the target while a check runs for the shown deliverable', () => {
    const root = mount();
    act(() => {
      store.setResult('d1', { verdict: null, evidence: '', chatId: null, running: true });
    });
    act(() => {
      store.setSettledTarget('d2', { immediate: true });
    });
    expect(root.querySelector('.fabry-rail-name')!.textContent).toMatch(/One/);
    expect(root.querySelector('.fabry-rail-held')).toBeTruthy();
  });

  it('shows the verdict for its target and offers every tab', () => {
    const root = mount();
    expect(root.textContent).toMatch(/Met/);
    // Check, Refine, Implement, History, Assets — the fifth is the organization's files.
    expect(root.querySelectorAll('.fabry-rail-tab').length).toBe(5);
  });

  it('hides the Implement tab when the loop is not available', () => {
    fstore.implementAllowed.value = false;
    const root = mount();
    expect(root.querySelectorAll('.fabry-rail-tab').length).toBe(4);
    expect(root.textContent).not.toMatch(/Implement/);
  });

  it('offers to open a diff at document width, for the panels that need the room', () => {
    const root = mount();
    expect(root.querySelector('.fabry-rail-wide')).toBe(null); // Check needs no extra width
    act(() => {
      (
        [...root.querySelectorAll('.fabry-rail-tab')].find((t) =>
          /History/.test(t.textContent),
        ) as HTMLElement
      ).click();
    });
    act(() => {
      root.querySelector<HTMLElement>('.fabry-rail-wide')!.click();
    });
    expect(store.reviewTarget.value).toEqual({ id: 'd1', kind: 'history' });
  });

  it('renders nothing at all when there are no deliverables', () => {
    store.deliverables.value = [];
    expect(mount().querySelector('.fabry-rail')).toBe(null);
  });
});
