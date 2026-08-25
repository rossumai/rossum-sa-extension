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
  updateDeliverable: vi.fn(),
  refineTurn: vi.fn(),
  answerRefine: vi.fn(),
  renameDeliverable: vi.fn(),
  reRun: vi.fn(),
  stopRun: vi.fn(),
  setDeliverableState: vi.fn(),
  reImplement: vi.fn().mockResolvedValue(undefined),
  stopImplement: vi.fn(),
  loadRevisions: vi.fn().mockResolvedValue(undefined),
  openRevision: vi.fn().mockResolvedValue(undefined),
  ensureRevisionText: vi.fn().mockResolvedValue(''),
  restoreRevision: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/fabry/chat.js', () => ({ openChat: vi.fn() }));
// The Arm confirmation dialog has its own tests; here openArmDialog is spied so its onConfirm can be
// driven without a real modal in the tree.
vi.mock('../src/fabry/architect/components/ArmDialog.jsx', () => ({ openArmDialog: vi.fn() }));
import * as actions from '../src/fabry/architect/actions.js';
import * as store from '../src/fabry/architect/store.js';
import * as fstore from '../src/fabry/store.js';
import { openArmDialog } from '../src/fabry/architect/components/ArmDialog.jsx';
import InspectorRail from '../src/fabry/architect/components/InspectorRail.jsx';
import { deliverable } from './support/architect.js';

// The implement loop moved from the deliverable pane's bottom console into the inspector rail
// (2026-08-19) when the pane was replaced by the unified specification view. Same panel, new host —
// including the Arm dialog, which is the whole safety story and did not move.
const D = deliverable({ id: 'd1', text: '# One', order: 1, title: 'One', titleSource: 'manual' });
function mount() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  act(() => {
    render(<InspectorRail />, root);
  });
  return root;
}
const implTab = (root: any) =>
  [...root.querySelectorAll('.fabry-rail-tab')].find((t) => /Implement/.test(t.textContent));
function openImplement(root: any) {
  act(() => {
    implTab(root).click();
  });
  return root;
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
  store.deliverables.value = [D];
  store.results.value = {};
  store.implement.value = {};
  store.implementRunning.value = false;
  store.running.value = false;
  store.spyTarget.value = 'd1';
  store.pinnedTarget.value = null;
  store.reviewTarget.value = null;
  fstore.implementAllowed.value = true;
});

describe('Implement panel — now in the inspector rail', () => {
  it('shows an Implement tab; clicking it renders the panel', () => {
    const root = mount();
    expect(implTab(root)).toBeTruthy();
    expect(root.querySelector('.fabry-arch-implement-hd')).toBe(null);
    openImplement(root);
    expect(root.querySelector('.fabry-arch-implement-hd')).toBeTruthy();
  });

  it('the Implement button opens the Arm dialog (count=1), and its onConfirm runs the loop', () => {
    const root = openImplement(mount());
    act(() => {
      root.querySelector('.fabry-arch-implement-run').click();
    });
    expect(openArmDialog).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openArmDialog).mock.calls[0][0]).toBe(1);
    act(() => {
      vi.mocked(openArmDialog).mock.calls[0][1]();
    });
    expect(actions.reImplement).toHaveBeenCalledWith('d1');
  });

  it('hides the Implement tab entirely when the loop is not available', () => {
    fstore.implementAllowed.value = false;
    const root = mount();
    expect(implTab(root)).toBeUndefined();
    expect(root.textContent).not.toMatch(/Implement/);
  });

  it('shows Stop (not Implement) while this deliverable is planning or running, and Stop calls stopImplement', () => {
    store.implement.value = { d1: { status: 'running', tasks: [] } };
    store.implementRunning.value = true;
    const root = openImplement(mount());
    expect(root.querySelector('.fabry-arch-implement-run')).toBe(null);
    act(() => {
      root.querySelector('.fabry-arch-implement-stop').click();
    });
    expect(actions.stopImplement).toHaveBeenCalled();
  });

  it('renders the audit log of writes', () => {
    store.implement.value = {
      d1: {
        status: 'passing',
        writes: [{ tool: 'create_rule', argsSummary: 'Route by type', ok: true }],
      },
    };
    const root = openImplement(mount());
    const audit = root.querySelector('.fabry-arch-implement-audit');
    expect(audit.textContent).toMatch(/create_rule/);
    expect(audit.querySelector('li').className).toBe('ok');
  });

  it('renders the task list with per-task status classes and origin', () => {
    store.implement.value = {
      d1: {
        status: 'running',
        tasks: [
          { id: 't1', text: 'Create the rule', status: 'done', origin: 'plan' },
          { id: 't2', text: 'Attach the hook', status: 'pending', origin: 'discovered' },
        ],
      },
    };
    store.implementRunning.value = true;
    const root = openImplement(mount());
    const items = [...root.querySelectorAll('.fabry-arch-task')];
    expect(items.map((li) => li.className)).toEqual([
      'fabry-arch-task task-done',
      'fabry-arch-task task-pending',
    ]);
    expect(items[1].textContent).toMatch(/discovered/);
    expect(root.querySelector('.fabry-arch-spin')).toBeTruthy();
  });

  it('shows no spinner when the loop is not globally running, even mid-status (e.g. after Stop)', () => {
    store.implement.value = { d1: { status: 'running', tasks: [] } };
    store.implementRunning.value = false;
    const root = openImplement(mount());
    expect(root.querySelector('.fabry-arch-spin')).toBe(null);
  });

  it('shows an implemented status when passing', () => {
    store.implement.value = { d1: { status: 'passing', tasks: [] } };
    const root = openImplement(mount());
    expect(root.querySelector('.fabry-arch-implement-status').textContent).toMatch(/implemented/);
  });
});
