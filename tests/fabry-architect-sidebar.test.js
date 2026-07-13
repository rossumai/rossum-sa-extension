// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
globalThis.requestAnimationFrame = (cb) => { cb(0); return 0; };
globalThis.cancelAnimationFrame = () => {};
vi.mock('../src/fabry/architect/actions.js', () => ({
  loadArchitect: vi.fn().mockResolvedValue(undefined),
  addDeliverable: vi.fn(), openDeliverable: vi.fn(), runAll: vi.fn(), stopRun: vi.fn(),
  moveDeliverable: vi.fn(), reRun: vi.fn(), deleteDeliverable: vi.fn(),
}));
vi.mock('../src/ui/Modal.jsx', () => ({ confirmModal: vi.fn() }));
import * as actions from '../src/fabry/architect/actions.js';
import { confirmModal } from '../src/ui/Modal.jsx';
import * as store from '../src/fabry/architect/store.js';
import ArchitectSidebar from '../src/fabry/architect/components/ArchitectSidebar.jsx';
const flush = () => new Promise((r) => setTimeout(r, 0));
function mount() { const root = document.createElement('div'); document.body.appendChild(root); render(h(ArchitectSidebar, null), root); return root; }
beforeEach(() => {
  vi.clearAllMocks();
  store.deliverables.value = []; store.results.value = {}; store.activeId.value = null;
  store.loaded.value = true; store.loadError.value = null; store.running.value = false;
});

describe('ArchitectSidebar', () => {
  it('loads on mount', async () => { mount(); await flush(); expect(actions.loadArchitect).toHaveBeenCalled(); });
  it('renders a row per deliverable with a title', () => {
    store.deliverables.value = [{ id: 'a', text: '# VAT', order: 1 }, { id: 'b', text: 'plain', order: 2 }];
    const root = mount();
    const rows = root.querySelectorAll('.fabry-arch-item');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toMatch(/VAT/);
  });
  it('marks the active row and click opens a deliverable', () => {
    store.deliverables.value = [{ id: 'a', text: 'A', order: 1 }];
    store.activeId.value = 'a';
    const root = mount();
    expect(root.querySelector('.fabry-arch-item.active')).toBeTruthy();
    root.querySelector('.fabry-arch-item').click();
    expect(actions.openDeliverable).toHaveBeenCalledWith('a');
  });
  it('renders status dots by verdict + running spinner + stale', () => {
    store.deliverables.value = [{ id: 'a', text: 'A', order: 1 }, { id: 'b', text: 'B', order: 2 }, { id: 'c', text: 'C', order: 3 }];
    store.results.value = { a: { verdict: 'pass', stale: false }, b: { running: true }, c: { verdict: 'fail', stale: true } };
    const root = mount();
    const dots = root.querySelectorAll('.fabry-arch-dot');
    expect(dots[0].className).toMatch(/pass/);
    expect(root.querySelector('.fabry-arch-dot.running')).toBeTruthy();
    expect(root.querySelector('.fabry-arch-dot.stale')).toBeTruthy();
  });
  it('New deliverable + Run all wire to actions; Run disabled when empty', () => {
    const root = mount();
    expect(root.querySelector('.fabry-arch-runall').disabled).toBe(true);
    root.querySelector('.fabry-arch-new').click();
    expect(actions.addDeliverable).toHaveBeenCalled();
    store.deliverables.value = [{ id: 'a', text: 'A', order: 1 }];
    const root2 = mount();
    root2.querySelector('.fabry-arch-runall').click();
    expect(actions.runAll).toHaveBeenCalled();
  });
  it('while running the Run-all control shows Stop with a progress count', () => {
    store.deliverables.value = [{ id: 'a', text: 'A', order: 1 }, { id: 'b', text: 'B', order: 2 }];
    store.results.value = { a: { verdict: 'pass', stale: false, running: false } };
    store.running.value = true;
    const root = mount();
    const btn = root.querySelector('.fabry-arch-runall');
    expect(btn.textContent).toMatch(/stop/i);
    btn.click();
    expect(actions.stopRun).toHaveBeenCalled();
    expect(root.querySelector('.fabry-arch-summary').textContent).toMatch(/1\s*\/\s*2/);
  });
  it('idle summary shows the met / not-met breakdown', () => {
    store.deliverables.value = [{ id: 'a', text: 'A', order: 1 }, { id: 'b', text: 'B', order: 2 }, { id: 'c', text: 'C', order: 3 }];
    store.results.value = { a: { verdict: 'pass', running: false }, b: { verdict: 'fail', running: false } };
    const root = mount();
    const s = root.querySelector('.fabry-arch-summary').textContent;
    expect(s).toMatch(/1 met/);
    expect(s).toMatch(/1 not met/);
  });
  it('summary ignores orphan results whose id is no longer in the list', () => {
    store.deliverables.value = [{ id: 'a', text: 'A', order: 1 }];
    store.results.value = { a: { verdict: 'pass', running: false }, gone: { verdict: 'fail', running: false } };
    const root = mount();
    const s = root.querySelector('.fabry-arch-summary').textContent;
    expect(s).toMatch(/1 deliverable/);
    expect(s).toMatch(/1 met/);
    expect(s).not.toMatch(/not met/); // the orphan 'fail' (id not in ds) is excluded
  });
  it('Enter on the kebab does not open the deliverable, but Enter on the row does', () => {
    store.deliverables.value = [{ id: 'a', text: 'A', order: 1 }];
    const root = mount();
    root.querySelector('.fabry-arch-kebab').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(actions.openDeliverable).not.toHaveBeenCalled(); // nested button doesn't bubble into open
    root.querySelector('.fabry-arch-item').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(actions.openDeliverable).toHaveBeenCalledWith('a');
  });
  it('rows are draggable; dropping one onto another reorders via moveDeliverable', () => {
    store.deliverables.value = [{ id: 'a', text: 'A', order: 0 }, { id: 'b', text: 'B', order: 1 }, { id: 'c', text: 'C', order: 2 }];
    const root = mount();
    const rows = root.querySelectorAll('.fabry-arch-item');
    expect(rows[0].getAttribute('draggable')).toBe('true');
    act(() => { rows[0].dispatchEvent(new Event('dragstart', { bubbles: true })); }); // drag A
    act(() => { rows[2].dispatchEvent(new Event('drop', { bubbles: true })); });       // drop on C (index 2)
    expect(actions.moveDeliverable).toHaveBeenCalledWith('a', 2);
  });
});

