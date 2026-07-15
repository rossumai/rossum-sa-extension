// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
globalThis.requestAnimationFrame = (cb) => { cb(0); return 0; };
globalThis.cancelAnimationFrame = () => {};
vi.mock('../src/fabry/architect/actions.js', () => ({
  loadArchitect: vi.fn().mockResolvedValue(undefined),
  updateDeliverable: vi.fn(), deleteDeliverable: vi.fn(), reRun: vi.fn(), stopRun: vi.fn(),
  refineTurn: vi.fn(), answerRefine: vi.fn(), renameDeliverable: vi.fn(), reImplement: vi.fn(), stopImplement: vi.fn(),
}));
vi.mock('../src/fabry/architect/components/MarkdownEditor.jsx', () => ({
  default: ({ value, onChange }) => h('textarea', { class: 'md-mock', value, onInput: (e) => onChange && onChange(e.currentTarget.value) }),
}));
vi.mock('../src/fabry/chat.js', () => ({ openChat: vi.fn() }));
// promptModal is spied directly (rename flow) rather than exercised through a
// real mounted Modal — ArmDialog.jsx also imports from this module but its
// exports (openModal/closeModal/…) are never invoked in this file (Implement
// is not clicked here), so leaving them undefined under the mock is safe.
vi.mock('../src/ui/Modal.jsx', () => ({ promptModal: vi.fn() }));
import * as actions from '../src/fabry/architect/actions.js';
import * as astore from '../src/fabry/architect/store.js';
import * as fstore from '../src/fabry/store.js';
import * as chat from '../src/fabry/chat.js';
import { promptModal } from '../src/ui/Modal.jsx';
import ArchitectApp from '../src/fabry/architect/components/ArchitectApp.jsx';
const flush = () => new Promise((r) => setTimeout(r, 0));
function mount() { const root = document.createElement('div'); document.body.appendChild(root); act(() => { render(h(ArchitectApp, null), root); }); return root; }
beforeEach(() => {
  vi.clearAllMocks();
  astore.deliverables.value = []; astore.results.value = {}; astore.activeId.value = null;
  astore.loaded.value = true; astore.running.value = false; astore.loadError.value = null;
  fstore.fabryMode.value = 'architect';
});

