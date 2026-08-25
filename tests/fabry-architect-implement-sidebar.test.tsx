// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
globalThis.requestAnimationFrame = (cb) => {
  cb(0);
  return 0;
};
vi.mock('../src/fabry/architect/actions.js', () => ({
  loadArchitect: vi.fn().mockResolvedValue(undefined),
  addDeliverable: vi.fn(),
  openDeliverable: vi.fn(),
  runAll: vi.fn(),
  stopRun: vi.fn(),
  moveDeliverable: vi.fn(),
  reRun: vi.fn(),
  deleteDeliverable: vi.fn(),
  reImplement: vi.fn(),
  renameDeliverable: vi.fn(),
}));
vi.mock('../src/ui/Modal.jsx', () => ({ confirmModal: vi.fn(), promptModal: vi.fn() }));
vi.mock('../src/fabry/architect/components/ArmDialog.jsx', () => ({ openArmDialog: vi.fn() }));
import * as actions from '../src/fabry/architect/actions.js';
import { openArmDialog } from '../src/fabry/architect/components/ArmDialog.jsx';
import { promptModal } from '../src/ui/Modal.jsx';
import * as store from '../src/fabry/architect/store.js';
import * as fstore from '../src/fabry/store.js';
import ArchitectSidebar from '../src/fabry/architect/components/ArchitectSidebar.jsx';
import { deliverable } from './support/architect.js';

function mount() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  act(() => render(<ArchitectSidebar />, root));
  return root;
}
beforeEach(() => {
  vi.clearAllMocks();
  store.deliverables.value = [];
  store.results.value = {};
  store.implement.value = {};
  store.loaded.value = true;
  store.running.value = false;
  store.implementRunning.value = false;
  fstore.implementAllowed.value = true;
});

describe('Sidebar implement controls (kill-switch on)', () => {
  it('no longer renders an "Implement all" button (implement is per-deliverable only)', () => {
    store.deliverables.value = [
      deliverable({ id: 'a', text: 'A', order: 1 }),
      deliverable({ id: 'b', text: 'B', order: 2 }),
    ];
    const root = mount();
    expect(
      [...root.querySelectorAll('button')].find((b) => /implement all/i.test(b.textContent)),
    ).toBeFalsy();
  });
  it('kebab menu shows an Implement item that opens the arm dialog and chains to reImplement', async () => {
    store.deliverables.value = [deliverable({ id: 'a', text: 'A', order: 1 })];
    const root = mount();
    act(() => {
      root.querySelector<HTMLElement>('.fabry-arch-kebab')!.click();
    });
    const menu = root.querySelector('.fabry-arch-menu');
    const implBtn = [...menu!.querySelectorAll('.fabry-arch-menu-item')].find((b) =>
      /implement/i.test(b.textContent),
    );
    expect(implBtn).toBeTruthy();
    act(() => {
      (implBtn as HTMLElement).click();
    });
    expect(openArmDialog).toHaveBeenCalledTimes(1);
    expect(root.querySelector('.fabry-arch-menu')).toBeNull(); // menu closes
    const [count, onConfirm] = vi.mocked(openArmDialog).mock.calls[0];
    expect(count).toBe(1);
    await act(async () => {
      await onConfirm();
    });
    expect(actions.reImplement).toHaveBeenCalledWith('a');
  });
  it('kebab Implement item is disabled while implementRunning', () => {
    store.deliverables.value = [deliverable({ id: 'a', text: 'A', order: 1 })];
    store.implementRunning.value = true;
    const root = mount();
    act(() => {
      root.querySelector<HTMLElement>('.fabry-arch-kebab')!.click();
    });
    const menu = root.querySelector('.fabry-arch-menu');
    const implBtn = [...menu!.querySelectorAll('.fabry-arch-menu-item')].find((b) =>
      /implement/i.test(b.textContent),
    );
    expect((implBtn as HTMLButtonElement).disabled).toBe(true);
  });
  it('hides the kebab Implement item when the kill-switch is off', () => {
    fstore.implementAllowed.value = false;
    store.deliverables.value = [deliverable({ id: 'a', text: 'A', order: 1 })];
    const root = mount();
    act(() => {
      root.querySelector<HTMLElement>('.fabry-arch-kebab')!.click();
    });
    const menu = root.querySelector('.fabry-arch-menu');
    expect(
      [...menu!.querySelectorAll('.fabry-arch-menu-item')].find((b) =>
        /implement/i.test(b.textContent),
      ),
    ).toBeFalsy();
  });
  it('kebab menu Rename opens a prompt that renames the deliverable', () => {
    store.deliverables.value = [deliverable({ id: 'a', text: 'A', order: 1, title: 'Old title' })];
    const root = mount();
    act(() => {
      root.querySelector<HTMLElement>('.fabry-arch-kebab')!.click();
    });
    const menu = root.querySelector('.fabry-arch-menu');
    const renameBtn = [...menu!.querySelectorAll('.fabry-arch-menu-item')].find((b) =>
      /rename/i.test(b.textContent),
    );
    expect(renameBtn).toBeTruthy();
    act(() => {
      (renameBtn as HTMLElement).click();
    });
    expect(promptModal).toHaveBeenCalled();
    const submit = vi.mocked(promptModal).mock.calls[0][2];
    submit!('New title');
    expect(actions.renameDeliverable).toHaveBeenCalledWith('a', 'New title');
  });
});