describe('ArchitectSidebar — kebab menu', () => {
  it('opens a menu; Re-run runs that deliverable and closes', () => {
    store.deliverables.value = [{ id: 'a', text: 'A', order: 1 }];
    const root = mount();
    act(() => { root.querySelector('.fabry-arch-kebab').click(); });
    const menu = root.querySelector('.fabry-arch-menu');
    expect(menu).toBeTruthy();
    const rerun = [...menu.querySelectorAll('.fabry-arch-menu-item')].find((b) => /re-run/i.test(b.textContent));
    act(() => { rerun.click(); });
    expect(actions.reRun).toHaveBeenCalledWith('a');
    expect(root.querySelector('.fabry-arch-menu')).toBeNull();
  });
  it('clicking the kebab does not open the deliverable', () => {
    store.deliverables.value = [{ id: 'a', text: 'A', order: 1 }];
    const root = mount();
    act(() => { root.querySelector('.fabry-arch-kebab').click(); });
    expect(actions.openDeliverable).not.toHaveBeenCalled();
  });
  it('Delete opens the shared confirm modal; deletes only on confirm', () => {
    store.deliverables.value = [{ id: 'a', text: 'A', order: 1 }];
    const root = mount();
    act(() => { root.querySelector('.fabry-arch-kebab').click(); });
    const del = [...root.querySelectorAll('.fabry-arch-menu-item')].find((b) => b.textContent === 'Delete');
    act(() => { del.click(); });
    expect(confirmModal).toHaveBeenCalled();
    expect(actions.deleteDeliverable).not.toHaveBeenCalled(); // not until confirmed
    expect(root.querySelector('.fabry-arch-menu')).toBeNull(); // menu closed when the dialog opens
    const onConfirm = confirmModal.mock.calls[0][2];
    onConfirm();
    expect(actions.deleteDeliverable).toHaveBeenCalledWith('a');
  });
});
