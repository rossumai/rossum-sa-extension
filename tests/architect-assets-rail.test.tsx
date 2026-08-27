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

// The panel itself is proven in architect-assets-panel-view; what is proven HERE is how the rail
// mounts it, which is the part a `key` would break. A stub keeps the real panel (and its store)
// out of this file entirely.
vi.mock('../src/fabry/architect/components/AssetsPanel.jsx', () => ({
  default: ({ currentId }: any) => h('div', { class: 'assets-stub' }, currentId),
}));

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
const tab = (root: any, label: RegExp) =>
  [...root.querySelectorAll('.fabry-rail-tab')].find((t: any) => label.test(t.textContent)) as
    HTMLElement | undefined;

beforeEach(() => {
  document.body.innerHTML = '';
  store.deliverables.value = D;
  store.results.value = {};
  store.implement.value = {};
  store.implementRunning.value = false;
  store.running.value = false;
  store.spyTarget.value = 'd1';
  store.settledTarget.value = 'd1';
  store.pinnedTarget.value = null;
  store.reviewTarget.value = null;
  fstore.implementAllowed.value = true;
});

describe('the rail’s Assets tab', () => {
  it('is offered beside the per-deliverable panels', () => {
    const root = mount();
    expect(root.querySelectorAll('.fabry-rail-tab').length).toBe(5);
    expect(tab(root, /Assets/)).toBeTruthy();
  });

  it('shows the panel, told which deliverable is in view', () => {
    const root = mount();
    act(() => {
      tab(root, /Assets/)!.click();
    });
    expect(root.querySelector('.assets-stub')!.textContent).toBe('d1');
  });

  // D4, and the whole reason this panel is not keyed: the rail follows the reader's scroll, so a
  // `key={d.id}` would throw away the filter text, the upload log and any open delete confirmation
  // on every section change — and, after a failed read, re-issue the index request too (a
  // SUCCESSFUL read is memoised in the store; a failed one deliberately is not). A remount
  // replaces the DOM node; the same node with new content is "re-sorts".
  it('survives the target changing under it instead of remounting', () => {
    const root = mount();
    act(() => {
      tab(root, /Assets/)!.click();
    });
    const node = root.querySelector('.assets-stub');
    act(() => {
      store.setSettledTarget('d2', { immediate: true });
    });
    expect(root.querySelector('.fabry-rail-name')!.textContent).toMatch(/Two/);
    expect(root.querySelector('.assets-stub')).toBe(node);
    expect(root.querySelector('.assets-stub')!.textContent).toBe('d2');
  });

  it('needs no extra width, so it offers no document-width escape', () => {
    const root = mount();
    act(() => {
      tab(root, /Assets/)!.click();
    });
    expect(root.querySelector('.fabry-rail-wide')).toBe(null);
  });
});
