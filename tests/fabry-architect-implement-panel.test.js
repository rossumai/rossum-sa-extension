// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
globalThis.requestAnimationFrame = (cb) => { cb(0); return 0; };
globalThis.cancelAnimationFrame = () => {};
vi.mock('../src/fabry/architect/actions.js', () => ({
  updateDeliverable: vi.fn(), refineTurn: vi.fn(), answerRefine: vi.fn(), renameDeliverable: vi.fn(),
  reImplement: vi.fn().mockResolvedValue(undefined), stopImplement: vi.fn(),
}));
vi.mock('../src/fabry/chat.js', () => ({ openChat: vi.fn() }));
// The Arm confirmation dialog itself is covered by its own tests; here we spy
// on openArmDialog directly (mirrors how the app test spies promptModal) so we
// can drive its onConfirm callback without a real modal in the tree.
vi.mock('../src/fabry/architect/components/ArmDialog.jsx', () => ({ openArmDialog: vi.fn() }));
import * as actions from '../src/fabry/architect/actions.js';
import * as store from '../src/fabry/architect/store.js';
import * as fstore from '../src/fabry/store.js';
import { openArmDialog } from '../src/fabry/architect/components/ArmDialog.jsx';
import DeliverableEditor from '../src/fabry/architect/components/DeliverableEditor.jsx';

function mount(props) { const root = document.createElement('div'); document.body.appendChild(root); act(() => { render(h(DeliverableEditor, props), root); }); return root; }
function implTab(root) { return [...root.querySelectorAll('.fabry-arch-ctab')].find((t) => /Implement/.test(t.textContent)); }
function implPanel(root) { const btn = root.querySelector('.fabry-arch-implement-hd'); return btn ? btn.closest('.fabry-arch-cpanel') : null; }
beforeEach(() => { vi.clearAllMocks(); store.results.value = {}; store.implement.value = {}; store.implementRunning.value = false; fstore.implementAllowed.value = true; });

