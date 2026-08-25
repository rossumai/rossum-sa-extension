// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
vi.mock('../src/fabry/architect/pdfAction.js', () => ({ openPdfFlow: vi.fn() }));
vi.mock('../src/fabry/architect/components/SourceEditor.jsx', () => ({
  default: ({ text, onChange }: any) => <textarea
    class="cm-mock"
    value={text}
    onInput={(e: Event) => onChange && onChange((e.currentTarget as HTMLTextAreaElement).value)}
  />,
}));

vi.mock('../src/mdh/smoothScroll.js', async (orig) => ({
  ...(await orig()),
  // Navigation jumps go through this tween now (Chrome's smooth scroll was the sluggishness the
  // owner reported). jsdom has no layout, so all rects are 0 and the real tween is a no-op — the
  // observable claim here is that a jump was requested; WHICH element it resolved to is proven by
  // docs-id-namespace's resolveInPage tests and was measured in a browser.
  animateScrollTop: vi.fn(),
}));
import { animateScrollTop } from '../src/mdh/smoothScroll.js';
import { openPdfFlow } from '../src/fabry/architect/pdfAction.js';
import * as store from '../src/fabry/architect/store.js';
import SpecView from '../src/fabry/architect/components/SpecView.jsx';
import { deliverable } from './support/architect.js';

const D = [
  // Deliberately carries the retired state fields: the assertion is that they are ignored.
  { ...deliverable({ id: 'd1', text: '# One\n\nalpha\n', order: 1, title: '', titleSource: '' }),
    state: 'verified', stateDate: '2026-08-12' } as any,
  deliverable({ id: 'd2', text: '# Two\n\nbeta\n', order: 2, title: '', titleSource: '' }),
];
// Unmounted between tests, not just detached: a SpecView left mounted keeps subscribing to the shared
// signals and re-renders into orphaned DOM, which made a later test read a stale tree.
let mounted: any = [];
function mount() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  act(() => { render(<SpecView />, root); });
  mounted.push(root);
  return root;
}
afterEach(() => {
  for (const root of mounted) act(() => { render(null, root); });
  mounted = [];
});
beforeEach(() => {
  // Without this, `openPdfFlow.mock.calls[0]` reads the PREVIOUS test's call — whose callbacks belong
  // to a component that has since been unmounted, so invoking them does nothing and the assertion
  // fails for a reason that has nothing to do with the code under test.
  vi.clearAllMocks();
  document.body.innerHTML = '';
  store.deliverables.value = D;
  store.results.value = { d1: { verdict: 'pass', evidence: 'ok', stale: false, chatId: null } };
  store.docView.value = 'preview';
  store.railOpen.value = true;
  store.pinnedTarget.value = null; store.spyTarget.value = null;
  store.setReviewTarget(null);
});

describe('SpecView', () => {
  it('offers a two-way mode switch and no combined mode', () => {
    const labels = [...mount().querySelectorAll('.fabry-spec-modes button')].map((b) => b.textContent);
    expect(labels.length).toBe(2);
    expect(labels.join(' ')).toMatch(/Edit/);
    expect(labels.join(' ')).toMatch(/Preview/);
    expect(labels.join(' ')).not.toMatch(/Editor and Preview/);
  });

  it('switching mode changes the mode and keeps the chrome', () => {
    const root = mount();
    const before = root.querySelectorAll('.fabry-spec-sec-hd').length;
    act(() => { ([...root.querySelectorAll('.fabry-spec-modes button')].find((b) => /Edit/.test(b.textContent)) as HTMLElement).click(); });
    expect(store.docView.value).toBe('edit');
    expect(root.querySelectorAll('.fabry-spec-sec-hd').length).toBe(before);
  });

  it('renders a header per deliverable carrying identity and status only — no action buttons', async () => {
    const root = mount();
    await vi.waitFor(() => expect(root.querySelectorAll('.fabry-spec-sec-hd').length).toBe(2));
    const hd = root.querySelector('.fabry-spec-sec-hd')!;
    expect(hd.querySelectorAll('button').length).toBe(0);
    expect(hd.textContent).toMatch(/One/);
    // ONE badge: the check verdict. The manual state pill was dropped on 2026-08-19.
    expect(hd.querySelectorAll('.fabry-spec-pill').length).toBe(1);
    expect(hd.textContent).toMatch(/Met/);
    expect(hd.textContent).not.toMatch(/Verified/);
  });

  it('clicking a section header targets that deliverable, and moves an existing pin', () => {
    const root = mount();
    act(() => { root.querySelectorAll<HTMLElement>('.fabry-spec-sec-hd')[1].click(); });
    expect(store.spyTarget.value).toBe('d2');
    expect(store.pinnedTarget.value).toBe(null);          // no pin was set, so none is created
    act(() => { store.setPinnedTarget('d2'); root.querySelectorAll<HTMLElement>('.fabry-spec-sec-hd')[0].click(); });
    expect(store.pinnedTarget.value).toBe('d1');          // an existing pin follows the click
  });

  it('collapses the inspector, and offers NO way to collapse the deliverable list', () => {
    // Owner, 2026-08-19: the list is the navigation, and navigation that can disappear is a trap.
    const root = mount();
    expect(root.querySelector('[data-act="toggle-toc"]')).toBe(null);
    act(() => { root.querySelector<HTMLElement>('[data-act="toggle-rail"]')!.click(); });
    expect(store.railOpen.value).toBe(false);
  });

  it('registers a navigator that jumps through the fast tween, not the browser slow one', async () => {
    const root = mount();
    await vi.waitFor(() => expect(root.querySelectorAll('h1[id]').length).toBe(2));
    vi.mocked(animateScrollTop).mockClear();
    act(() => { store.navigateOutline('two', 'd2'); });
    expect(animateScrollTop).toHaveBeenCalledTimes(1);
    // and the scroller it was handed is the document's own, not the window
    expect(vi.mocked(animateScrollTop).mock.calls[0][0]).toBe(root.querySelector('.docs-root'));
    act(() => { store.navigateOutline(null, 'd1'); });   // a row click: the section itself
    expect(animateScrollTop).toHaveBeenCalledTimes(2);
  });

  it('renders every deliverable in edit mode as an editable field, with the same headers', () => {
    store.docView.value = 'edit';
    const root = mount();
    expect(root.querySelectorAll('.cm-mock').length).toBe(2);
    expect(root.querySelectorAll('.fabry-spec-sec-hd').length).toBe(2);
    // an editor holds its text as a value, not as child text
    expect([...root.querySelectorAll('.cm-mock')].map((t) => (t as HTMLInputElement).value).join(' ')).toMatch(/alpha/);
    expect([...root.querySelectorAll('.cm-mock')].map((t) => (t as HTMLInputElement).value).join(' ')).toMatch(/beta/);
  });
});

