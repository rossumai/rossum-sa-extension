// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
globalThis.requestAnimationFrame = (cb) => { cb(0); return 0; };
globalThis.cancelAnimationFrame = () => {};
vi.mock('../src/fabry/architect/actions.js', () => ({
  loadArchitect: vi.fn().mockResolvedValue(undefined),
  updateDeliverable: vi.fn(), deleteDeliverable: vi.fn(), reRun: vi.fn(), stopRun: vi.fn(),
  refineTurn: vi.fn(), answerRefine: vi.fn(),
}));
vi.mock('../src/fabry/architect/components/MarkdownEditor.jsx', () => ({
  default: ({ value, onChange }) => h('textarea', { class: 'md-mock', value, onInput: (e) => onChange && onChange(e.currentTarget.value) }),
}));
vi.mock('../src/fabry/chat.js', () => ({ openChat: vi.fn() }));
import * as actions from '../src/fabry/architect/actions.js';
import * as astore from '../src/fabry/architect/store.js';
import * as fstore from '../src/fabry/store.js';
import * as chat from '../src/fabry/chat.js';
import ArchitectApp from '../src/fabry/architect/components/ArchitectApp.jsx';
import { modalContent } from '../src/ui/Modal.jsx';
const flush = () => new Promise((r) => setTimeout(r, 0));
function mount() { const root = document.createElement('div'); document.body.appendChild(root); act(() => { render(h(ArchitectApp, null), root); }); return root; }
beforeEach(() => {
  vi.clearAllMocks();
  astore.deliverables.value = []; astore.results.value = {}; astore.activeId.value = null;
  astore.loaded.value = true; astore.running.value = false; astore.loadError.value = null;
  astore.verdictExpanded.value = false; // shared expand pref — reset for per-test isolation
  fstore.fabryMode.value = 'architect';
  modalContent.value = null;
});

describe('ArchitectApp', () => {
  it('loads on mount and shows a placeholder when nothing is open', async () => {
    const root = mount(); await flush();
    expect(actions.loadArchitect).toHaveBeenCalled();
    expect(root.querySelector('.fabry-arch-placeholder')).toBeTruthy();
  });
  it('shows the source editor and a rendered preview side by side', () => {
    astore.deliverables.value = [{ id: 'a', text: '# Heading A', order: 1 }];
    astore.activeId.value = 'a';
    const root = mount();
    expect(root.querySelector('.fabry-arch-source .md-mock')).toBeTruthy();
    const preview = root.querySelector('.fabry-arch-preview');
    expect(preview).toBeTruthy();
    expect(preview.textContent).toMatch(/Heading A/); // FabryMarkdown renders the source
  });
  it('typing updates the rendered preview live', () => {
    astore.deliverables.value = [{ id: 'a', text: '# A', order: 1 }]; astore.activeId.value = 'a';
    const root = mount();
    act(() => { const ta = root.querySelector('.md-mock'); ta.value = '# Renamed'; ta.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(root.querySelector('.fabry-arch-preview').textContent).toMatch(/Renamed/);
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
  it('shows the verdict banner (V1) at the top, collapsed, with an obvious Show-evidence affordance', () => {
    astore.deliverables.value = [{ id: 'a', text: '# A', order: 1 }]; astore.activeId.value = 'a';
    astore.results.value = { a: { verdict: 'fail', evidence: 'missing hook', chatId: 'c1', ranAt: 1, stale: true } };
    const root = mount();
    const editor = root.querySelector('.fabry-arch-editor');
    const banner = editor.querySelector('.fabry-arch-banner.fail');
    const body = editor.querySelector('.fabry-arch-editor-body');
    expect(banner).toBeTruthy();
    expect(banner.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // banner before the split
    expect(root.querySelector('.fabry-arch-banner-verdict').textContent).toMatch(/not met/i);
    expect(root.querySelector('.fabry-arch-banner-more').textContent).toMatch(/show evidence/i);
    expect(root.querySelector('.fabry-arch-banner-stale').textContent).toMatch(/may be outdated/i); // stale note visible while collapsed
    expect(root.querySelector('.fabry-arch-evidence')).toBeNull(); // collapsed by default
    act(() => { root.querySelector('.fabry-arch-banner-hd').click(); });
    expect(root.querySelector('.fabry-arch-banner-more').textContent).toMatch(/hide/i);
    expect(root.querySelector('.fabry-arch-evidence').textContent).toMatch(/missing hook/);
  });
  it('remembers the expanded verdict: expanding one opens other deliverables expanded by default', () => {
    astore.deliverables.value = [{ id: 'a', text: '# A', order: 1 }, { id: 'b', text: '# B', order: 2 }];
    astore.results.value = {
      a: { verdict: 'fail', evidence: 'missing hook', chatId: 'c1', ranAt: 1, stale: false },
      b: { verdict: 'pass', evidence: 'all good', chatId: 'c2', ranAt: 1, stale: false },
    };
    astore.activeId.value = 'a';
    const root = mount();
    expect(root.querySelector('.fabry-arch-evidence')).toBeNull(); // collapsed by default
    act(() => { root.querySelector('.fabry-arch-banner-hd').click(); }); // expand A
    expect(root.querySelector('.fabry-arch-evidence').textContent).toMatch(/missing hook/);
    // Switch to B: it should open ALREADY expanded (remembered preference).
    act(() => { astore.activeId.value = 'b'; render(h(ArchitectApp, null), root); });
    expect(root.querySelector('.fabry-arch-evidence').textContent).toMatch(/all good/);
  });
  it('shows a Checking banner while a result is running', () => {
    astore.deliverables.value = [{ id: 'a', text: '# A', order: 1 }]; astore.activeId.value = 'a';
    astore.results.value = { a: { running: true } };
    const root = mount();
    expect(root.querySelector('.fabry-arch-banner.running')).toBeTruthy();
  });
  it('view-investigation (in the expanded banner) switches to chat mode + opens the chat', () => {
    astore.deliverables.value = [{ id: 'a', text: '# A', order: 1 }]; astore.activeId.value = 'a';
    astore.results.value = { a: { verdict: 'pass', evidence: 'ok', chatId: 'c1', ranAt: 1, stale: false } };
    const root = mount();
    act(() => { root.querySelector('.fabry-arch-banner-hd').click(); }); // expand to reveal the link
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
  it('the docked refine bar disables its AI input for an empty deliverable', () => {
    astore.deliverables.value = [{ id: 'e', text: '', order: 1 }];
    astore.activeId.value = 'e';
    expect(mount().querySelector('.fabry-arch-dock input').disabled).toBe(true);
  });
  it('the docked refine bar renders inline (no modal) and its AI input is enabled for a deliverable with text', () => {
    astore.deliverables.value = [{ id: 'a', text: '# Original requirement about the queue', order: 1 }];
    astore.activeId.value = 'a';
    const root = mount();
    const input = root.querySelector('.fabry-arch-dock input');
    expect(input).toBeTruthy();
    expect(input.disabled).toBe(false);
    expect(modalContent.value).toBeNull(); // inline, no modal
    expect(actions.refineTurn).not.toHaveBeenCalled(); // nothing runs until an instruction is sent
  });
});