describe('ArchitectApp', () => {
  it('loads on mount and shows a placeholder when nothing is open', async () => {
    const root = mount(); await flush();
    expect(actions.loadArchitect).toHaveBeenCalled();
    expect(root.querySelector('.fabry-arch-placeholder')).toBeTruthy();
  });

  it('shows the deliverable title in the header', () => {
    astore.deliverables.value = [{ id: 'a', text: '# Heading A', order: 1 }];
    astore.activeId.value = 'a';
    const root = mount();
    const head = root.querySelector('.fabry-arch-phead');
    expect(head).toBeTruthy();
    expect(head.textContent).toMatch(/Heading A/);
  });

  it('renders Edit + Preview both mounted (Edit visible by default) and typing live-updates the preview', () => {
    astore.deliverables.value = [{ id: 'a', text: '# A', order: 1 }]; astore.activeId.value = 'a';
    const root = mount();
    const source = root.querySelector('.fabry-arch-source');
    const preview = root.querySelector('.fabry-arch-preview');
    expect(source).toBeTruthy();
    expect(preview).toBeTruthy();
    expect(source.hidden).toBe(false);
    expect(preview.hidden).toBe(true); // both mounted, only one shown
    act(() => { const ta = root.querySelector('.md-mock'); ta.value = '# Renamed'; ta.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(preview.textContent).toMatch(/Renamed/); // live even while hidden
  });

  it('the Edit|Preview toggle flips which of the two is hidden (only one shown at a time)', () => {
    astore.deliverables.value = [{ id: 'a', text: '# Heading A', order: 1 }]; astore.activeId.value = 'a';
    const root = mount();
    const source = root.querySelector('.fabry-arch-source');
    const preview = root.querySelector('.fabry-arch-preview');
    const [editBtn, previewBtn] = root.querySelectorAll('.fabry-arch-viewtoggle button');
    act(() => { previewBtn.click(); });
    expect(source.hidden).toBe(true);
    expect(preview.hidden).toBe(false);
    expect(preview.textContent).toMatch(/Heading A/);
    act(() => { editBtn.click(); });
    expect(source.hidden).toBe(false);
    expect(preview.hidden).toBe(true);
  });

  it('editing the markdown calls updateDeliverable (debounced)', async () => {
    vi.useFakeTimers();
    astore.deliverables.value = [{ id: 'a', text: '# A', order: 1 }]; astore.activeId.value = 'a';
    const root = mount();
    const ta = root.querySelector('.md-mock');
    ta.value = '# A edited'; ta.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(700);
    expect(actions.updateDeliverable).toHaveBeenCalledWith('a', '# A edited');
    vi.useRealTimers();
  });

  it('the Check tab is default-active and shows the verdict + evidence with no extra click', () => {
    astore.deliverables.value = [{ id: 'a', text: '# A', order: 1 }]; astore.activeId.value = 'a';
    astore.results.value = { a: { verdict: 'fail', evidence: 'missing hook', chatId: 'c1', ranAt: 1, stale: true } };
    const root = mount();
    const tabs = [...root.querySelectorAll('.fabry-arch-ctab')];
    const checkTab = tabs.find((t) => /^Check/.test(t.textContent));
    expect(checkTab.getAttribute('aria-selected')).toBe('true');
    const refineTab = tabs.find((t) => /Refine/.test(t.textContent));
    expect(refineTab.getAttribute('aria-selected')).toBe('false');
    expect(root.querySelector('.fabry-arch-check-verdict').textContent).toMatch(/not met/i);
    expect(root.querySelector('.fabry-arch-check-stale').textContent).toMatch(/may be outdated/i);
    expect(root.querySelector('.fabry-arch-evidence').textContent).toMatch(/missing hook/); // shown, no expand step
  });

  it('shows a Checking state on the Check tab (and pill) while a result is running', () => {
    astore.deliverables.value = [{ id: 'a', text: '# A', order: 1 }]; astore.activeId.value = 'a';
    astore.results.value = { a: { running: true } };
    const root = mount();
    expect(root.querySelector('.fabry-arch-pill.run').textContent).toMatch(/checking/i);
    expect(root.querySelector('.fabry-arch-check-empty').textContent).toMatch(/checking/i);
  });

  it('the console tabs are all kept mounted (hidden, not unmounted); clicking Refine un-hides its panel', () => {
    astore.deliverables.value = [{ id: 'a', text: '# base requirement', order: 1 }]; astore.activeId.value = 'a';
    const root = mount();
    const dock = root.querySelector('.fabry-arch-dock'); // RefineDock is always mounted (kept alive across tabs)
    expect(dock).toBeTruthy();
    const refinePanel = dock.closest('.fabry-arch-cpanel');
    expect(refinePanel.hidden).toBe(true); // hidden while Check (default) is active
    const refineTab = [...root.querySelectorAll('.fabry-arch-ctab')].find((t) => /Refine/.test(t.textContent));
    act(() => { refineTab.click(); });
    expect(refinePanel.hidden).toBe(false);
  });

  it('clicking the title opens promptModal; submitting the new value calls renameDeliverable', () => {
    astore.deliverables.value = [{ id: 'a', text: '# A', order: 1, title: 'Old title' }]; astore.activeId.value = 'a';
    const root = mount();
    act(() => { root.querySelector('.fabry-arch-titlebtn').click(); });
    expect(promptModal).toHaveBeenCalledTimes(1);
    const [title, opts, onSubmit] = promptModal.mock.calls[0];
    expect(title).toBe('Rename deliverable');
    expect(opts.initialValue).toBe('Old title');
    onSubmit('New title');
    expect(actions.renameDeliverable).toHaveBeenCalledWith('a', 'New title');
  });

  it('View investigation switches to chat mode + opens the chat', () => {
    astore.deliverables.value = [{ id: 'a', text: '# A', order: 1 }]; astore.activeId.value = 'a';
    astore.results.value = { a: { verdict: 'pass', evidence: 'ok', chatId: 'c1', ranAt: 1, stale: false } };
    const root = mount();
    root.querySelector('.fabry-arch-viewchat').click();
    expect(fstore.fabryMode.value).toBe('chat');
    expect(chat.openChat).toHaveBeenCalledWith('c1');
  });

  it('flushes only the edited deliverable on switch; a viewed-only deliverable never stale-writes', async () => {
    // Real timers: the 600ms debounce never elapses within the test's microtask
    // window, so a pending edit stays pending; `flush()` (one macrotask) only lets
    // Preact's deferred effect cleanup (the flush-on-switch) run — no wall-clock race.
    astore.deliverables.value = [
      { id: 'a', text: '# A', order: 1 },
      { id: 'b', text: '# B', order: 2 },
      { id: 'c', text: '# C', order: 3 },
    ];
    astore.activeId.value = 'a';
    const root = mount();
    await flush(); // let the initial effect register its cleanup
    // Edit A — a debounced edit is now pending (timer + latest both set).
    const ta = root.querySelector('.md-mock');
    ta.value = '# A edited'; ta.dispatchEvent(new Event('input', { bubbles: true }));
    // Switch A -> B: DeliverableEditor is NOT remounted (only MarkdownEditor is
    // keyed), so the flush-on-switch cleanup persists A's pending edit.
    astore.activeId.value = 'b';
    render(h(ArchitectApp, null), root);
    await flush();
    expect(actions.updateDeliverable).toHaveBeenCalledWith('a', '# A edited');
    // Switch B -> C WITHOUT editing B: with the timer nulled after the first
    // flush, no spurious stale flush of another deliverable's text occurs.
    actions.updateDeliverable.mockClear();
    astore.activeId.value = 'c';
    render(h(ArchitectApp, null), root);
    await flush();
    expect(actions.updateDeliverable).not.toHaveBeenCalled();
  });
});