describe('the document bar owns Download PDF', () => {
  // It used to live in the deliverable pane and was LOST when the unified view replaced that pane
  // (owner report, 2026-08-19) — nothing called openPdfDialog any more.
  it('offers a PDF button that runs the flow for the deliverable being read', () => {
    store.settledTarget.value = 'd2';
    const root = mount();
    const btn = root.querySelector<HTMLElement>('[data-act="pdf"]')!;
    expect(btn).toBeTruthy();
    expect(btn.textContent).toMatch(/PDF/);
    act(() => { btn.click(); });
    expect(openPdfFlow).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openPdfFlow).mock.calls[0][0]!.id).toBe('d2');     // scope "this deliverable" means this one
  });

  it('reports its outcome in the bar, and the note can be dismissed', () => {
    const root = mount();
    act(() => { root.querySelector<HTMLElement>('[data-act="pdf"]')!.click(); });
    const { onNote } = vi.mocked(openPdfFlow).mock.calls[0][1] as any;
    act(() => { onNote('print view opened'); });
    expect(root.querySelector('.fabry-arch-doc-note')!.textContent).toMatch(/print view opened/);
    act(() => { root.querySelector<HTMLElement>('.fabry-arch-doc-warn-x')!.click(); });
    expect(root.querySelector('.fabry-arch-doc-note')).toBe(null);
  });
});

describe('review at document width', () => {
  // This path was UNTESTED and shipped broken: the host component was referenced from headerFor and
  // never defined, so opening a diff at document width threw `ReviewHost is not defined` — as an
  // unhandled rejection inside Preact's async render, which took the whole view down with no console
  // error in the page. A test that merely mounts SpecView cannot catch it; the target has to be set.
  it('renders the requested panel above its own section, and closes', () => {
    store.docView.value = 'edit';        // the mode whose headers Preact re-renders on a signal change
    const root = mount();
    expect(root.querySelector('.fabry-spec-review')).toBe(null);

    act(() => { store.setReviewTarget({ id: 'd2', kind: 'history' }); });
    const host = root.querySelector('.fabry-spec-review')!;
    expect(host).not.toBe(null);
    expect(host.querySelector('.fabry-spec-review-t')!.textContent).toMatch(/Version history/);
    // Above ITS OWN section, not the first one.
    expect(host.closest<HTMLElement>('[data-deliverable]')!.dataset.deliverable).toBe('d2');

    act(() => { host.querySelector<HTMLElement>('[data-act="review-close"]')!.click(); });
    expect(root.querySelector('.fabry-spec-review')).toBe(null);
  });

  it('shows Refine for the refine kind', () => {
    store.docView.value = 'edit';
    const root = mount();
    act(() => { store.setReviewTarget({ id: 'd1', kind: 'refine' }); });
    expect(root.querySelector('.fabry-spec-review-t')!.textContent).toMatch(/Refine/);
  });

  it('closes on Escape', () => {
    store.docView.value = 'edit';
    const root = mount();
    act(() => { store.setReviewTarget({ id: 'd1', kind: 'history' }); });
    expect(root.querySelector('.fabry-spec-review')).not.toBe(null);
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(root.querySelector('.fabry-spec-review')).toBe(null);
  });
});