describe('Implement panel (kill-switch on) — lives in the [Implement] console tab', () => {
  it('shows a ▷ Implement tab; clicking it un-hides the Implement panel', () => {
    const root = mount({ deliverable: { id: 'a', text: 'Add a VAT rule' } });
    const tab = implTab(root);
    expect(tab).toBeTruthy();
    const panel = implPanel(root);
    expect(panel).toBeTruthy();
    expect(panel.hidden).toBe(true); // Check tab is default-active
    act(() => tab.click());
    expect(panel.hidden).toBe(false);
  });

  it('the Implement ▷ button opens the Arm dialog (count=1); invoking its onConfirm calls reImplement and switches to the Implement tab', () => {
    const root = mount({ deliverable: { id: 'a', text: 'Add a VAT rule' } });
    const panel = implPanel(root);
    expect(panel.hidden).toBe(true); // still on the default Check tab
    const btn = root.querySelector('.fabry-arch-implement-run');
    expect(btn).toBeTruthy();
    act(() => btn.click());
    expect(openArmDialog).toHaveBeenCalledWith(1, expect.any(Function));
    const onConfirm = openArmDialog.mock.calls[0][1];
    act(() => onConfirm());
    expect(actions.reImplement).toHaveBeenCalledWith('a');
    expect(panel.hidden).toBe(false); // onConfirm also switches tabs to Implement
  });

  it('hides the Implement tab and panel entirely when the kill-switch is off', () => {
    fstore.implementAllowed.value = false;
    const root = mount({ deliverable: { id: 'a', text: 'x' } });
    expect(implTab(root)).toBeFalsy();
    expect(implPanel(root)).toBeFalsy();
  });

  it('shows a Stop button (not Implement) while this deliverable is actively planning/running, and Stop calls stopImplement', () => {
    store.implement.value = { a: { status: 'running', writes: [] } };
    store.implementRunning.value = true;
    const root = mount({ deliverable: { id: 'a', text: 'x' } });
    act(() => implTab(root).click());
    expect(root.querySelector('.fabry-arch-implement-run')).toBeFalsy();
    const stop = root.querySelector('.fabry-arch-implement-stop');
    expect(stop).toBeTruthy();
    act(() => stop.click());
    expect(actions.stopImplement).toHaveBeenCalled();
  });

  it('renders the audit log of writes from implement state', () => {
    store.implement.value = { a: { status: 'passing', writes: [{ tool: 'create_rule', argsSummary: 'VAT #7', ok: true }] } };
    const root = mount({ deliverable: { id: 'a', text: 'x' } });
    act(() => implTab(root).click());
    expect(root.textContent).toMatch(/create_rule/);
    expect(root.textContent).toMatch(/VAT #7/);
  });

  it('renders the task list with per-task status classes + origin, and a spinner while the loop is globally running', () => {
    store.implement.value = {
      a: {
        status: 'running',
        tasks: [
          { id: 'k1', text: 'create the VAT rule', status: 'done', origin: 'plan' },
          { id: 'k2', text: 'add the prereq', status: 'doing', origin: 'discovered' },
        ],
        writes: [],
        summary: '',
      },
    };
    store.implementRunning.value = true;
    const root = mount({ deliverable: { id: 'a', text: 'x' } });
    act(() => implTab(root).click());
    const list = root.querySelector('.fabry-arch-tasklist');
    expect(list).toBeTruthy();
    const items = [...root.querySelectorAll('.fabry-arch-task')];
    expect(items.length).toBe(2);
    expect(root.textContent).toMatch(/create the VAT rule/);
    expect(root.textContent).toMatch(/add the prereq/);
    const done = items.find((li) => /create the VAT rule/.test(li.textContent));
    expect(done.className).toMatch(/task-done/);
    const discovered = items.find((li) => /add the prereq/.test(li.textContent));
    expect(discovered.textContent).toMatch(/discovered/);
    expect(root.querySelector('.fabry-arch-spin')).toBeTruthy();
  });

  it('does not show a spinner when the global implementRunning flag is off, even mid-status "running" (e.g. after Stop)', () => {
    store.implement.value = { a: { status: 'running', tasks: [{ id: 'k1', text: 'x', status: 'doing', origin: 'plan' }], writes: [] } };
    store.implementRunning.value = false;
    const root = mount({ deliverable: { id: 'a', text: 'x' } });
    act(() => implTab(root).click());
    expect(root.querySelector('.fabry-arch-spin')).toBeFalsy();
  });

  it('shows "implemented" status text when passing', () => {
    store.implement.value = { a: { status: 'passing', writes: [] } };
    const root = mount({ deliverable: { id: 'a', text: 'x' } });
    act(() => implTab(root).click());
    expect(root.querySelector('.fabry-arch-implement-status').textContent).toMatch(/implemented/);
  });
});

describe('Deliverable console — fixed height + drag-resize', () => {
  it('renders the console at store.consoleHeight (fixed height, so tabs do not jump) + a grip handle', () => {
    store.consoleHeight.value = 260;
    const root = mount({ deliverable: { id: 'a', text: 'x' } });
    expect(root.querySelector('.fabry-arch-console').style.height).toBe('260px');
    expect(root.querySelector('.fabry-arch-console-grip')).toBeTruthy();
  });
  it('dragging the grip up makes the console taller', () => {
    store.consoleHeight.value = 260;
    const root = mount({ deliverable: { id: 'a', text: 'x' } });
    const grip = root.querySelector('.fabry-arch-console-grip');
    act(() => grip.dispatchEvent(new MouseEvent('mousedown', { clientY: 500, bubbles: true })));
    act(() => document.dispatchEvent(new MouseEvent('mousemove', { clientY: 460 }))); // up 40px
    act(() => document.dispatchEvent(new MouseEvent('mouseup', {})));
    expect(store.consoleHeight.value).toBe(300);
    expect(root.querySelector('.fabry-arch-console').style.height).toBe('300px');
  });
  it('clamps the height to CONSOLE_MAX (no unbounded growth)', () => {
    store.consoleHeight.value = 600;
    const root = mount({ deliverable: { id: 'a', text: 'x' } });
    const grip = root.querySelector('.fabry-arch-console-grip');
    act(() => grip.dispatchEvent(new MouseEvent('mousedown', { clientY: 500, bubbles: true })));
    act(() => document.dispatchEvent(new MouseEvent('mousemove', { clientY: 50 }))); // up 450 → clamps
    act(() => document.dispatchEvent(new MouseEvent('mouseup', {})));
    expect(store.consoleHeight.value).toBe(store.CONSOLE_MAX);
  });
});

describe('Verdict color lives in the console footer, not the header', () => {
  it('never tints the header (keeps it neutral); the verdict shows only in the pill + console', () => {
    store.results.value = { a: { verdict: 'fail', evidence: 'x', stale: false } };
    const root = mount({ deliverable: { id: 'a', text: 'x' } });
    expect(root.querySelector('.fabry-arch-phead').className).not.toMatch(/verdict-/);
    // ...but the compact status pill is still shown in the header.
    expect(root.querySelector('.fabry-arch-pill.fail')).toBeTruthy();
  });
  it('tints the action console (footer) by verdict — the main analysis surface', () => {
    store.results.value = { a: { verdict: 'fail', evidence: 'x', stale: false } };
    const root = mount({ deliverable: { id: 'a', text: 'x' } });
    expect(root.querySelector('.fabry-arch-console').className).toMatch(/verdict-fail/);
    store.results.value = { b: { verdict: 'pass', evidence: 'ok', stale: false } };
    const root2 = mount({ deliverable: { id: 'b', text: 'x' } });
    expect(root2.querySelector('.fabry-arch-console').className).toMatch(/verdict-pass/);
  });
  it('has no console verdict tint before a check has run', () => {
    store.results.value = {};
    const root = mount({ deliverable: { id: 'c', text: 'x' } });
    expect(root.querySelector('.fabry-arch-console').className).not.toMatch(/verdict-/);
  });
});
